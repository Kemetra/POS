// RT-656 — keyboard-only pass over Manager → المبيعات المعلقة, no mouse after load.
// Page: one full Tab cycle (sign-out reached twice) must reach every recovery action.
// Dialog: opened with Enter, first focus on «رجوع», Tab stays inside the dialog, Escape closes it
// and returns focus to the button that opened it. Refused PIN: focus returns to the PIN (OD-4).
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-656/tools/walk-rt656.cjs <outFile> [baseUrl]
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [outFile, base = 'http://localhost:5173'] = process.argv.slice(2);
// CHROMIUM_PATH overrides the cloud-session browser (no Playwright dependency is declared).
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {
    text: (a.textContent || a.getAttribute('aria-label') || a.tagName).trim().slice(0, 40),
    tag: a.tagName,
    type: a.type || null,
    inDialog: !!a.closest('[role=dialog]'),
  };
});

async function open(browser, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/dev/recovery-proof?${query}`);
  await page.waitForSelector('.v5-recovery-grid');
  return page;
}

/** One full Tab cycle over the page: the stops, in order, until sign-out is seen twice. */
async function pageCycle(browser, name, query, expected) {
  const page = await open(browser, query);
  const stops = [];
  let signOut = 0;
  for (let i = 0; i < 80 && signOut < 2; i += 1) {
    await page.keyboard.press('Tab');
    const s = await active(page);
    stops.push(s.text);
    if (s.text === 'تسجيل الخروج') signOut += 1;
  }
  await page.close();
  const counts = Object.fromEntries(expected.map(([label]) => [label, 0]));
  for (const t of stops) if (t in counts) counts[t] += 1;
  // Each recovery action is reached as many times per cycle as it is drawn (sign-out ends a cycle).
  const pass = signOut === 2 && expected.every(([label, n]) => counts[label] >= n);
  return { name, kind: 'page', stops, counts, pass };
}

/** Enter on «label», check the dialog's focus, its Tab trap, then Escape back to the opener. */
async function dialogTrap(browser, name, query, label) {
  const page = await open(browser, query);
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    if ((await active(page)).text === label) break;
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=dialog] input[type=password], [role=dialog] [role=alert]');
  const first = await active(page);
  const trapped = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    trapped.push(await active(page));
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });
  const back = await active(page);
  await page.close();
  const pass = first.text === 'رجوع' && trapped.every((s) => s.inDialog) && back.text === label;
  return { name, kind: 'dialog', first, trap: trapped.map((s) => s.text), returnedTo: back.text, pass };
}

/** OD-4: a refused PIN leaves focus in the cleared PIN field. */
async function refusedPin(browser) {
  const page = await open(browser, 'view=typical&approval=wrong_pin');
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    if ((await active(page)).text === 'إلغاء البيع') break;
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=dialog] input[type=password]');
  await page.keyboard.press('Tab');
  await page.keyboard.type('123456');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const confirm = await active(page);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=dialog] [role=alert]');
  const after = await active(page);
  const value = await page.evaluate(() => document.querySelector('[role=dialog] input[type=password]').value);
  await page.close();
  const pass = confirm.text === 'تأكيد' && after.type === 'password' && value === '';
  return { name: 'WrongPin', kind: 'od4', confirm: confirm.text, focusAfter: after, pinCleared: value === '', pass };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [
    await pageCycle(browser, 'Typical', 'view=typical',
      [['إكمال البيع', 1], ['إلغاء الدفع', 1], ['إلغاء البيع', 4]]),
    await pageCycle(browser, 'Long', 'view=long', [['إلغاء البيع', 9]]),
    await dialogTrap(browser, 'Complete', 'view=typical', 'إكمال البيع'),
    await dialogTrap(browser, 'CancelPayment', 'view=recovery', 'إلغاء الدفع'),
    await dialogTrap(browser, 'CancelSale', 'view=typical', 'إلغاء البيع'),
    await dialogTrap(browser, 'NoPin', 'view=typical&approver=none', 'إلغاء البيع'),
    await refusedPin(browser),
  ];
  for (const r of log) console.log(r.pass ? 'PASS' : 'FAIL', r.kind, r.name, JSON.stringify(r.counts || r.trap || r.focusAfter));
  fs.writeFileSync(outFile, `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (log.some((r) => !r.pass)) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
