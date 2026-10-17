// RT-605 — capture each status-banner state from the DEV harness (#/dev/status-proof) in the
// labelled nav panel (/app/dashboard) and the slim rail (/app/cart), at 1024×768 and 1280×800,
// light and forced-colors, and run axe plus the stack / fit / type checks on each.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-605/tools/capture-rt605.cjs <outDir> [baseUrl]
// Browser: PLAYWRIGHT_CORE (module path) and CHROMIUM_PATH (executable) override the cloud-session
// defaults below; the repo declares no Playwright dependency, so point them at a local install.
// Each case waits for its expected banner stack and exits non-zero on a mismatch or a page error.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SIZES = { 1024: 768, 1280: 800 };
const ATT = 'v5-sync-attention-banner', SHIFT = 'shift-closed-banner', OFF = 'v5-offline-banner', PRN = 'printer-failure-banner';
// The banner stack each case must show, top to bottom (doc 24 §4.3).
const EXPECTED = {
  Offline: [OFF], Degraded: [OFF], AttentionDeadLetter: [ATT], Attention24h: [ATT],
  OfflineAttention: [ATT, OFF], OfflineAttentionPrinter: [ATT, OFF, PRN],
  ShiftClosed: [SHIFT], PrinterFailed: [PRN], FullStack: [ATT, SHIFT, OFF, PRN],
};
// [capture name, harness state, extra query]
const CASES = [
  ['Offline', 'Offline', ''],
  ['Degraded', 'Degraded', ''],
  ['AttentionDeadLetter', 'Attention', ''],
  ['Attention24h', 'Attention24h', ''],
  ['OfflineAttention', 'OfflineAttention', ''],
  ['OfflineAttentionPrinter', 'OfflineAttention', '&banner=printer'],
  // Owner scope extension (2026-10-17): the two legacy banners on the V5 Banner.
  ['ShiftClosed', 'Connected', '&closed=shift'],
  ['PrinterFailed', 'PrinterFailed', ''],
  ['FullStack', 'OfflineAttention', '&banner=printer&closed=shift'],
];
const NAVS = { panel: '/app/dashboard', slim: '/app/cart' };

function checks() {
  const aside = document.querySelector('[data-testid=v5-frame-notices]');
  const main = document.querySelector('main');
  const ids = { attention: 'v5-sync-attention-banner', shiftClosed: 'shift-closed-banner',
    offline: 'v5-offline-banner', printer: 'printer-failure-banner' };
  const banners = Object.fromEntries(Object.entries(ids).map(([k, id]) => {
    const el = document.querySelector(`[data-testid=${id}]`);
    if (!el) return [k, null];
    const r = el.getBoundingClientRect();
    return [k, { text: el.textContent.trim(), role: el.getAttribute('role'), live: el.getAttribute('aria-live'),
      tone: el.dataset.tone || null, inAside: !!aside && aside.contains(el),
      onScreen: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5 }];
  }));
  // DOM order of the stack entries that are present.
  const order = [...(aside ? aside.querySelectorAll('[data-testid]') : [])]
    .map((el) => el.dataset.testid).filter((id) => Object.values(ids).includes(id));
  const small = aside ? [...aside.querySelectorAll('*')].filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && parseFloat(getComputedStyle(el).fontSize) < 12;
  }).length : 0;
  const m = main ? main.getBoundingClientRect() : null;
  const mainVisible = m ? Math.max(0, Math.min(m.bottom, window.innerHeight) - Math.max(m.top, 0)) : 0;
  const offlineTexts = [...document.querySelectorAll('body *')].filter((el) =>
    [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.includes('غير متصل —'))).length;
  const legacy007 = !!document.querySelector('.status-banner');
  const legacyClasses = !!document.querySelector('.shift-closed-banner, .printer-failure-banner, .v4-row, [data-testid=printer-failure-banner] .btn');
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return { banners, order, small, mainVisible: Math.round(mainVisible), offlineTexts, legacy007, legacyClasses, overflowX };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  const failures = [];
  for (const [name, state, extra] of CASES) {
    for (const [nav, route] of Object.entries(NAVS)) {
      for (const [w, h] of Object.entries(SIZES)) {
        for (const mode of ['light', 'forced']) {
          const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
          if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${base}/#/dev/status-proof?state=${state}${extra}&path=${route}`);
          await page.waitForSelector('[data-testid=v5-status-indicator]');
          const want = EXPECTED[name];
          // Retry until the stack matches; settle fonts before the screenshot.
          await page.waitForFunction((ids) => {
            const aside = document.querySelector('[data-testid=v5-frame-notices]');
            const got = [...(aside ? aside.querySelectorAll('[data-testid]') : [])]
              .map((el) => el.dataset.testid).filter((id) => ids.all.includes(id));
            return JSON.stringify(got) === JSON.stringify(ids.want);
          }, { want, all: [ATT, SHIFT, OFF, PRN] }, { timeout: 10000 }).catch(() => undefined);
          await page.evaluate(() => document.fonts.ready);
          const file = `rt605-${name}-${nav}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
          await page.screenshot({ path: path.join(outDir, file) });
          let axe = [];
          if (mode === 'light') {
            await page.addScriptTag({ path: AXE });
            axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
              .violations.map((v) => `${v.id}(${v.nodes.length})`));
          }
          const c = await page.evaluate(checks);
          log.push({ name, state, nav, width: +w, mode, file, axe, ...c, errors });
          const ok = JSON.stringify(c.order) === JSON.stringify(want) && errors.length === 0
            && !c.legacy007 && !c.legacyClasses && axe.length === 0;
          if (!ok) failures.push(file);
          console.log(name, nav, w, mode, JSON.stringify({ axe, order: c.order, lc: c.legacyClasses, main: c.mainVisible, off: c.offlineTexts, s: c.small, x: c.overflowX, e: errors }));
          await page.close();
        }
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt605-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length}):`, failures.join(', '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
