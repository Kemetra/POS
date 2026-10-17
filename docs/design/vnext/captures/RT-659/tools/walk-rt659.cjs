// RT-659 — keyboard-only pass over the receipt preview dialog on /app/sales, no mouse at all:
// type the sale number, Enter, Tab to «معاينة الإيصال», Enter to open. Then: focus starts on
// «إغلاق»; Tab and Shift+Tab stay inside the dialog (the slip region, «إغلاق»); the frame behind
// is unreachable; Esc closes and focus returns to «معاينة الإيصال»; reopening and pressing Enter
// on «إغلاق» closes too, with the same focus return. Ready, Loading and Failed, at 1024 and 1280.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-659/tools/walk-rt659.cjs <outFile> [baseUrl]
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [outFile, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const NUMBER = 'TERM-01-2026-10-15-000042';
const OPENER = 'معاينة الإيصال';

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {
    text: (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 30),
    inDialog: !!a.closest('[role=dialog]'),
  };
});

/** Tab from the lookup field until the opener has focus (keyboard only). */
async function tabToOpener(page) {
  for (let i = 0; i < 20; i += 1) {
    if ((await active(page)).text === OPENER) return true;
    await page.keyboard.press('Tab');
  }
  return false;
}

async function openByKeyboard(page) {
  const reached = await tabToOpener(page);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=dialog]');
  return reached;
}

async function walk(browser, preview, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 1024 ? 768 : 800 } });
  await page.goto(`${base}/#/dev/one-frame-proof?path=/app/sales&sale=found&preview=${preview}`);
  const field = page.getByRole('textbox', { name: 'رقم البيع' });
  await field.focus();
  await page.keyboard.type(NUMBER);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: OPENER }).waitFor();
  const reachedOpener = await openByKeyboard(page);
  const initial = await active(page);
  const stops = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await active(page));
  }
  await page.keyboard.press('Shift+Tab');
  stops.push(await active(page));
  const escaped = await page.keyboard.press('Escape').then(() => page.waitForSelector('[role=dialog]', { state: 'detached' }).then(() => true, () => false));
  const afterEsc = await active(page);
  await page.keyboard.press('Enter'); // focus is back on the opener: Enter reopens
  await page.waitForSelector('[role=dialog]');
  const reopenedOn = await active(page);
  await page.keyboard.press('Enter'); // Enter on «إغلاق»
  const closedByEnter = await page.waitForSelector('[role=dialog]', { state: 'detached' }).then(() => true, () => false);
  const afterClose = await active(page);
  await page.close();
  const stopTexts = [...new Set(stops.map((s) => s.text))].sort();
  const expected = preview === 'ok' ? ['الإيصال', 'إغلاق'].sort() : ['إغلاق'];
  const pass = reachedOpener && initial.text === 'إغلاق' && initial.inDialog
    && stops.every((s) => s.inDialog) && JSON.stringify(stopTexts) === JSON.stringify(expected)
    && escaped && afterEsc.text === OPENER && reopenedOn.text === 'إغلاق'
    && closedByEnter && afterClose.text === OPENER;
  return { preview, width, reachedOpener, initial, stops, stopTexts, escaped, afterEsc, reopenedOn, closedByEnter, afterClose, pass };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  for (const preview of ['ok', 'pending', 'fail']) {
    for (const width of [1024, 1280]) {
      const r = await walk(browser, preview, width);
      log.push(r);
      console.log(r.pass ? 'PASS' : 'FAIL', preview, width, JSON.stringify(r.stopTexts), r.afterEsc.text, r.afterClose.text);
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (log.some((r) => !r.pass)) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
