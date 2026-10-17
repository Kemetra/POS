// RT-604 — capture every StatusIndicator state from the DEV harness (#/dev/status-proof) in the
// labelled nav panel (/app/dashboard) and the slim rail (/app/cart), at 1024×768 and 1280×800,
// light and forced-colors, and run axe plus the fit / target / type checks on each.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-604/tools/capture-rt604.cjs <outDir> [baseUrl]
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const SIZES = { 1024: 768, 1280: 800 };
const STATES = ['Connected', 'Checking', 'Offline', 'Degraded', 'OfflinePending', 'Sending', 'Paused',
  'Attention', 'PrinterFailed'];
const NAVS = { panel: '/app/dashboard', slim: '/app/cart' };

function checks() {
  const ind = document.querySelector('[data-testid=v5-status-indicator]');
  const nav = document.querySelector('.v5-frame__nav');
  const r = ind ? ind.getBoundingClientRect() : null;
  const n = nav ? nav.getBoundingClientRect() : null;
  const rows = ind ? [...ind.querySelectorAll('[data-row]')].map((el) => ({
    row: el.dataset.row, tone: el.dataset.tone, text: el.textContent.trim(),
  })) : [];
  // Inside the nav column, and on screen without scrolling the nav.
  const inView = !!r && r.width > 0 && r.bottom <= window.innerHeight + 0.5 && r.top >= 0;
  const inNav = !!r && !!n && r.left >= n.left - 0.5 && r.right <= n.right + 0.5;
  const navScrolls = !!nav && nav.scrollHeight > nav.clientHeight + 1;
  const small = ind ? [...ind.querySelectorAll('*')].filter((el) => {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return false;
    const b = el.getBoundingClientRect();
    return b.width > 1 && parseFloat(getComputedStyle(el).fontSize) < 12;
  }).length : 0;
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return { rows, inView, inNav, navScrolls, small, overflowX };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const log = [];
  for (const state of STATES) {
    for (const [nav, route] of Object.entries(NAVS)) {
      for (const [w, h] of Object.entries(SIZES)) {
        for (const mode of ['light', 'forced']) {
          const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
          if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${base}/#/dev/status-proof?state=${state}&path=${route}`);
          await page.waitForSelector('[data-testid=v5-status-indicator]');
          await page.waitForTimeout(1300);
          const file = `rt604-${state}-${nav}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
          await page.screenshot({ path: path.join(outDir, file) });
          let axe = [];
          if (mode === 'light') {
            await page.addScriptTag({ path: AXE });
            axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
              .violations.map((v) => `${v.id}(${v.nodes.length})`));
          }
          const c = await page.evaluate(checks);
          log.push({ state, nav, width: +w, mode, file, axe, ...c, errors });
          console.log(state, nav, w, mode, JSON.stringify({ axe, rows: c.rows.map((x) => x.text), v: c.inView, n: c.inNav, s: c.small, x: c.overflowX, e: errors }));
          await page.close();
        }
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt604-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
