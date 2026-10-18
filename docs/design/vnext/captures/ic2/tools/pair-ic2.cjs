// RT-695 — lay each before/after capture from capture-ic2.cjs side by side in one PNG, before
// (main) on the left and after (IC-2) on the right, each at 1:1, under a one-line caption.
// Usage (repo root): node docs/design/vnext/captures/ic2/tools/pair-ic2.cjs <rawDir> <outDir> <mainSha>
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
const [rawDir, outDir, sha = 'main'] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const GAP = 16;
const CAPTION = 36;

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const before = JSON.parse(fs.readFileSync(path.join(rawDir, 'before-log.json'), 'utf-8'));
  const after = JSON.parse(fs.readFileSync(path.join(rawDir, 'after-log.json'), 'utf-8'));
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const pairs = [];
  try {
    for (const b of before) {
      const a = after.find((e) => e.case === b.case && e.viewport === b.viewport && e.forced === b.forced);
      if (!a) throw new Error(`no after capture for ${b.file}`);
      const [w, h] = b.viewport.split('x').map(Number);
      const page = await browser.newPage({ viewport: { width: w * 2 + GAP * 3, height: h + CAPTION + GAP * 2 } });
      const src = (f) => `data:image/png;base64,${fs.readFileSync(path.join(rawDir, f)).toString('base64')}`;
      const mode = b.forced ? 'forced colours' : 'light';
      await page.setContent(`<!doctype html><body style="margin:0;padding:${GAP}px;background:#5b6470;font:600 15px system-ui;color:#fff">
        <div style="display:flex;gap:${GAP}px">
          <figure style="margin:0"><figcaption style="height:${CAPTION}px">BEFORE · main ${sha} · ${b.case} · ${b.viewport} · ${mode}</figcaption><img src="${src(b.file)}" width="${w}" height="${h}" style="display:block"></figure>
          <figure style="margin:0"><figcaption style="height:${CAPTION}px">AFTER · IC-2 (RT-695) · ${b.case} · ${b.viewport} · ${mode}</figcaption><img src="${src(a.file)}" width="${w}" height="${h}" style="display:block"></figure>
        </div></body>`);
      const file = `ic2-${b.case}-${b.viewport}${b.forced ? '-forced' : ''}.png`;
      await page.screenshot({ path: path.join(outDir, file) });
      await page.close();
      pairs.push({ file, case: b.case, viewport: b.viewport, forced: b.forced,
        glyphs: { before: b.glyphs, after: a.glyphs }, axe: { before: b.axe, after: a.axe },
        errors: { before: b.errors, after: a.errors } });
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'ic2-capture-log.json'), JSON.stringify(pairs, null, 2) + '\n');
  console.log(`${pairs.length} pairs`);
})();
