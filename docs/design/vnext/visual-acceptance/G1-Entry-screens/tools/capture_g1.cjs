// Capture every G-1 reference (light + forced colours) and run fit + axe checks.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
// Needs playwright-core and an installed Chromium. Point PLAYWRIGHT_CORE at a playwright-core
// folder if it is not resolvable from here. Usage: node capture_g1.cjs <G1 folder> [axe.min.js]
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

if (!process.argv[2]) {
  console.error('usage: node capture_g1.cjs <G1-Entry-screens folder> [axe.min.js]');
  process.exit(2);
}
const dir = path.resolve(process.argv[2]);
const outDir = path.join(dir, 'captures');
const axePath = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const files = fs.readdirSync(dir).filter((f) => /^G1-.*-(1024|1280)\.html$/.test(f)).sort();
  const report = [];
  const tops = {};
  const failures = [];
  for (const f of files) {
    const w = f.includes('-1024') ? 1024 : 1280;
    const h = w === 1024 ? 768 : 800;
    for (const mode of ['light', 'forced']) {
      const ctx = await browser.newContext({ viewport: { width: w + 48, height: h + 48 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
      await page.goto(pathToFileURL(path.join(dir, f)).href);
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
          // The header name is one line (overflow is a failure); roster names wrap to two lines,
          // then clamp, so they are counted separately (vertical, not horizontal, overflow).
          const clipped = [...document.querySelectorAll('.auth-who h2')].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
          const names = [...document.querySelectorAll('.who-name')];
          const wrapped = names.filter((n) => n.clientHeight > parseFloat(getComputedStyle(n).lineHeight) * 1.5).length;
          const clamped = names.filter((n) => n.scrollHeight > n.clientHeight + 3).length;
          return { out, scroll, small, targets, clipped, wrapped, clamped, keypadTop };
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
        // `wrapped` and `scroll` are information; everything else is a failed check.
        const failed = [];
        if (fit.out.length) failed.push(...fit.out);
        if (fit.small) failed.push(`${fit.small} text node(s) below 12px`);
        if (fit.targets) failed.push(`${fit.targets} control(s) below 44x44`);
        if (fit.clipped) failed.push(`${fit.clipped} header name(s) cut off`);
        if (fit.clamped) failed.push(`${fit.clamped} roster name(s) clamped`);
        if (axe && axe.length) failed.push(`axe: ${axe.join(', ')}`);
        if (failed.length) {
          failures.push(`${f}: ${failed.join('; ')}`);
          process.exitCode = 1;
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(report.join('\n'));
  for (const line of failures) console.log(`[FAIL] ${line}`);
  for (const [w, set] of Object.entries(tops)) {
    console.log(`keypad top @${w}: ${[...set].join(', ')} ${set.size === 1 ? '[OK] identical' : '[FAIL] moves'}`);
    if (set.size !== 1) process.exitCode = 1;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
