// RT-605 — render the frozen I3-Receipt reference (doc 15 B3 iteration 3, HTML) to PNG at
// 1024×768 and 1280×800, so compare.html can show it next to the printer-failure captures. The
// reference is not changed; this only rasterises it (same method as RT-604's tool). Usage:
//   node docs/design/vnext/captures/RT-605/tools/render-references.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const dir = path.resolve('docs/design/vnext/visual-acceptance/B3-Critical-states-iteration-3');
  for (const [w, h] of [[1024, 768], [1280, 800]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto(pathToFileURL(path.join(dir, `I3-Receipt-${w}.html`)).href);
    await p.waitForTimeout(800);
    const dims = await p.evaluate(() => { const r = document.querySelector('.rt'); const x = r && r.getBoundingClientRect(); return x ? [x.x, x.y, x.width, x.height] : null; });
    const out = `docs/design/vnext/captures/RT-605/references/I3-Receipt-${w}.png`;
    if (dims) await p.screenshot({ path: out, fullPage: true, clip: { x: dims[0], y: dims[1], width: dims[2], height: dims[3] } });
    else await p.screenshot({ path: out, fullPage: true });
    console.log(out, dims);
    await p.close();
  }
  await b.close();
})();
