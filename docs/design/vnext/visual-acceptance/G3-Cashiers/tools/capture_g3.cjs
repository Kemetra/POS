// Capture every G-3 reference (light + forced colours) and run fit + axe checks.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
// Needs playwright-core and an installed Chromium. Point PLAYWRIGHT_CORE at a playwright-core
// folder if it is not resolvable from here. Usage: node capture_g3.cjs <G3 folder> [axe.min.js]
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

if (!process.argv[2]) {
  console.error('usage: node capture_g3.cjs <G3-Cashiers folder> [axe.min.js]');
  process.exit(2);
}
const dir = path.resolve(process.argv[2]);
const outDir = path.join(dir, 'captures');
const axePath = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const files = fs.readdirSync(dir).filter((f) => /^G3-.*-(1024|1280)\.html$/.test(f)).sort();
  const report = [];
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
          for (const sel of ['.panel', '.panel-head', '.dialog', '.notice', '.nav', '.operator']) {
            document.querySelectorAll(sel).forEach((n) => {
              const r = n.getBoundingClientRect();
              if (r.bottom > rt.bottom + 0.5 || r.top < rt.top - 0.5 || r.left < rt.left - 0.5 || r.right > rt.right + 0.5)
                out.push(`${sel} outside frame`);
            });
          }
          // Every row's actions and status stay inside the row (no horizontal spill).
          const spill = [...document.querySelectorAll('.row')].filter((r) => r.scrollWidth > r.clientWidth + 1).length;
          const list = document.querySelector('.rows');
          const scroll = list ? list.scrollHeight > list.clientHeight : false;
          const small = [...document.querySelectorAll('.rt *')].filter((n) => {
            if (!n.childNodes.length || ![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
            return parseFloat(getComputedStyle(n).fontSize) < 12;
          }).length;
          const targets = [...document.querySelectorAll('.rt button, .rt input, .rt a')].filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && (r.height < 44 || r.width < 44);
          }).length;
          // A name that wraps is information; a name that is cut is a failure.
          const names = [...document.querySelectorAll('.name')];
          const wrapped = names.filter((n) => n.clientHeight > parseFloat(getComputedStyle(n).lineHeight) * 1.5).length;
          // Cut either way: a clamp (vertical) or an ellipsis (sideways).
          const clipped = names.filter(
            (n) => n.scrollHeight > n.clientHeight + 3 || n.scrollWidth > n.clientWidth + 1,
          ).length;
          // Behind a dialog, nothing outside it may take focus, and the dialog itself must not be inert.
          const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
          const focusable =
            'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable]';
          // Reachable by Tab: not inert, not disabled, not tabindex -1, and rendered and visible.
          const live = (n) =>
            !n.closest('[inert]') &&
            !n.disabled &&
            n.tabIndex >= 0 &&
            n.getClientRects().length > 0 &&
            getComputedStyle(n).visibility !== 'hidden';
          const all = [...document.querySelectorAll('.rt')].flatMap((rt) => [...rt.querySelectorAll(focusable)]);
          const leaks = dialog ? all.filter((n) => !dialog.contains(n) && live(n)).length : 0;
          const deadDialog = dialog ? !!dialog.closest('[inert]') || !all.some((n) => dialog.contains(n) && live(n)) : false;
          return { out, spill, scroll, small, targets, wrapped, clipped, leaks, deadDialog };
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
        // `scroll` and `wrapped` are information; everything else is a failed check.
        const failed = [];
        if (fit.out.length) failed.push(...fit.out);
        if (fit.spill) failed.push(`${fit.spill} row(s) spill horizontally`);
        if (fit.small) failed.push(`${fit.small} text node(s) below 12px`);
        if (fit.targets) failed.push(`${fit.targets} control(s) below 44x44`);
        if (fit.clipped) failed.push(`${fit.clipped} name(s) clipped`);
        if (fit.leaks) failed.push(`${fit.leaks} control(s) focusable behind the dialog`);
        if (fit.deadDialog) failed.push('the dialog itself is inert or has no reachable control');
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
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
