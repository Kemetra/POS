// RT-660 — capture every G6R state from the DEV Returns harness (#/dev/returns-proof) at 1024×768 and
// 1280×800, light and forced-colors, and run axe + the fit / target / text checks on each.
// Usage (repo root, with `npm run dev:vite` running): node docs/design/vnext/captures/RT-660/tools/capture-rt660.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const STATES = [
  'LookupEmpty', 'LookupBlank', 'LookupNotFound', 'LookupRefused', 'LookupOffline',
  'Found', 'SelectPicked', 'SelectQuoting', 'SelectRefused', 'Quote',
  'OutcomeUnconfirmed', 'OutcomeRefused', 'OutcomeFailed', 'OutcomeMayBeRecorded',
  'PayoutReady', 'PayoutOpening', 'PayoutPaid', 'PayoutNoDrawer', 'PayoutSlipFailed', 'PayoutReprintFailed',
  'PayoutDrawerFailed', 'PayoutDrawerUnknown', 'PayoutConfirmManual', 'PayoutInterrupted', 'PayoutWait',
  'PayoutRefused', 'PayoutUnknown',
  'HistoryEmpty', 'HistoryRows', 'HistoryReprintFailed', 'HistoryFailed', 'Disabled',
];
const SALE = 'TERM-01-2026-10-15-000042';
const TYPED = { LookupNotFound: 'TERM-01-2026-10-15-000999', LookupRefused: 'TERM-01-2026-10-15-000057' };

const button = (page, name) => page.getByRole('button', { name, exact: true });

/** The lookup step: type the number (or nothing) and press Enter, as a manager does. */
async function lookup(page, state) {
  const field = page.getByLabel('رقم البيع');
  if (state !== 'LookupBlank') await field.fill(TYPED[state] ?? SALE);
  await field.press('Enter');
}

async function pick(page) {
  await page.getByRole('button', { name: /^زيادة بنادول/ }).click();
  await page.getByRole('button', { name: /^زيادة أموكسيسيلين/ }).click();
}

const AFTER_PICK = /^(Select(Quoting|Refused)|Quote|Outcome|Payout)/;
const AFTER_CONFIRM = /^(Outcome|Payout)/;
const STARTS_PAYOUT = /^Payout(?!Ready$|Interrupted$)/;

/** One step of the flow per regex, in order; each runs only when its state needs it. */
const FLOW = [
  [/^(Lookup(?!Empty$)|Found|Select|Quote|Outcome|Payout)/, (p, s) => lookup(p, s)],
  [/^(Select|Quote|Outcome|Payout)/, (p) => pick(p)],
  [AFTER_PICK, (p) => button(p, 'احسب مبلغ الاسترداد').click()],
  [AFTER_CONFIRM, (p) => button(p, 'تأكيد الإرجاع').click()],
  [STARTS_PAYOUT, (p) => button(p, 'افتح الدرج واصرف النقد').click()],
  [/^PayoutConfirmManual$/, (p) => button(p, 'صرفتُ المبلغ يدويًا').click()],
  [/^PayoutReprintFailed$/, (p) => button(p, 'طباعة نسخة من الإيصال').click()],
  [/^HistoryReprintFailed$/, (p) => p.getByRole('button', { name: /^طباعة نسخة TERM-01-2026-10-17-000031$/ }).click()],
];

async function drive(page, state) {
  await page.getByRole('heading', { level: 1, name: 'المرتجعات' }).waitFor();
  if (state !== 'Disabled') await page.locator('.v5-returns-journal').waitFor();
  for (const [when, step] of FLOW) {
    if (!when.test(state)) continue;
    await step(page, state);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
}

function checks() {
  const small = [...document.querySelectorAll('body *')].filter((n) => {
    if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && parseFloat(getComputedStyle(n).fontSize) < 12;
  }).map((n) => n.textContent.trim().slice(0, 30));
  const targets = [...document.querySelectorAll('button, input, a[href]')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44) && !n.closest('[aria-hidden=true]');
  }).map((n) => `${n.textContent.trim().slice(0, 24) || n.tagName}:${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const offscreen = [...document.querySelectorAll('.v5-manager-panel, .v5-manager-panel__head, .v5-notice, .v5-returns-payout, .v5-returns-actions')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5); })
    .map((n) => n.className.toString().slice(0, 40));
  const spill = [...document.querySelectorAll('.v5-returns-table-scroll, .v5-manager-panel')]
    .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.className.toString().slice(0, 40));
  const section = document.querySelector('.v5-screen-section');
  const pageScrolls = section ? section.scrollHeight > section.clientHeight + 1 : false;
  const legacy = [...document.querySelectorAll('[class]')].flatMap((n) => [...n.classList]).filter((c) => c.startsWith('rt-'));
  const a = document.activeElement;
  const focus = a ? (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 40) : null;
  return { small, targets, overflowX, offscreen, spill, pageScrolls, legacy, focus };
}

async function captureOne(browser, state, w, mode) {
  const page = await browser.newPage({ viewport: { width: +w, height: SIZES[w] }, bypassCSP: true });
  try {
    if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#/dev/returns-proof?state=${state}`);
    try { await drive(page, state); } catch (e) { errors.push(`drive: ${e.message.split('\n')[0]}`); }
    const file = `rt660-${state}-${w}x${SIZES[w]}${mode === 'forced' ? '-forced' : ''}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    let axe = [];
    if (mode === 'light') {
      await page.addScriptTag({ path: AXE });
      axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id}(${v.nodes.length})`));
    }
    const c = await page.evaluate(checks);
    return { state, width: +w, mode, file, axe, ...c, errors };
  } finally {
    await page.close();
  }
}

/** The checks a capture failed, by name; empty when it passed every one. */
function failures(r) {
  const failed = {
    errors: r.errors.length > 0, axe: r.axe.length > 0, targets: r.targets.length > 0, small: r.small.length > 0,
    overflowX: r.overflowX, offscreen: r.offscreen.length > 0, spill: r.spill.length > 0,
    pageScrolls: r.pageScrolls, legacy: r.legacy.length > 0,
  };
  return Object.keys(failed).filter((k) => failed[k]);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  try {
    for (const state of STATES) {
      for (const w of Object.keys(SIZES)) {
        for (const mode of ['light', 'forced']) {
          const r = await captureOne(browser, state, w, mode);
          const failed = failures(r);
          log.push({ ...r, failed });
          console.log(failed.length ? 'FAIL' : 'PASS', state, w, mode, JSON.stringify({ failed, axe: r.axe, t: r.targets, s: r.small.length, o: r.offscreen, sp: r.spill, x: r.overflowX, scroll: r.pageScrolls, legacy: r.legacy.length, f: r.focus, e: r.errors }));
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'rt660-capture-log.json'), JSON.stringify(log, null, 2));
  const bad = log.filter((r) => r.failed.length > 0);
  if (bad.length > 0) {
    console.error(`${bad.length} of ${log.length} captures failed a check`);
    process.exitCode = 1;
  }
})().catch((e) => { console.error(e); process.exit(1); });
