// RT-605 — keyboard-only pass over the frame with the status banners, no mouse after load.
// The M-O1 / M-O3 banners add no control: Tab must never stop inside them, the printer banner's
// own controls must stay reachable, and Tab must still reach sign-out. The walk covers one full
// Tab cycle: the sale screen focuses its scan field on load, so the stack before <main> is
// reached after Tab wraps. Each banner's text and live
// role must be exposed to assistive tech (panel and slim rail).
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-605/tools/walk-rt605.cjs <outFile> [baseUrl]
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [outFile, base = 'http://localhost:5173'] = process.argv.slice(2);
// CHROMIUM_PATH overrides the cloud-session browser (no Playwright dependency is declared).
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const STATUS = '[data-testid=v5-offline-banner], [data-testid=v5-sync-attention-banner]';

async function walk(browser, name, query, route) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/dev/status-proof?${query}&path=${route}`);
  await page.waitForSelector('[data-testid=v5-status-indicator]');
  await page.waitForSelector(query.includes('closed=shift') ? '[data-testid=shift-closed-banner]' : STATUS);
  const stops = [];
  let signOutSeen = 0;
  for (let i = 0; i < 120; i += 1) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate((sel) => {
      const a = document.activeElement;
      return {
        text: (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 30),
        inStatusBanner: !!a.closest(sel),
        inPrinter: !!a.closest('[data-testid=printer-failure-banner]'),
        inShiftClosed: !!a.closest('[data-testid=shift-closed-banner]'),
      };
    }, STATUS);
    stops.push(s);
    // A full cycle: stop at the second visit to sign-out.
    if (s.text === 'تسجيل الخروج' && (signOutSeen += 1) === 2) break;
  }
  const tree = await page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((b) => ({
      id: b.dataset.testid, text: b.textContent.trim(), role: b.getAttribute('role'),
      live: b.getAttribute('aria-live'), hidden: !!b.closest('[aria-hidden=true]'),
      inAside: !!b.closest('aside[aria-label]'),
    })), STATUS);
  await page.close();
  // A full Tab cycle: sign-out must be reached twice, not once before the Tab limit.
  const reachedSignOut = signOutSeen === 2;
  const stopInStatusBanner = stops.some((s) => s.inStatusBanner);
  const printerStops = stops.filter((s) => s.inPrinter).map((s) => s.text);
  const expectPrinter = query.includes('banner=printer');
  const shiftClosedStops = stops.filter((s) => s.inShiftClosed).map((s) => s.text);
  const expectShiftClosed = query.includes('closed=shift');
  const pass = reachedSignOut && !stopInStatusBanner && (!expectPrinter || printerStops.length > 0)
    && (!expectShiftClosed || shiftClosedStops.includes('إخفاء'))
    && (tree.length > 0 || expectShiftClosed) && tree.every((b) => !b.hidden && b.inAside && b.text.length > 0);
  return { name, route, reachedSignOut, stopInStatusBanner, printerStops, shiftClosedStops, tree, pass };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  const cases = [
    ['Offline', 'state=Offline'],
    ['AttentionDeadLetter', 'state=Attention'],
    ['OfflineAttention', 'state=OfflineAttention'],
    ['OfflineAttentionPrinter', 'state=OfflineAttention&banner=printer'],
    ['ShiftClosed', 'state=Connected&closed=shift'],
    ['FullStack', 'state=OfflineAttention&banner=printer&closed=shift'],
  ];
  for (const [name, query] of cases) {
    for (const route of ['/app/dashboard', '/app/cart']) {
      const r = await walk(browser, name, query, route);
      log.push(r);
      console.log(r.pass ? 'PASS' : 'FAIL', name, route, JSON.stringify(r.printerStops), JSON.stringify(r.shiftClosedStops), JSON.stringify(r.tree.map((t) => `${t.role}/${t.live}`)));
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (log.some((r) => !r.pass)) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
