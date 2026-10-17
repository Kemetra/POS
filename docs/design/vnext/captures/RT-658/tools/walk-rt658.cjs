// RT-658 — keyboard-only walk of the shift screens in the DEV harness (#/dev/shift-proof):
// no mouse after load. Records the Tab order and checks that every stop shows a focus ring,
// that each dialog keeps focus inside, that Escape closes it and returns focus to its opener,
// and that a close can be counted and sent from the keyboard.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-658/tools/walk-rt658.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);

/** Runs in the page: what has focus, its name, whether it is in a dialog and shows a ring. */
function focused() {
  const el = document.activeElement;
  if (!el || el === document.body) return { name: '(body)' };
  const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
  const name = (el.getAttribute('aria-label') || label?.textContent || el.closest('label')?.textContent ||
    el.textContent || '').trim().replace(/\s+/g, ' ');
  const s = getComputedStyle(el);
  const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  return { tag: el.tagName.toLowerCase(), type: el.type || '', name, inDialog: !!el.closest('[role="dialog"]'), ring };
}

async function tabs(page, n) {
  const stops = [];
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(focused));
  }
  return stops;
}

/** Tabs until an element with `name` has focus; fails after `max` presses. */
async function tabTo(page, name, max = 30) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(focused);
    if (f.name === name) return f;
  }
  throw new Error(`no tab stop named ${name}`);
}

const WALKS = {
  // The open-shift screen: the order, then pay-in by keyboard, trapped, Escape back to the opener.
  async cashierStatus(page) {
    await page.goto(`${base}/#/dev/shift-proof?state=Status`);
    await page.getByText('إغلاق الوردية').first().waitFor();
    // One cycle of the page: the browser's own stop (<body>, past the last control) is not a control.
    const order = (await tabs(page, 9)).filter((s) => s.name !== '(body)');
    await page.evaluate(() => document.activeElement.blur());
    await tabTo(page, 'إيداع نقدي');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    const opened = await page.evaluate(focused);
    const inside = await tabs(page, 8);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const back = await page.evaluate(focused);
    const pass =
      order.every((s) => s.ring) && opened.name === 'المبلغ' && opened.inDialog &&
      inside.every((s) => s.inDialog && s.ring) && back.name === 'إيداع نقدي';
    return { pass, order, opened, inside, back };
  },
  // The blind count, sent from the keyboard: type, Tab to the commit, Enter → the approval dialog.
  async cashierClose(page) {
    await page.goto(`${base}/#/dev/shift-proof?state=CloseApproval`);
    await page.getByText('إغلاق الوردية').first().waitFor();
    await tabTo(page, 'النقد المعدود في الدرج');
    await page.keyboard.type('2425');
    const commit = await tabTo(page, 'تسجيل العدّ وإغلاق الوردية');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    const opened = await page.evaluate(focused);
    const inside = await tabs(page, 6);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const back = await page.evaluate(focused);
    const pass = commit.ring && opened.name === 'إلغاء' && inside.every((s) => s.inDialog) &&
      back.name === 'تسجيل العدّ وإغلاق الوردية';
    return { pass, commit, opened, inside, back };
  },
  // No shift: the float is reachable and an invalid entry is announced on the field.
  async cashierOpen(page) {
    await page.goto(`${base}/#/dev/shift-proof?state=OpenInvalid`);
    await page.getByText('فتح وردية').first().waitFor();
    const field = await tabTo(page, 'مبلغ الافتتاح في الدرج');
    await page.keyboard.type('50.555');
    await tabTo(page, 'فتح الوردية');
    await page.keyboard.press('Enter');
    await page.getByRole('alert').first().waitFor();
    const invalid = await page.getByLabel('مبلغ الافتتاح في الدرج').getAttribute('aria-invalid');
    const pass = field.ring && invalid === 'true';
    return { pass, field, invalid };
  },
  // The manager page: refresh in the status card head, then the three PIN fields and the save.
  async managerPage(page) {
    await page.goto(`${base}/#/dev/shift-proof?state=MgrOpen`);
    await page.getByText('حفظ الرقم السري').first().waitFor();
    const refresh = await tabTo(page, 'تحديث');
    const after = await tabs(page, 4);
    const names = after.map((s) => s.name);
    const pass = refresh.ring && after.every((s) => s.ring) && names.join('|') ===
      ['الرقم السري الجديد (6 إلى 8 أرقام)', 'تأكيد الرقم السري', 'الرقم السري الحالي (عند التغيير فقط)', 'حفظ الرقم السري'].join('|');
    return { pass, refresh, after };
  },
};

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const [walk, run] of Object.entries(WALKS)) {
    for (const w of [1024, 1280]) {
      const page = await browser.newPage({ viewport: { width: w, height: w === 1024 ? 768 : 800 } });
      const result = await run(page);
      log.push({ walk, width: w, ...result });
      console.log(walk, w, result.pass ? 'PASS' : 'FAIL');
      await page.close();
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt658-walk-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (log.some((r) => !r.pass)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
