// RT-604 — keyboard-only pass over the frame with the status indicator, no mouse after load.
// The indicator adds no control: Tab must pass from the nav links to sign-out with no stop inside
// it, and every row must stay readable to assistive tech (panel and slim rail).
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-604/tools/walk-rt604.cjs <outFile> [baseUrl]
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [outFile, base = 'http://localhost:5173'] = process.argv.slice(2);

async function walk(browser, state, route) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/dev/status-proof?state=${state}&path=${route}`);
  await page.waitForSelector('[data-testid=v5-status-indicator]');
  await page.waitForTimeout(1200);
  const stops = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const a = document.activeElement;
      return {
        text: (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 30),
        inIndicator: !!a.closest('[data-testid=v5-status-indicator]'),
        inNav: !!a.closest('nav'),
      };
    });
    stops.push(s);
    if (s.text === 'تسجيل الخروج') break;
  }
  const tree = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=v5-status-indicator] [data-row]')].map((r) => ({
      row: r.dataset.row,
      text: r.textContent.trim(),
      live: r.getAttribute('aria-live'),
      role: r.getAttribute('role'),
      hidden: !!r.closest('[aria-hidden=true]'),
    })),
  );
  await page.close();
  const reachedSignOut = stops.some((s) => s.text === 'تسجيل الخروج');
  const stopInIndicator = stops.some((s) => s.inIndicator);
  const navStops = stops.filter((s) => s.inNav).map((s) => s.text);
  return { state, route, reachedSignOut, stopInIndicator, navStops, tree,
    pass: reachedSignOut && !stopInIndicator && tree.every((r) => !r.hidden && r.text.length > 0) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const state of ['Offline', 'Sending', 'Attention', 'PrinterFailed']) {
    for (const route of ['/app/dashboard', '/app/cart']) {
      const r = await walk(browser, state, route);
      log.push(r);
      console.log(r.pass ? 'PASS' : 'FAIL', state, route, JSON.stringify(r.navStops), JSON.stringify(r.tree.map((t) => t.text)));
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
