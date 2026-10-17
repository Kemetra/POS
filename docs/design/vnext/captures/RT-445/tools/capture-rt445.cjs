// RT-445 — capture every PK-3 state from the DEV park harness (#/dev/park-proof) at 1024×768 and
// 1280×800, light and forced-colors, and run axe + the fit / target / focus checks on each.
// Usage (repo root, with `npm run dev:vite` running): node docs/design/vnext/captures/RT-445/tools/capture-rt445.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const STATES = ['SaleReady','SaleEmpty','ParkDialog','ParkLabel','ParkInvalid','ParkSaving','ParkLimit','Parked',
  'ListEmpty','ListOne','ListFive','ListStale','ReviewPrice','ReviewRemoved','ReviewMixed','ConflictClean',
  'ConflictChanges','RefCatalogue','RefChanged','RefCheckout','ShiftClose'];
const LABEL = 'ينتظر المحفظة';

async function drive(page, state) {
  const parkBtn = () => page.locator('.v5-park-btn--park');
  const dialog = () => page.getByRole('dialog');
  if (state === 'SaleReady') await parkBtn().focus();
  if (state.startsWith('Park') || state === 'Parked') {
    await parkBtn().click();
    if (state !== 'ParkDialog') await dialog().locator('input').fill(LABEL);
    if (!['ParkDialog', 'ParkLabel'].includes(state)) await dialog().locator('button[type=submit]').click();
  }
  if (state.startsWith('Review') || state.startsWith('Conflict') || state.startsWith('Ref')) {
    await page.locator('.v5-park-row button').first().click();
    await page.waitForSelector('#v5-park-review-title');
    if (state === 'RefChanged') {
      await page.locator('.v5-park-btn--primary').click();
      await page.waitForTimeout(300);
    }
  }
  if (state === 'ShiftClose') {
    await page.locator('[data-testid=shift-close-panel] input').fill('2450.00');
    await page.locator('[data-testid=shift-close-panel] .v5-shift-btn--primary').click();
    await page.waitForSelector('[data-testid=shift-parked-block]');
    await page.locator('[data-testid=shift-close-panel] .v5-shift-btn--primary').focus();
  }
  await page.waitForTimeout(400);
}

function checks() {
  const out = {};
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
  const offscreen = [...document.querySelectorAll('.v5-park-panel, .v5-park-head, [role=dialog], .v5-park-btn, .v5-sale-checkout, .v5-live-void')]
    .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.bottom > window.innerHeight + 0.5 || r.right > window.innerWidth + 0.5 || r.left < -0.5); })
    .map((n) => n.className.toString().slice(0, 40));
  const dialog = document.querySelector('[aria-modal="true"]');
  const focus = document.activeElement ? (document.activeElement.textContent || document.activeElement.tagName).trim().slice(0, 30) : null;
  Object.assign(out, { small, targets, overflowX, offscreen, dialogOpen: !!dialog, focus });
  return out;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const state of STATES) {
    for (const [w, h] of Object.entries(SIZES)) {
      for (const mode of ['light', 'forced']) {
        const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#/dev/park-proof?state=${state}`);
        await page.waitForTimeout(900);
        try { await drive(page, state); } catch (e) { errors.push(`drive: ${e.message.split('\n')[0]}`); }
        const file = `rt445-${state}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        let axe = [];
        if (mode === 'light') {
          await page.addScriptTag({ path: AXE });
          axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id}(${v.nodes.length})`));
        }
        const c = await page.evaluate(checks);
        log.push({ state, width: +w, mode, file, axe, ...c, errors });
        console.log(state, w, mode, JSON.stringify({ axe, t: c.targets, s: c.small.length, o: c.offscreen, x: c.overflowX, f: c.focus, e: errors }));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt445-capture-log.json'), JSON.stringify(log, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
