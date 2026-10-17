// RT-660 — keyboard-only walk of the Returns content on the DEV harness (#/dev/returns-proof). No mouse after load.
// Usage (repo root, with `npm run dev:vite` running): node docs/design/vnext/captures/RT-660/tools/walk-rt660.cjs <log.json> [baseUrl]
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [logFile, base = 'http://localhost:5173'] = process.argv.slice(2);
const SALE = 'TERM-01-2026-10-15-000042';
const log = [];
const step = (walk, what, ok, detail = '') => {
  log.push({ walk, what, ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', walk, '|', what, detail ? `| ${detail}` : '');
};
const focused = (p) =>
  p.evaluate(() => {
    const a = document.activeElement;
    return (a?.getAttribute('aria-label') || a?.textContent || a?.tagName || '').trim().slice(0, 48);
  });
/**
 * Tab forward until focus reaches `name`. Fails, rather than passing out of order, when focus first
 * lands on any of `notBefore`, or wraps back to a control it already visited (the target was behind).
 */
async function tabTo(p, name, max = 30, notBefore = []) {
  const run = `t${Date.now()}${Math.random()}`;
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    const now = await focused(p);
    if (now.startsWith(name)) return true;
    // Mark the focused element itself, so two controls with the same text are not taken for a wrap.
    const wrapped = await p.evaluate((mark) => {
      const a = document.activeElement;
      if (!a || a.dataset.walkSeen === mark) return true;
      a.dataset.walkSeen = mark;
      return false;
    }, run);
    if (wrapped || notBefore.some((other) => now.startsWith(other))) return false;
  }
  return false;
}
const settle = (p) => p.waitForTimeout(250);
const headingFocused = async (p, name) => (await focused(p)) === name;

async function open(p, state) {
  await p.goto(`${base}/#/dev/returns-proof?state=${state}`);
  await p.getByRole('heading', { level: 1, name: 'المرتجعات' }).waitFor();
  await p.locator('.v5-returns-journal').waitFor();
  await settle(p);
}

async function toSummary(p, walk) {
  step(walk, 'the sale-number field has focus on load', (await focused(p)) === 'INPUT');
  await p.keyboard.type(SALE);
  await p.keyboard.press('Enter');
  await settle(p);
  step(walk, 'Enter looks the sale up; focus moves to the step heading', await headingFocused(p, 'اختر الأصناف المرتجعة'));
  step(walk, 'Tab reaches «زيادة بنادول…» (the first enabled stepper)', await tabTo(p, 'زيادة بنادول'));
  await p.keyboard.press('Space');
  await settle(p);
  const qty = await p.locator('output[aria-label^="كمية بنادول"]').textContent();
  step(walk, 'Space picks one unit', qty === '1', `qty=${qty}`);
  step(walk, 'Tab reaches «احسب مبلغ الاسترداد»', await tabTo(p, 'احسب مبلغ الاسترداد'));
  await p.keyboard.press('Enter');
  await settle(p);
  step(walk, 'Enter quotes; focus moves to «ملخص الاسترداد»', await headingFocused(p, 'ملخص الاسترداد'));
  await p.keyboard.press('Enter');
  await settle(p);
  step(walk, 'Enter on the summary heading confirms nothing (D3)', (await p.getByRole('heading', { name: 'نتيجة المرتجع' }).count()) === 0);
  step(walk, 'Tab reaches «تأكيد الإرجاع»', await tabTo(p, 'تأكيد الإرجاع'));
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  try {
    // Walk 1: lookup → pick → quote → confirm → pay out → reprint, keyboard only.
    await open(p, 'PayoutPaid');
    await toSummary(p, 'flow');
    await p.keyboard.press('Space');
    await settle(p);
    step('flow', 'Space confirms; focus moves to «نتيجة المرتجع»', await headingFocused(p, 'نتيجة المرتجع'));
    step('flow', 'Tab reaches «افتح الدرج واصرف النقد» before «مرتجع جديد»', await tabTo(p, 'افتح الدرج واصرف النقد', 30, ['مرتجع جديد']));
    await p.keyboard.press('Enter');
    await settle(p);
    step('flow', 'Enter pays out; the region says it was recorded', (await p.getByText('سُجّل صرف المبلغ نقدًا.').count()) === 1);
    step('flow', 'Tab reaches «طباعة نسخة من الإيصال», then «مرتجع جديد»', (await tabTo(p, 'طباعة نسخة من الإيصال')) && (await tabTo(p, 'مرتجع جديد', 3)));
    step('flow', 'Tab continues into the journal row actions', await tabTo(p, 'طباعة نسخة TERM-01-2026-10-17-000031', 5));

    // Walk 2: a manual payout needs a second step whose first focus is «إلغاء».
    await open(p, 'PayoutConfirmManual');
    await toSummary(p, 'manual');
    await p.keyboard.press('Enter');
    await settle(p);
    await tabTo(p, 'افتح الدرج واصرف النقد');
    await p.keyboard.press('Enter');
    await settle(p);
    step('manual', 'the drawer did not open: Tab reaches «صرفتُ المبلغ يدويًا»', await tabTo(p, 'صرفتُ المبلغ يدويًا', 6));
    await p.keyboard.press('Enter');
    await settle(p);
    step('manual', 'the confirmation focuses «إلغاء» first', (await focused(p)) === 'إلغاء');
    await p.keyboard.press('Enter');
    await settle(p);
    step('manual', '«إلغاء» goes back with nothing recorded', (await p.getByText('لم يُفتح الدرج، ولم يُسجَّل أي صرف.').count()) === 1);

    // Walk 3: the journal by keyboard: check unresolved, row actions.
    await open(p, 'HistoryRows');
    step('journal', 'Tab reaches «تحقّق من غير المؤكدة»', await tabTo(p, 'تحقّق من غير المؤكدة'));
    step('journal', 'Tab reaches «صرف TERM-01-2026-10-17-000040»', await tabTo(p, 'صرف TERM-01-2026-10-17-000040', 4));
    await p.keyboard.press('Enter');
    await settle(p);
    step('journal', 'Enter opens that return\'s payout; focus on «نتيجة المرتجع»', await headingFocused(p, 'نتيجة المرتجع'));

    // Walk 4: a refusal at lookup is announced and keeps the field.
    await open(p, 'LookupNotFound');
    await p.keyboard.type('TERM-01-2026-10-15-000999');
    await p.keyboard.press('Enter');
    await settle(p);
    step('refusal', 'the refusal is an alert; focus stays in the field', (await p.getByRole('alert').count()) === 1 && (await focused(p)) === 'INPUT');
  } finally {
    await b.close();
  }
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
  if (log.some((s) => !s.ok)) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
