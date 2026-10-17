// RT-445 keyboard-only + scanner walks on the DEV harness (npm run dev:vite, then: node walk.cjs <log.json>). No mouse after load.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const base = 'http://localhost:5173/#/dev/park-proof?state=';
const log = [];
const step = (walk, what, ok, detail = '') => { log.push({ walk, what, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', walk, '|', what, detail ? '| ' + detail : ''); };
const focused = (p) => p.evaluate(() => { const a = document.activeElement; return (a?.getAttribute('aria-label') || a?.textContent || a?.tagName || '').trim().slice(0, 40); });
async function tabTo(p, name, max = 40) {
  for (let i = 0; i < max; i++) { await p.keyboard.press('Tab'); if ((await focused(p)).includes(name)) return true; }
  return false;
}
async function scan(p, code = '6223004355218') { await p.keyboard.type(code, { delay: 5 }); await p.keyboard.press('Enter'); await p.waitForTimeout(250); }
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  // Walk 1: park by keyboard.
  await p.goto(base + 'Parked'); await p.waitForTimeout(900);
  step('keyboard', 'Tab reaches «تعليق البيع»', await tabTo(p, 'تعليق البيع'));
  await p.keyboard.press('Enter'); await p.waitForTimeout(200);
  step('keyboard', 'Enter opens the dialog, focus on the label field', (await p.locator('[role=dialog]').count()) === 1 && (await focused(p)) === 'INPUT');
  await scan(p);
  const notice = await p.locator('[data-testid=scan-notice]').textContent().catch(() => '');
  const val = await p.locator('[role=dialog] input').inputValue();
  step('scanner', 'a burst in the park dialog is refused (M-S6) and leaves the label as it was', notice.includes('أغلق النافذة') && val === '', `notice=${notice} value=${JSON.stringify(val)}`);
  await p.keyboard.type('ينتظر المحفظة');
  // Tab order inside the dialog wraps and never leaves it.
  const order = []; for (let i = 0; i < 4; i++) { await p.keyboard.press('Tab'); order.push(await focused(p)); }
  step('keyboard', 'Tab cycles inside the dialog (رجوع → تعليق البيع → field …)', order.every((o) => ['رجوع', 'تعليق البيع', 'INPUT'].includes(o)), order.join(' → '));
  await p.locator('[role=dialog] input').focus();
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  step('keyboard', 'Enter in the field parks; dialog closes; sale cleared; notice shown', (await p.locator('[role=dialog]').count()) === 0 && (await p.locator('.v5-sale-cart-line').count()) === 0 && (await p.getByText('عُلِّق البيع').count()) > 0);
  step('keyboard', 'focus returns to the scan field', (await p.evaluate(() => document.activeElement.id)) === 'v5-live-scan');
  // Walk 2: Esc closes the dialog with nothing parked.
  await p.goto(base + 'SaleReady'); await p.waitForTimeout(900);
  await tabTo(p, 'تعليق البيع'); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  step('keyboard', 'Esc closes the dialog; focus back on «تعليق البيع»; sale kept', (await p.locator('[role=dialog]').count()) === 0 && (await focused(p)).includes('تعليق البيع') && (await p.locator('.v5-sale-cart-line').count()) === 4);
  step('keyboard', 'F4 / F3 do nothing (D-K1)', await (async () => { await p.keyboard.press('F4'); await p.keyboard.press('F3'); await p.waitForTimeout(150); return (await p.locator('[role=dialog]').count()) === 0 && !(await p.url()).includes('parked'); })());
  // Walk 3: the list → review → accept, by keyboard.
  await p.goto(base + 'SaleReady'); await p.waitForTimeout(900);
  step('keyboard', 'Tab reaches «المبيعات المعلّقة»', await tabTo(p, 'المبيعات المعلّقة'));
  await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  step('keyboard', 'the list opens with focus on the newest «استئناف البيع»', (await focused(p)) === 'استئناف البيع');
  await scan(p);
  const n2 = await p.locator('[data-testid=scan-notice]').textContent().catch(() => '');
  step('scanner', 'a burst on the list is refused with «المسح متوقف — نافذة مفتوحة» (OD-15)', n2.includes('المسح متوقف — نافذة مفتوحة'), n2);
  await p.goto(base + 'ReviewMixed'); await p.waitForTimeout(900);
  await p.keyboard.press('Tab');
  if (!(await focused(p)).includes('استئناف')) await tabTo(p, 'استئناف البيع');
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  step('keyboard', 'Enter on «استئناف البيع» opens the review with focus on the accept', (await focused(p)).startsWith('قبول التغييرات'));
  await scan(p);
  const n3 = await p.locator('[data-testid=scan-notice]').textContent().catch(() => '');
  step('scanner', 'a burst while the accept has focus is refused and resumes nothing', n3.includes('نافذة مفتوحة') && (await p.locator('#v5-park-review-title').count()) === 1, n3);
  await p.keyboard.press('Tab'); 
  step('keyboard', 'Tab moves to «رجوع»', (await focused(p)) === 'رجوع');
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  step('keyboard', '«رجوع» returns to the list (no call)', (await focused(p)) === 'استئناف البيع');
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  step('keyboard', 'accept resumes and returns to the Sale with the resumed cart', p.url().endsWith('/app/cart') || (await p.locator('.v5-sale-cart-line').count()) > 0, p.url());
  // Walk 4: shift close.
  await p.goto(base + 'ShiftClose'); await p.waitForTimeout(900);
  await tabTo(p, 'INPUT'); await p.keyboard.type('2450');
  await tabTo(p, 'تسجيل العدّ'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  step('keyboard', 'the close refusal shows the count', (await p.getByText('3 مبيعات معلّقة على هذا الجهاز').count()) === 1);
  step('keyboard', 'Tab reaches «عرض مبيعاتي المعلّقة»', await tabTo(p, 'عرض مبيعاتي المعلّقة'));
  await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  step('keyboard', 'Enter opens the cashier’s parked list', (await p.locator('#v5-park-list-title').count()) === 1);
  await b.close();
  require('fs').writeFileSync(process.argv[2], JSON.stringify(log, null, 2));
  process.exit(log.every((l) => l.ok) ? 0 : 1);
})();
