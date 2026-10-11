// Capture every G-1 reference (light + forced colours) and run fit + axe checks.
const path = require('path');
const fs = require('fs');
// Needs playwright-core and an installed Chromium. Point PLAYWRIGHT_CORE at a playwright-core
// folder if it is not resolvable from here. Usage: node capture_g1.cjs <G1 folder> [axe.min.js]
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const dir = path.resolve(process.argv[2]);
const outDir = path.join(dir, 'captures');
const axePath = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const files = fs.readdirSync(dir).filter((f) => /^G1-.*-(1024|1280)\.html$/.test(f)).sort();
  const report = [];
  const tops = {};
  for (const f of files) {
    const w = f.includes('-1024') ? 1024 : 1280;
    const h = w === 1024 ? 768 : 800;
    for (const mode of ['light', 'forced']) {
      const ctx = await browser.newContext({ viewport: { width: w + 48, height: h + 48 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
      await page.goto('file:///' + path.join(dir, f).replace(/\\/g, '/'));
      const el = await page.$('.rt');
      await el.screenshot({ path: path.join(outDir, f.replace('.html', `-${mode}.png`)) });
      if (mode === 'light') {
        const fit = await page.evaluate(() => {
          const rt = document.querySelector('.rt').getBoundingClientRect();
          const out = [];
          for (const sel of ['.auth', '.commit', '.keypad', '.dialog', '.card', '.panel-foot']) {
            document.querySelectorAll(sel).forEach((n) => {
              const r = n.getBoundingClientRect();
              if (r.bottom > rt.bottom + 0.5 || r.top < rt.top - 0.5 || r.left < rt.left - 0.5 || r.right > rt.right + 0.5)
                out.push(`${sel} outside frame`);
            });
          }
          const kp = document.querySelector('.keypad');
          const keypadTop = kp ? Math.round(kp.getBoundingClientRect().top - rt.top) : null;
          const roster = document.querySelector('.roster');
          const scroll = roster ? roster.scrollHeight > roster.clientHeight : false;
          const small = [...document.querySelectorAll('.rt *')].filter((n) => {
            if (!n.childNodes.length || ![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
            return parseFloat(getComputedStyle(n).fontSize) < 12;
          }).length;
          const targets = [...document.querySelectorAll('.rt button:not(.key-blank), .rt input, .rt a')].filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && (r.height < 44 || r.width < 44);
          }).length;
          const clipped = [...document.querySelectorAll('.who-name, .auth-who h2')].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
          return { out, scroll, small, targets, clipped, keypadTop };
        });
        let axe = null;
        if (axePath) {
          await page.addScriptTag({ path: axePath });
          axe = await page.evaluate(async () => {
            const r = await window.axe.run(document.querySelector('.rt'));
            return r.violations.map((v) => `${v.id}(${v.nodes.length})`);
          });
        }
        report.push(`${f}: ${JSON.stringify({ ...fit, axe })}`);
        if (fit.keypadTop !== null) (tops[w] = tops[w] || new Set()).add(fit.keypadTop);
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(report.join('\n'));
  for (const [w, set] of Object.entries(tops)) {
    console.log(`keypad top @${w}: ${[...set].join(', ')} ${set.size === 1 ? '[OK] identical' : '[FAIL] moves'}`);
    if (set.size !== 1) process.exitCode = 1;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
