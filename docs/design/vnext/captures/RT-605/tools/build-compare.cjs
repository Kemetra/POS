// RT-605 — build compare.html from the capture log: each capture next to its frozen reference
// where one exists (I3-Offline at 1024/1280, VN-R7 at 1024), or a plain "no frozen reference" note.
// References are linked from where they already live (RT-604's rasterised I3 PNGs and the RT-104
// references folder); nothing is copied. Usage (repo root):
//   node docs/design/vnext/captures/RT-605/tools/build-compare.cjs
const fs = require('fs');
const dir = 'docs/design/vnext/captures/RT-605';
const log = JSON.parse(fs.readFileSync(`${dir}/rt605-capture-log.json`, 'utf8'));
const DESC = {
  Offline: 'offline, nothing pending → M-O1 warning only',
  Degraded: 'degraded, shown as offline (D-6-2) → M-O1 warning only',
  AttentionDeadLetter: 'online, 2 dead letters → M-O3 danger «تعذّر إرسال 2 عمليات. راجع المدير.»',
  Attention24h: 'online, 2 pending, oldest 26 h old, no dead letter (D-6-5) → M-O3 danger with n = 2',
  OfflineAttention: 'offline, 1 dead letter + 2 fresh pending → M-O3 (n = 1) above M-O1',
  OfflineAttentionPrinter: 'as OfflineAttention, plus the printer-failure banner (now a V5 warning Banner) below M-O1',
  ShiftClosed: 'forced shift close while away: V5 info banner, M-W4 copy (pending owner approval) with «إخفاء»',
  PrinterFailed: 'last print failed: V5 warning banner, printer glyph, copy and actions unchanged',
  FullStack: 'M-O3, shift closed (M-W4), M-O1, printer failure: the whole §4.3 order',
};
const offlineLike = (n) => n.startsWith('Offline') || n === 'Degraded';
const printerLike = (n) => n === 'PrinterFailed';
function refs(name, width) {
  if (printerLike(name)) {
    const r = [[`references/I3-Receipt-${width}.png`, `I3-Receipt ${width} (doc 15 B3 iteration 3, frozen; completion surface, M-C3)`]];
    if (width === 1280) r.push(['../../references/VN-R5-complete-print-failed-1280.png', 'VN-R5 print failed 1280 (RT-104)']);
    return r;
  }
  if (!offlineLike(name) || name === 'FullStack') return [];
  const r = [[`../RT-604/references/I3-Offline-${width}.png`, `I3-Offline ${width} (doc 15 B3 iteration 3, frozen)`]];
  if (width === 1024) r.push(['../../references/VN-R7-offline-selling-1024.png', 'VN-R7 offline selling 1024 (RT-104)']);
  return r;
}
const fig = (src, cap) => `<figure><figcaption>${cap}</figcaption><img loading="lazy" src="${src}" alt="${cap}"></figure>`;
const sections = log.map((e) => {
  const navName = e.nav === 'panel' ? 'labelled panel' : 'slim rail';
  const h = e.width === 1024 ? 768 : 800;
  const r = refs(e.name, e.width);
  const right = r.length ? r.map(([s, c]) => fig(s, c)).join('')
    : '<figure class="none"><figcaption>Frozen reference</figcaption><p>No frozen reference exists for this banner state (see README).</p></figure>';
  return `<section data-w="${e.width}" data-m="${e.mode}" data-n="${e.nav}"><h2>${e.name} · ${navName} · ${e.width}×${h} · ${e.mode === 'forced' ? 'forced colours' : 'light'}</h2><p class="d">${DESC[e.name]}</p><div class="pair">${fig(e.file, 'Implementation (RT-605)')}${right}</div></section>`;
}).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RT-605 banners vs references</title>
<style>
:root { color-scheme: light; --ink:#0f1d2e; --muted:#53647a; --line:#d8dfe7; --bg:#f7f9fa; }
body { margin:0; padding:16px; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
header { position:sticky; top:0; z-index:1; background:var(--bg); padding-block:8px; border-bottom:1px solid var(--line); }
label { margin-inline-end:16px; }
section { margin-block:24px; }
h2 { font-size:15px; margin:0; }
.d { margin:0 0 8px; color:var(--muted); }
.pair { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
figure { margin:0; }
figcaption { color:var(--muted); font-size:12px; }
.none p { padding:16px; border:1px dashed var(--line); color:var(--muted); }
img { width:100%; height:auto; border:1px solid var(--line); }
</style>
</head>
<body>
<header>
<strong>RT-605 notices stack (M-O1, M-O3, shift closed, printer failure): implementation vs frozen references</strong><br>
<span class="d">The I3-Offline / VN-R7 references draw the pre-V5 frame and older copy; the implementation follows doc 24 §4.3 with the frozen doc 15 M-O1 / M-O3 copy. I3-Receipt / VN-R5 show the receipt failure on the completion surface, not the frame banner. No frozen reference exists for M-O3, the shift-closed banner or the full stack. See README.</span><br>
<label>Width <select id="w"><option value="all">all</option><option>1024</option><option>1280</option></select></label>
<label>Mode <select id="m"><option value="all">all</option><option value="light">light</option><option value="forced">forced colours</option></select></label>
<label>Nav <select id="n"><option value="all">all</option><option value="panel">labelled panel</option><option value="slim">slim rail</option></select></label>
</header>
${sections}
<script>
const f = () => { const w = document.getElementById('w').value, m = document.getElementById('m').value, n = document.getElementById('n').value;
  document.querySelectorAll('section').forEach((s) => { s.hidden = (w !== 'all' && s.dataset.w !== w) || (m !== 'all' && s.dataset.m !== m) || (n !== 'all' && s.dataset.n !== n); }); };
['w', 'm', 'n'].forEach((id) => document.getElementById(id).addEventListener('change', f));
</script>
</body>
</html>
`;
fs.writeFileSync(`${dir}/compare.html`, html);
console.log('sections', log.length);
