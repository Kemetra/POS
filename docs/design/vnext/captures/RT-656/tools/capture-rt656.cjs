// RT-656 — capture Manager → المبيعات المعلقة from the DEV harness (#/dev/recovery-proof): the real
// RecoveryScreen in the real V5Frame against in-memory bridges, at 1024×768 and 1280×800, light and
// forced colours, one capture per RC reference state the harness can reach. Dialog and outcome
// states are reached with the keyboard only (Tab / Enter / typing), like a manager would.
// Runs axe on the whole document (light) plus the legacy-class, fit and type checks on each.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-656/tools/capture-rt656.cjs <outDir> [baseUrl]
// Browser: PLAYWRIGHT_CORE (module path) and CHROMIUM_PATH (executable) override the cloud-session
// defaults below; the repo declares no Playwright dependency, so point them at a local install.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SIZES = { 1024: 768, 1280: 800 };
const PIN = '123456';

/** Tab until the focused control's text is `label`, then press Enter. */
async function press(page, label) {
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => (document.activeElement?.textContent || '').trim());
    if (text === label) {
      await page.keyboard.press('Enter');
      return;
    }
  }
  throw new Error(`no control «${label}»`);
}

/** Tab to the field labelled `label` (by its accessible label text) and type `text`. */
async function fill(page, label, text) {
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((l) => {
      const a = document.activeElement;
      return !!a?.labels && [...a.labels].some((x) => x.textContent.includes(l));
    }, label);
    if (hit) {
      await page.keyboard.type(text);
      return;
    }
  }
  throw new Error(`no field «${label}»`);
}

/** Tab to each checkbox in the dialog and tick it with Space. */
async function tickAll(page) {
  const n = await page.evaluate(() => document.querySelectorAll('[role=dialog] input[type=checkbox]').length);
  for (let ticked = 0, i = 0; ticked < n && i < 20; i += 1) {
    await page.keyboard.press('Tab');
    const box = await page.evaluate(() => document.activeElement?.type === 'checkbox');
    if (box) {
      await page.keyboard.press('Space');
      ticked += 1;
    }
  }
}

const dialog = (page) => page.waitForSelector('[role=dialog]');
const pinField = (page) => page.waitForSelector('[role=dialog] input[type=password]');

// [state, harness query, keyboard steps]
const CASES = [
  ['Typical', 'view=typical', null],
  ['RecoveryMode', 'view=recovery', null],
  ['Long', 'view=long', null],
  ['Empty', 'view=empty', null],
  ['Refused', 'view=refused', null],
  ['Complete', 'view=typical', async (p) => { await press(p, 'إكمال البيع'); await pinField(p); }],
  ['CompleteReady', 'view=typical', async (p) => {
    await press(p, 'إكمال البيع'); await pinField(p);
    await fill(p, 'النقدية المستلمة', '150'); await fill(p, 'الرقم السري', PIN);
  }],
  ['CancelPayment', 'view=recovery', async (p) => { await press(p, 'إلغاء الدفع'); await pinField(p); }],
  ['CancelPaymentReady', 'view=recovery', async (p) => {
    await press(p, 'إلغاء الدفع'); await pinField(p);
    await tickAll(p); await fill(p, 'الرقم السري', PIN);
  }],
  ['CancelSale', 'view=typical', async (p) => { await press(p, 'إلغاء البيع'); await pinField(p); }],
  ['WrongPin', 'view=typical&approval=wrong_pin', async (p) => {
    await press(p, 'إلغاء البيع'); await pinField(p);
    await fill(p, 'الرقم السري', PIN); await press(p, 'تأكيد');
    await p.waitForSelector('[role=dialog] [role=alert]');
  }],
  ['NoPin', 'view=typical&approver=none', async (p) => {
    await press(p, 'إلغاء البيع'); await dialog(p); await p.waitForSelector('[role=dialog] [role=alert]');
  }],
  ['ApproverLocked', 'view=typical&approver=locked', async (p) => {
    await press(p, 'إلغاء البيع'); await dialog(p); await p.waitForSelector('[role=dialog] [role=alert]');
  }],
  ['Completed', 'view=typical', async (p) => {
    await press(p, 'إكمال البيع'); await pinField(p);
    await fill(p, 'النقدية المستلمة', '150'); await fill(p, 'الرقم السري', PIN); await press(p, 'تأكيد');
    await p.waitForSelector('.v5-notice[data-tone=success]');
  }],
  ['CancelledPayment', 'view=typical', async (p) => {
    await press(p, 'إلغاء الدفع'); await pinField(p);
    await tickAll(p); await fill(p, 'الرقم السري', PIN); await press(p, 'تأكيد');
    await p.waitForSelector('.v5-notice[data-tone=success]');
  }],
  ['CancelledSale', 'view=typical', async (p) => {
    await press(p, 'إلغاء البيع'); await pinField(p);
    await fill(p, 'الرقم السري', PIN); await press(p, 'تأكيد');
    await p.waitForSelector('.v5-notice[data-tone=success]');
  }],
];

function checks() {
  const legacy = document.querySelectorAll('[class*="v5-shift"], [class*="v5-live-btn"]').length;
  const h1 = [...document.querySelectorAll('h1')].map((h) => h.textContent.trim());
  const small = [...document.querySelectorAll('main *, [role=dialog] *')].filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    return el.getBoundingClientRect().width > 1 && parseFloat(getComputedStyle(el).fontSize) < 12;
  }).length;
  const targets = [...document.querySelectorAll('main button, [role=dialog] button, [role=dialog] input')]
    .filter((n) => {
      const box = n.type === 'checkbox' && n.closest('label') ? n.closest('label') : n;
      const r = box.getBoundingClientRect();
      return r.width > 0 && (r.height < 44 || r.width < 44);
    }).length;
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const focused = (document.activeElement?.textContent || document.activeElement?.tagName || '').trim().slice(0, 30);
  return { legacy, h1, small, targets, overflowX, focused };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  const failures = [];
  for (const [name, query, steps] of CASES) {
    for (const [w, h] of Object.entries(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#/dev/recovery-proof?${query}`);
        await page.waitForSelector('.v5-recovery .v5-recovery-grid, .v5-recovery [role=alert]');
        if (steps) await steps(page);
        await page.evaluate(() => document.fonts.ready);
        const file = `rt656-${name}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        let axe = [];
        if (mode === 'light') {
          await page.addScriptTag({ path: AXE });
          axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
            .violations.map((v) => `${v.id}(${v.nodes.length})`));
        }
        const c = await page.evaluate(checks);
        log.push({ name, query, width: +w, mode, file, axe, ...c, errors });
        const ok = errors.length === 0 && axe.length === 0 && c.legacy === 0 && c.small === 0
          && c.targets === 0 && !c.overflowX && c.h1.length === 1;
        if (!ok) failures.push(file);
        console.log(ok ? 'ok  ' : 'FAIL', name, w, mode, JSON.stringify({ axe, ...c, e: errors }));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt656-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`, failures.join(', '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
