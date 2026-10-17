// RT-670 — capture the frame's void attention banner from the DEV void harness
// (#/dev/void-proof?state=RefServer&from=dashboard) at 1024×768 and 1280×800, light, measure the
// banner and its «v5-live-btn» link, and run axe on the document.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-670/tools/capture-rt670.cjs <outDir> <label> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
const BANNER = '[data-testid="void-attention-banner"]';

function box(el) {
  const r = el.getBoundingClientRect();
  return { width: Math.round(r.width), height: Math.round(r.height) };
}

async function captureAt(browser, viewport) {
  const ctx = await browser.newContext({ viewport, bypassCSP: true, timezoneId: 'Africa/Cairo', colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/dev/void-proof?state=RefServer&from=dashboard`);
  await page.waitForSelector(BANNER);
  await page.waitForTimeout(500);
  const banner = await page.$eval(BANNER, box);
  const link = await page.$eval(`${BANNER} a`, (a) => {
    const r = a.getBoundingClientRect();
    return { className: a.className, text: a.textContent.trim(), display: getComputedStyle(a).display, width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.addScriptTag({ path: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document)).violations.map((v) => v.id));
  const size = `${viewport.width}x${viewport.height}`;
  const file = `rt670-void-banner-${label}-${size}.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  await ctx.close();
  return { label, viewport: size, file, banner, link, axe, errors };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const entries = [];
  for (const viewport of VIEWPORTS) entries.push(await captureAt(browser, viewport));
  await browser.close();
  console.log(JSON.stringify(entries, null, 2));
  const logPath = path.join(outDir, 'rt670-capture-log.json');
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
  fs.writeFileSync(logPath, JSON.stringify([...log.filter((e) => e.label !== label), ...entries], null, 2) + '\n');
})();
