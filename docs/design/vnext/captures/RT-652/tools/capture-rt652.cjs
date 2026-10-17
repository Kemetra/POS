// RT-652 — capture the re-auth-required notice on the stuck-shifts page from the DEV one-frame
// harness (#/dev/one-frame-proof?path=/app/manager/stuck-shifts&list=reauth) at 1280×800, light,
// and measure the «تسجيل الدخول» button and run axe on the document.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-652/tools/capture-rt652.cjs <outDir> <label> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, label, base = 'http://localhost:5173'] = process.argv.slice(2);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true, timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/dev/one-frame-proof?path=/app/manager/stuck-shifts&list=reauth`);
  await page.waitForSelector('[data-testid="reauth-required"]');
  await page.waitForTimeout(500);
  const button = await page.$eval('[data-testid="reauth-required"] button', (b) => {
    const r = b.getBoundingClientRect();
    return { className: b.className, text: b.textContent.trim(), width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.addScriptTag({ path: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document)).violations.map((v) => v.id));
  const file = `rt652-reauth-notice-${label}-1280x800.png`;
  await page.screenshot({ path: path.join(outDir, file) });
  const entry = { label, file, button, axe, errors };
  console.log(JSON.stringify(entry, null, 2));
  const logPath = path.join(outDir, 'rt652-capture-log.json');
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
  fs.writeFileSync(logPath, JSON.stringify([...log.filter((e) => e.label !== label), entry], null, 2) + '\n');
  await browser.close();
})();
