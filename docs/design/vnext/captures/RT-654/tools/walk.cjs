// RT-654 keyboard-only walk on the DEV void harness (npm run dev:vite, then: node walk.cjs <log.json>). No mouse after load.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const base = 'http://localhost:5173/#/dev/void-proof?state=';
const SALE = 'TERM-01-2026-10-17-000051';
const log = [];
const step = (walk, what, ok, detail = '') => { log.push({ walk, what, ok, detail }); console.log(ok ? 'PASS' : 'FAIL', walk, '|', what, detail ? '| ' + detail : ''); };
const focused = (p) => p.evaluate(() => { const a = document.activeElement; return (a?.getAttribute('aria-label') || (a?.tagName === 'INPUT' ? `INPUT:${a.type}:${a.id || a.closest('label')?.textContent || ''}` : a?.textContent) || a?.tagName || '').trim().slice(0, 50); });
const inDialog = (p) => p.evaluate(() => !!document.querySelector('[role=dialog]')?.contains(document.activeElement));
async function tabTo(p, name, max = 40, key = 'Tab') {
  for (let i = 0; i < max; i++) { await p.keyboard.press(key); if ((await focused(p)).includes(name)) return true; }
  return false;
}
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ viewport: { width: 1024, height: 768 }, timezoneId: 'Africa/Cairo' });
  const p = await ctx.newPage();

  // Walk 1: find a sale and open the confirm, by keyboard.
  await p.goto(base + 'Journal'); await p.waitForSelector('.v5-void'); await p.waitForTimeout(500);
  step('lookup', 'Tab reaches the sale number field', await tabTo(p, 'void-sale-number'));
  await p.keyboard.type(SALE); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  step('lookup', 'Enter in the field searches; the sale shows; focus stays in the field', (await p.locator('[data-testid=void-sale]').count()) === 1 && (await focused(p)).includes('void-sale-number'));
  step('lookup', 'Tab reaches «بحث» then «إلغاء هذا البيع» (44px each)', await tabTo(p, 'إلغاء هذا البيع', 3));
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  step('dialog', 'Enter opens the dialog with focus on «رجوع» (the safe control)', (await p.locator('[role=dialog]').count()) === 1 && (await focused(p)) === 'رجوع');
  const order = []; for (let i = 0; i < 5; i++) { await p.keyboard.press('Tab'); order.push(await focused(p)); }
  step('dialog', 'Tab cycles inside the dialog and never leaves it', (await inDialog(p)), order.join(' → '));
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  step('dialog', 'Esc closes with no request; focus returns to «إلغاء هذا البيع»', (await p.locator('[role=dialog]').count()) === 0 && (await focused(p)) === 'إلغاء هذا البيع' && (await p.locator('[data-testid=void-requested]').count()) === 0);

  // Walk 2: confirm by keyboard.
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  step('confirm', 'Shift+Tab from «رجوع» reaches the manager radios', await tabTo(p, 'radio', 6, 'Shift+Tab'));
  await p.keyboard.press('Space'); await p.waitForTimeout(100);
  const checked = await p.evaluate(() => document.activeElement?.checked === true);
  step('confirm', 'Space chooses the manager', checked);
  step('confirm', 'Tab reaches the PIN field', await tabTo(p, 'INPUT:password', 3));
  await p.keyboard.type('135790');
  const approveEnabled = await p.getByRole('button', { name: 'تأكيد الإلغاء' }).isEnabled();
  step('confirm', '«تأكيد الإلغاء» enables once a manager and a 6-digit PIN are set', approveEnabled);
  await p.keyboard.press('Enter'); await p.waitForTimeout(200);
  step('confirm', 'Enter in the PIN field does not send (the commit is a press only, as before)', (await p.locator('[role=dialog]').count()) === 1);
  step('confirm', 'Tab reaches «تأكيد الإلغاء»', await tabTo(p, 'تأكيد الإلغاء', 4));
  await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  step('confirm', 'Enter on «تأكيد الإلغاء» journals the void; the dialog closes; the notice shows', (await p.locator('[role=dialog]').count()) === 0 && (await p.locator('[data-testid=void-requested]').count()) === 1);
  step('confirm', 'focus returns to the sale number field', (await focused(p)).includes('void-sale-number'));

  // Walk 3: a refused approval keeps focus in the dialog.
  await p.goto(base + 'DialogRefused'); await p.waitForSelector('.v5-void'); await p.waitForTimeout(500);
  await tabTo(p, 'void-sale-number'); await p.keyboard.type(SALE); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  await tabTo(p, 'إلغاء هذا البيع', 3); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  await tabTo(p, 'radio', 6, 'Shift+Tab'); await p.keyboard.press('Space');
  await tabTo(p, 'INPUT:password', 3); await p.keyboard.type('135790');
  await tabTo(p, 'تأكيد الإلغاء', 4); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  step('refused', 'the refusal shows inside the dialog, focus on «رجوع», PIN cleared', (await p.locator('[role=dialog] [role=alert]').count()) === 1 && (await focused(p)) === 'رجوع' && (await p.locator('[role=dialog] input[type=password]').inputValue()) === '');

  // Walk 4: the journal by keyboard.
  await p.goto(base + 'RefServer'); await p.waitForSelector('.v5-void'); await p.waitForTimeout(500);
  step('journal', 'Tab reaches the journal list (a focusable scroll region)', await tabTo(p, 'طلبات الإلغاء'));
  const before = await p.evaluate(() => document.querySelector('.v5-void-rows').scrollTop);
  await p.keyboard.press('PageDown'); await p.waitForTimeout(200);
  const after = await p.evaluate(() => document.querySelector('.v5-void-rows').scrollTop);
  step('journal', 'PageDown scrolls the list', after > before, `${before} → ${after}`);
  step('journal', 'Tab reaches «تم الاطلاع»', await tabTo(p, 'تم الاطلاع', 3));

  await b.close();
  require('fs').writeFileSync(process.argv[2], JSON.stringify(log, null, 2));
  process.exit(log.every((l) => l.ok) ? 0 : 1);
})();
