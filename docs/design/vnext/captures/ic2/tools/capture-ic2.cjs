// RT-695 (doc 25 IC-2) — capture the surfaces whose glyphs move onto the semantic icon registry,
// from the DEV harnesses, at 1024×768 and 1280×800, light and forced-colors, and run axe on each.
// Run it once on `main` (label `before`) and once on the IC-2 branch (label `after`), then
// `pair-ic2.cjs` lays each before/after pair side by side.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/ic2/tools/capture-ic2.cjs <rawDir> <before|after> [baseUrl]
// Browser: PLAYWRIGHT_CORE (module path) and CHROMIUM_PATH (executable) override the cloud-session
// defaults below; the repo declares no Playwright dependency.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SIZES = { 1024: 768, 1280: 800 };
// [case, harness hash, selector to wait for, optional selector to click first]
const CASES = [
  ['nav-panel-manager-home', '#/dev/one-frame-proof?path=/app/dashboard&shift=on', '.v5-manager-home, main'],
  ['nav-rail-sale', '#/dev/one-frame-proof?path=/app/cart', 'main'],
  ['checkout-tenders', '#/dev/checkout-proof?preset=none', 'main, body'],
  ['checkout-tenders-cash-selected', '#/dev/checkout-proof?preset=none', 'main, body', '[role=radio][aria-label="نقدي"]'],
  ['banner-printer', '#/dev/status-proof?state=PrinterFailed&path=/app/dashboard', '[data-testid=printer-failure-banner]'],
  ['banner-stack', '#/dev/status-proof?state=OfflineAttention&banner=printer&closed=shift&path=/app/dashboard', '[data-testid=printer-failure-banner]'],
  ['entry-sign-in', '#/dev/sign-in-proof?screen=sign-in', 'body'],
  ['entry-ready', '#/dev/sign-in-proof?screen=ready', 'body'],
  ['entry-pairing', '#/dev/sign-in-proof?screen=pairing', 'body'],
  ['entry-locked', '#/dev/sign-in-proof?screen=locked', 'body'],
];

async function captureOne(browser, [name, hash, waitFor, click], width, forced) {
  const viewport = { width: Number(width), height: SIZES[width] };
  const ctx = await browser.newContext({
    viewport, bypassCSP: true, timezoneId: 'Africa/Cairo', colorScheme: 'light',
    forcedColors: forced ? 'active' : 'none',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector(waitFor, { timeout: 15000 });
  if (click) await page.click(click);
  await page.waitForTimeout(900);
  const glyphs = await page.evaluate(() => ({
    registry: document.querySelectorAll('svg.rt-icon').length,
    legacy: document.querySelectorAll('svg.v5-icon').length,
    brand: document.querySelectorAll('svg.v5-brand-cross').length,
  }));
  await page.addScriptTag({ path: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document)).violations.map((v) => v.id));
  const file = `${label}-${name}-${width}x${SIZES[width]}${forced ? '-forced' : ''}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  await ctx.close();
  return { label, case: name, hash, viewport: `${width}x${SIZES[width]}`, forced, file, glyphs, axe, errors };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const entries = [];
  try {
    for (const c of CASES)
      for (const width of Object.keys(SIZES))
        for (const forced of [false, true]) entries.push(await captureOne(browser, c, width, forced));
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, `${label}-log.json`), JSON.stringify(entries, null, 2) + '\n');
  for (const e of entries) console.log(e.file, JSON.stringify(e.glyphs), e.axe.join(',') || 'axe:0', e.errors.join('|'));
})();
