// RT-659 — capture the receipt preview dialog from the DEV harness (#/dev/one-frame-proof) on
// /app/sales, at 1024×768 and 1280×800, light and forced-colors, and run axe plus the dialog
// checks on each: one modal dialog, «إغلاق» its only control and focused, no 008 leftovers, the
// dialog inside the viewport, no text under 12px, no horizontal overflow, no page error.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-659/tools/capture-rt659.cjs <outDir> [baseUrl]
// Browser: PLAYWRIGHT_CORE (module path) and CHROMIUM_PATH (executable) override the cloud-session
// defaults below; the repo declares no Playwright dependency, so point them at a local install.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SIZES = { 1024: 768, 1280: 800 };
const NUMBER = 'TERM-01-2026-10-15-000042';
// [capture name, harness `preview` value, what the well must show]
const CASES = [
  ['Ready', 'ok', '[role=region][aria-label="الإيصال"]'],
  ['Loading', 'pending', '[role=status]'],
  ['Failed', 'fail', '.v5-notice'],
];

/** Opens the found sale's preview through the real lookup, keyboard and mouse as a manager would. */
async function openPreview(page, preview, wellSelector) {
  await page.goto(`${base}/#/dev/one-frame-proof?path=/app/sales&sale=found&preview=${preview}`);
  const field = page.getByRole('textbox', { name: 'رقم البيع' });
  await field.fill(NUMBER);
  await field.press('Enter');
  await page.getByRole('button', { name: 'معاينة الإيصال' }).click();
  await page.waitForSelector(`[role=dialog] ${wellSelector}`);
  await page.evaluate(() => document.fonts.ready);
  // The dialog fades in from 0.6 opacity over 220 ms: capture the settled frame.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

function checks() {
  const dialogs = [...document.querySelectorAll('[role=dialog]')];
  const d = dialogs[0];
  const r = d.getBoundingClientRect();
  const buttons = [...d.querySelectorAll('button')].map((b) => b.textContent.trim());
  const small = [...d.querySelectorAll('*')].filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    return el.getBoundingClientRect().width > 1 && parseFloat(getComputedStyle(el).fontSize) < 12;
  }).length;
  // Inline styles outside the engine's slip HTML (the slip keeps its own bands' alignment).
  const inlineStyles = [...d.querySelectorAll('[style]')].filter((el) => !el.closest('.v5-receipt-slip')).length;
  const well = d.querySelector('.v5-receipt-well');
  return {
    dialogs: dialogs.length,
    modal: d.getAttribute('aria-modal'),
    dialogName: d.getAttribute('aria-label'),
    description: document.getElementById(d.getAttribute('aria-describedby'))?.textContent.trim() ?? null,
    buttons,
    focused: document.activeElement?.textContent.trim() ?? null,
    legacy: !!document.querySelector('[data-testid=receipt-preview]'),
    inlineStyles,
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5,
    dialog: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    wellScrolls: well ? well.scrollHeight > well.clientHeight : false,
    small,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}

function failuresOf(c, axe, errors) {
  const f = [];
  if (c.dialogs !== 1 || c.modal !== 'true' || c.dialogName !== 'معاينة الإيصال') f.push('dialog');
  if (c.description !== NUMBER) f.push('description');
  if (JSON.stringify(c.buttons) !== JSON.stringify(['إغلاق']) || c.focused !== 'إغلاق') f.push('controls');
  if (c.legacy || c.inlineStyles > 0) f.push('legacy');
  if (!c.inViewport || c.small > 0 || c.overflowX) f.push('fit');
  if (axe.length > 0) f.push(`axe ${axe.join(',')}`);
  if (errors.length > 0) f.push('page errors');
  return f;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  const failures = [];
  for (const [name, preview, well] of CASES) {
    for (const [w, h] of Object.entries(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await openPreview(page, preview, well);
        const file = `rt659-${name}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        let axe = [];
        if (mode === 'light') {
          await page.addScriptTag({ path: AXE });
          axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
            .violations.map((v) => `${v.id}(${v.nodes.length})`));
        }
        const c = await page.evaluate(checks);
        const failed = failuresOf(c, axe, errors);
        log.push({ name, preview, width: +w, mode, file, axe, ...c, errors, ok: failed.length === 0 });
        if (failed.length > 0) failures.push(`${file}: ${failed.join('; ')}`);
        console.log(name, w, mode, failed.length ? `FAIL ${failed.join('; ')}` : 'ok', JSON.stringify(c.dialog));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt659-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):\n${failures.join('\n')}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
