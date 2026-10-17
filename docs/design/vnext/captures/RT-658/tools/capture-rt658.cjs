// RT-658 — capture every G-2 shift state from the DEV harness (#/dev/shift-proof) at 1024×768 and
// 1280×800, light and forced-colors, and run axe plus the fit / target / type checks on each.
// Interactive states are reached the way an operator reaches them: by the visible controls.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-658/tools/capture-rt658.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };

const FLOAT = 'مبلغ الافتتاح في الدرج';
const COUNT = 'النقد المعدود في الدرج';
const CLOSE = 'تسجيل العدّ وإغلاق الوردية';

async function count(page, value) {
  await page.getByLabel(COUNT).fill(value);
}

async function closeWith(page, value) {
  await count(page, value);
  await page.getByRole('button', { name: CLOSE }).click();
}

async function movement(page, kind, amount) {
  await page.getByRole('button', { name: kind }).click();
  await page.getByRole('dialog').getByLabel('المبلغ').fill(amount);
}

async function pins(page, pin, confirm) {
  await page.getByLabel('الرقم السري الجديد (6 إلى 8 أرقام)').fill(pin);
  await page.getByLabel('تأكيد الرقم السري').fill(confirm);
  await page.getByRole('button', { name: 'حفظ الرقم السري' }).click();
}

/** Each state's steps from the harness's first screen, then what to wait for. */
const STATES = {
  Open: { ready: 'فتح وردية' },
  OpenInvalid: {
    ready: 'فتح وردية',
    steps: async (p) => {
      await p.getByLabel(FLOAT).fill('50.555');
      await p.getByRole('button', { name: 'فتح الوردية' }).click();
      await p.getByLabel(FLOAT).focus();
    },
    wait: 'أدخل مبلغًا صحيحًا',
  },
  Opened: {
    ready: 'فتح وردية',
    steps: async (p) => {
      await p.getByLabel(FLOAT).fill('500');
      await p.getByRole('button', { name: 'فتح الوردية' }).click();
    },
    wait: 'فُتحت الوردية.',
  },
  Status: { ready: 'إغلاق الوردية' },
  PayIn: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await movement(p, 'إيداع نقدي', '200.00');
      await p.getByRole('dialog').getByLabel('السبب').selectOption('float_top_up');
      await p.getByRole('dialog').getByLabel('المبلغ').focus();
    },
  },
  PayOut: { ready: 'إغلاق الوردية', steps: (p) => movement(p, 'سحب نقدي', '300.00') },
  PayOutRefused: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await movement(p, 'سحب نقدي', '3000');
      await p.getByRole('dialog').getByRole('button', { name: 'تسجيل' }).click();
    },
    wait: 'لم يُقبل السحب',
  },
  Recorded: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await movement(p, 'إيداع نقدي', '200');
      await p.getByRole('dialog').getByRole('button', { name: 'تسجيل' }).click();
    },
    wait: 'سُجّل الإيداع.',
  },
  CloseCount: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await count(p, '2,425.00');
      await p.getByRole('button', { name: CLOSE }).focus();
    },
  },
  CloseApproval: { ready: 'إغلاق الوردية', steps: (p) => closeWith(p, '2425'), wait: 'موافقة المدير' },
  Closed: { ready: 'إغلاق الوردية', steps: (p) => closeWith(p, '2450'), wait: 'أُغلقت الوردية.' },
  ClosedApproved: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await closeWith(p, '2425');
      const dialog = p.getByRole('dialog');
      await dialog.getByLabel('سارة عبد الحميد').check();
      await dialog.getByLabel('الرقم السري للمدير').fill('482913');
      await dialog.getByRole('button', { name: 'اعتماد وإغلاق' }).click();
    },
    wait: 'فرق العدّ المعتمد',
  },
  ParkedBlocked: {
    ready: 'إغلاق الوردية',
    steps: async (p) => {
      await closeWith(p, '2450');
      await p.getByTestId('shift-parked-block').waitFor();
      await p.getByRole('button', { name: CLOSE }).focus();
    },
  },
  Unavailable: { ready: 'تعذّر تنفيذ الطلب' },
  MgrOpen: {
    ready: 'حفظ الرقم السري',
    steps: (p) => p.getByLabel('الرقم السري الجديد (6 إلى 8 أرقام)').focus(),
  },
  MgrNoShift: { ready: 'لا توجد وردية مفتوحة.' },
  MgrStranded: { ready: 'تنبيه: على هذا الجهاز' },
  MgrPinSaved: {
    ready: 'حفظ الرقم السري',
    steps: (p) => pins(p, '482913', '482913'),
    wait: 'حُفظ الرقم السري لهذا الجهاز.',
  },
  MgrPinError: {
    ready: 'حفظ الرقم السري',
    steps: (p) => pins(p, '482913', '482914'),
    wait: 'الرقمان غير متطابقين.',
  },
  MgrUnavailable: { ready: 'تعذّر تنفيذ الطلب' },
};

/** Runs in the page: the screen fits, no small text, no small target, no horizontal spill. */
function checks() {
  const section = document.querySelector('.v5-screen-section');
  const scope = [...document.querySelectorAll('.v5-screen-section, [role="dialog"]')];
  const textNodes = scope.flatMap((root) => [...root.querySelectorAll('*')]).filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    return el.getBoundingClientRect().width > 1;
  });
  const small = textNodes.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12).length;
  const targets = scope
    .flatMap((root) => [...root.querySelectorAll('button, input, select, a[href], textarea')])
    .filter((el) => {
      const box = el.type === 'radio' && el.closest('label') ? el.closest('label') : el;
      const r = box.getBoundingClientRect();
      return r.width > 0 && (r.height < 44 || r.width < 44);
    })
    .map((el) => el.textContent.trim() || el.getAttribute('aria-label') || el.tagName).slice(0, 5);
  const sectionScrolls = !!section && section.scrollHeight > section.clientHeight + 1;
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const monoDates = [...document.querySelectorAll('time')].filter((t) =>
    /mono|consolas|cascadia/i.test(getComputedStyle(t).fontFamily),
  ).length;
  const titlebar = document.querySelectorAll('.v5-shift-titlebar').length;
  return { small, targets, sectionScrolls, overflowX, monoDates, titlebar };
}

async function open(browser, state, w, mode) {
  const page = await browser.newPage({ viewport: { width: +w, height: SIZES[w] }, bypassCSP: true });
  if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/dev/shift-proof?state=${state}`);
  const spec = STATES[state];
  await page.getByText(spec.ready, { exact: false }).first().waitFor();
  if (spec.steps) await spec.steps(page);
  if (spec.wait) await page.getByText(spec.wait, { exact: false }).first().waitFor();
  await page.waitForTimeout(400);
  return { page, errors };
}

async function axe(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () =>
    (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(
      (v) => `${v.id}(${v.nodes.length})`,
    ),
  );
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const state of Object.keys(STATES)) {
    for (const w of Object.keys(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const { page, errors } = await open(browser, state, w, mode);
        const file = `rt658-${state}-${w}x${SIZES[w]}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        const violations = mode === 'light' ? await axe(page) : [];
        const c = await page.evaluate(checks);
        log.push({ state, width: +w, mode, file, axe: violations, ...c, errors });
        console.log(state, w, mode, JSON.stringify({ axe: violations, ...c, errors }));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt658-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
