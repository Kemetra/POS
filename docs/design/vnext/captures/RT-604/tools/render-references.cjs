// RT-604 — render the frozen I3-Offline / I3-Syncing references (doc 15, B3 iteration 3, HTML)
// to PNG at 1024×768 and 1280×800, so compare.html can show them next to the captures. The
// references are not changed; this only rasterises them. Usage (repo root):
//   node docs/design/vnext/captures/RT-604/tools/render-references.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('/opt/node-tools/node_modules/playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const dir = path.resolve('docs/design/vnext/visual-acceptance/B3-Critical-states-iteration-3');
  for (const name of ['I3-Offline', 'I3-Syncing']) {
    for (const [w, h] of [[1024, 768], [1280, 800]]) {
      const p = await b.newPage({ viewport: { width: w, height: h } });
      await p.goto(pathToFileURL(path.join(dir, `${name}-${w}.html`)).href);
      await p.waitForTimeout(800);
      const dims = await p.evaluate(() => { const r = document.querySelector('.rt'); const b = r && r.getBoundingClientRect(); return b ? [b.x, b.y, b.width, b.height] : null; });
      const out = `docs/design/vnext/captures/RT-604/references/${name}-${w}.png`;
      if (dims) await p.screenshot({ path: out, fullPage: true, clip: { x: dims[0], y: dims[1], width: dims[2], height: dims[3] } });
      else await p.screenshot({ path: out, fullPage: true });
      console.log(out, dims);
      await p.close();
    }
  }
  await b.close();
})();
