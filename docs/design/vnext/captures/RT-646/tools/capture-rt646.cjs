// RT-646 — capture the count-aware sync copy from the RT-604 / RT-605 DEV harness
// (#/dev/status-proof?state=<State>&count=<n>) in the labelled nav panel (/app/dashboard):
// the indicator's M-O2 and S16 rows and the M-O3 banner, at counts 1, 2, 3 and 11,
// 1024×768 and 1280×800, light. Runs axe and checks the rendered text and the number run.
// Usage (repo root, with `npm run dev:vite` running):
//   node docs/design/vnext/captures/RT-646/tools/capture-rt646.cjs <outDir> [baseUrl]
// Browser: PLAYWRIGHT_CORE (module path) and CHROMIUM_PATH (executable) override the cloud-session
// defaults below. Exits non-zero on a text mismatch, an axe violation or a page error.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const AXE = require.resolve('axe-core/axe.min.js', { paths: [process.cwd()] });
const [outDir, base = 'http://localhost:5173'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SIZES = { 1024: 768, 1280: 800 };
const COUNTS = [1, 2, 3, 11];
// [capture name, harness state, expected sync row (n → text), expected M-O3 banner (n → text) or null]
const CASES = [
  ['Waiting-MO2', 'OfflinePending', {
    1: 'عملية واحدة بانتظار الإرسال', 2: 'عمليتان بانتظار الإرسال',
    3: '3 عمليات بانتظار الإرسال', 11: '11 عملية بانتظار الإرسال' }, null],
  ['Sending-S16', 'Sending', {
    1: 'جارٍ إرسال عملية واحدة…', 2: 'جارٍ إرسال عمليتين…',
    3: 'جارٍ إرسال 3 عمليات…', 11: 'جارٍ إرسال 11 عملية…' }, null],
  ['Attention-MO3', 'Attention', { 1: 'تحتاج مراجعة', 2: 'تحتاج مراجعة', 3: 'تحتاج مراجعة', 11: 'تحتاج مراجعة' }, {
    1: 'تعذّر إرسال عملية واحدة. راجع المدير.', 2: 'تعذّر إرسال عمليتين. راجع المدير.',
    3: 'تعذّر إرسال 3 عمليات. راجع المدير.', 11: 'تعذّر إرسال 11 عملية. راجع المدير.' }],
];

function read() {
  const sync = document.querySelector('[data-testid=v5-status-indicator] [data-row=sync]');
  const banner = document.querySelector('[data-testid=v5-sync-attention-banner]');
  const num = (el) => {
    const n = el && el.querySelector('[dir=ltr]');
    return n ? n.textContent.trim() : null;
  };
  return {
    sync: sync ? sync.textContent.trim() : null,
    syncNum: num(sync),
    banner: banner ? banner.textContent.trim() : null,
    bannerNum: num(banner),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const log = [];
  let failed = 0;
  for (const [name, state, syncText, bannerText] of CASES) {
    for (const n of COUNTS) {
      for (const [w, h] of Object.entries(SIZES)) {
        const page = await browser.newPage({ viewport: { width: +w, height: h }, bypassCSP: true });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#/dev/status-proof?state=${state}&count=${n}&path=/app/dashboard`);
        await page.waitForSelector('[data-testid=v5-status-indicator] [data-row=sync]');
        await page.waitForTimeout(1300);
        const file = `rt646-${name}-n${n}-${w}x${h}.png`;
        await page.screenshot({ path: path.join(outDir, file) });
        await page.addScriptTag({ path: AXE });
        const axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
          .violations.map((v) => `${v.id}(${v.nodes.length})`));
        const r = await page.evaluate(read);
        // 1 and 2 are words (no number run); 3 and 11 carry the count as an LTR run.
        const wantNum = n > 2 ? String(n) : null;
        const ok = r.sync === syncText[n]
          && (bannerText === null ? r.banner === null : r.banner === bannerText[n] && r.bannerNum === wantNum)
          && (state === 'Attention' || r.syncNum === wantNum)
          && axe.length === 0 && errors.length === 0 && !r.overflowX;
        if (!ok) failed += 1;
        log.push({ name, state, count: n, width: +w, file, ok, axe, ...r, errors });
        console.log(ok ? 'ok  ' : 'FAIL', file, JSON.stringify({ sync: r.sync, banner: r.banner, axe, errors }));
        await page.close();
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'rt646-capture-log.json'), `${JSON.stringify(log, null, 2)}\n`);
  await browser.close();
  if (failed > 0) { console.error(`${failed} capture(s) failed`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
