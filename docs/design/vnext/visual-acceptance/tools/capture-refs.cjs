// Shared capture + check for the G-x visual-acceptance reference packs (G-3, G-6).
// Each pack keeps a thin tools/capture_gN.cjs that calls captureRefs() with its own prefix and
// frame selectors. No path is read from the command line: the pack folder comes from the caller's
// own location. Needs playwright-core and axe-core from the repo's node_modules, and an installed
// Chromium. When playwright-core is not resolvable from the repo's
// node_modules, set the PLAYWRIGHT_CORE environment variable to a playwright-core folder.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const AXE_PATH = require.resolve('axe-core/axe.min.js', { paths: [__dirname] });
const SIZES = { 1024: 768, 1280: 800 };

/** Runs in the page: fit, type and target floors, clipped names, focus behind a dialog. */
function pageChecks(selectors) {
  const rt = document.querySelector('.rt').getBoundingClientRect();
  const out = [];
  for (const sel of selectors) {
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
  // A radio's target is its whole label row, so measure the label.
  const targets = [...document.querySelectorAll('.rt button, .rt input, .rt a')].filter((n) => {
    const box = n.type === 'radio' && n.closest('label') ? n.closest('label') : n;
    const r = box.getBoundingClientRect();
    return r.width > 0 && (r.height < 44 || r.width < 44);
  }).length;
  // A name that wraps is information; a name that is cut (clamp or ellipsis) is a failure.
  const names = [...document.querySelectorAll('.name')];
  const wrapped = names.filter((n) => n.clientHeight > parseFloat(getComputedStyle(n).lineHeight) * 1.5).length;
  const clipped = names.filter((n) => n.scrollHeight > n.clientHeight + 3 || n.scrollWidth > n.clientWidth + 1).length;
  // Behind a dialog, nothing outside it may take focus, and the dialog itself must not be inert.
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
  const focusable = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable]';
  const live = (n) =>
    !n.closest('[inert]') && !n.disabled && n.tabIndex >= 0 && n.getClientRects().length > 0 &&
    getComputedStyle(n).visibility !== 'hidden';
  const all = [...document.querySelectorAll('.rt')].flatMap((el) => [...el.querySelectorAll(focusable)]);
  const leaks = dialog ? all.filter((n) => !dialog.contains(n) && live(n)).length : 0;
  const deadDialog = dialog ? !!dialog.closest('[inert]') || !all.some((n) => dialog.contains(n) && live(n)) : false;
  return { out, spill, scroll, small, targets, wrapped, clipped, leaks, deadDialog };
}

async function runAxe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('.rt'));
    return r.violations.map((v) => `${v.id}(${v.nodes.length})`);
  });
}

/** `scroll` and `wrapped` are information; everything else is a failed check. */
function failuresOf(fit, axe) {
  const failed = [...fit.out];
  if (fit.spill) failed.push(`${fit.spill} row(s) spill horizontally`);
  if (fit.small) failed.push(`${fit.small} text node(s) below 12px`);
  if (fit.targets) failed.push(`${fit.targets} control(s) below 44x44`);
  if (fit.clipped) failed.push(`${fit.clipped} name(s) clipped`);
  if (fit.leaks) failed.push(`${fit.leaks} control(s) focusable behind the dialog`);
  if (fit.deadDialog) failed.push('the dialog itself is inert or has no reachable control');
  if (axe.length) failed.push(`axe: ${axe.join(', ')}`);
  return failed;
}

/** Screenshots one reference in one mode; in light mode also returns its check result. */
async function captureOne(browser, file, mode, opts) {
  const w = file.includes('-1024') ? 1024 : 1280;
  const ctx = await browser.newContext({ viewport: { width: w + 48, height: SIZES[w] + 48 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(pathToFileURL(path.join(opts.packDir, file)).href);
    const el = await page.$('.rt');
    await el.screenshot({ path: path.join(opts.packDir, 'captures', file.replace('.html', `-${mode}.png`)) });
    if (mode !== 'light') return null;
    const fit = await page.evaluate(pageChecks, opts.selectors);
    const axe = await runAxe(page);
    return { line: `${file}: ${JSON.stringify({ ...fit, axe })}`, failed: failuresOf(fit, axe) };
  } finally {
    await ctx.close();
  }
}

/**
 * Captures every `<prefix>-*-(1024|1280).html` in packDir (light + forced colours) into
 * packDir/captures and prints one check line per file, then a [FAIL] line per failing file.
 */
async function captureRefs({ packDir, prefix, selectors }) {
  fs.mkdirSync(path.join(packDir, 'captures'), { recursive: true });
  const pattern = new RegExp(`^${prefix}-.*-(1024|1280)\\.html$`);
  const files = fs.readdirSync(packDir).filter((f) => pattern.test(f)).sort();
  const browser = await chromium.launch();
  const report = [];
  const failures = [];
  try {
    for (const file of files) {
      for (const mode of ['light', 'forced']) {
        const result = await captureOne(browser, file, mode, { packDir, selectors });
        if (result === null) continue;
        report.push(result.line);
        if (result.failed.length) failures.push(`${file}: ${result.failed.join('; ')}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(report.join('\n'));
  for (const line of failures) console.log(`[FAIL] ${line}`);
  if (failures.length) process.exitCode = 1;
}

module.exports = { captureRefs };
