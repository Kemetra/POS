// RT-654 — capture every VD-Void state from the DEV void harness (#/dev/void-proof) at 1024×768 and
// 1280×800, light and forced-colors, and run axe + the fit / target / font checks on each.
// Usage (repo root, with `npm run dev:vite` running): node docs/design/vnext/captures/RT-654/tools/capture-rt654.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const STATES = ['Lookup', 'Journal', 'Found', 'Requested', 'RefNotFound', 'RefIneligible', 'RefJournal',
  'RefServer', 'Dialog', 'DialogReady', 'DialogRefused', 'DialogNoManagers'];
const SALE = 'TERM-01-2026-10-17-000051';
const NUMBERS = { RefNotFound: 'TERM-01-2026-10-17-000999', RefIneligible: 'TERM-01-2026-10-16-000118' };

/** Presses the same visible controls a manager presses, then leaves focus where the reference draws it. */
async function drive(page, state) {
  const field = page.getByLabel('رقم البيع', { exact: true });
  const dialog = () => page.getByRole('dialog');
  if (['Lookup', 'Journal', 'RefJournal'].includes(state)) await field.focus();
  if (state === 'RefServer') await page.getByRole('button', { name: 'تم الاطلاع' }).focus();
  if (['Lookup', 'Journal', 'RefJournal', 'RefServer'].includes(state)) return;
  await field.fill(NUMBERS[state] || SALE);
  await page.getByRole('button', { name: 'بحث', exact: true }).click();
  await page.waitForTimeout(250);
  if (state === 'RefNotFound') return field.focus();
  if (state === 'Found' || state === 'RefIneligible') {
    if (state === 'Found') await page.getByRole('button', { name: 'إلغاء هذا البيع' }).focus();
    return;
  }
  await page.getByRole('button', { name: 'إلغاء هذا البيع' }).click();
  await dialog().waitFor();
  await page.waitForTimeout(250);
  if (state === 'Dialog' || state === 'DialogNoManagers') return;
  await dialog().getByLabel('خالد منصور').check();
  await dialog().getByLabel('الرقم السري للمدير').fill('135790');
  if (state === 'DialogReady') return;
  await dialog().getByRole('button', { name: 'تأكيد الإلغاء' }).click();
  await page.waitForTimeout(300);
}

function checks() {
  const small = [...document.querySelectorAll('body *')].filter((n) => {
    if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && parseFloat(getComputedStyle(n).fontSize) < 12;
  }).map((n) => n.textContent.trim().slice(0, 30));
  const box = (n) => (n.type === 'radio' && n.closest('label') ? n.closest('label') : n).getBoundingClientRect();
  const targets = [...document.querySelectorAll('button, input, a[href]')].filter((n) => {
    const r = box(n);
    return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44) && !n.closest('[aria-hidden=true]');
  }).map((n) => `${n.textContent.trim().slice(0, 24) || n.tagName}:${Math.round(box(n).width)}x${Math.round(box(n).height)}`);
  // Arabic in the monospace face is the RT-654 defect: no Arabic letter may render in a mono font.
  const monoArabic = [...document.querySelectorAll('.v5-void *, [role=dialog] *')].filter((n) =>
    [...n.childNodes].some((c) => c.nodeType === 3 && /[؀-ۿ]/.test(c.textContent)) &&
    /mono|consolas|cascadia/i.test(getComputedStyle(n).fontFamily),
  ).map((n) => n.textContent.trim().slice(0, 30));
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const offscreen = [...document.querySelectorAll('.v5-void-panel, .v5-void-panel-head, [role=dialog], .v5-void-btn')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && !n.closest('.v5-void-rows') && (r.bottom > window.innerHeight + 0.5 || r.right > window.innerWidth + 0.5 || r.left < -0.5); })
    .map((n) => n.className.toString().slice(0, 40));
  const a = document.activeElement;
  const focus = a ? (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 30) : null;
  return { small, targets, monoArabic, overflowX, offscreen, dialogOpen: !!document.querySelector('[aria-modal="true"]'), focus };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const state of STATES) {
    for (const [w, h] of Object.entries(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const ctx = await browser.newContext({ viewport: { width: +w, height: h }, bypassCSP: true, timezoneId: 'Africa/Cairo' });
        const page = await ctx.newPage();
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#/dev/void-proof?state=${state}`);
        await page.waitForSelector('.v5-void');
        await page.waitForTimeout(500);
        try { await drive(page, state); } catch (e) { errors.push(`drive: ${e.message.split('\n')[0]}`); }
        await page.waitForTimeout(350);
        const file = `rt654-${state}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        let axe = [];
        if (mode === 'light') {
          await page.addScriptTag({ path: AXE });
          axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id}(${v.nodes.length})`));
        }
        const c = await page.evaluate(checks);
        log.push({ state, width: +w, mode, file, axe, ...c, errors });
        console.log(state, w, mode, JSON.stringify({ axe, t: c.targets, s: c.small.length, m: c.monoArabic, o: c.offscreen, x: c.overflowX, f: c.focus, e: errors }));
        await ctx.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt654-capture-log.json'), JSON.stringify(log, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
