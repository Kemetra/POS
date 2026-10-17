// RT-659 — build compare.html from the capture log: each capture next to its owner-approved G-6
// addendum reference (G6P-Receipt-Preview, option A), same state, width and mode. References are
// linked from where they live; nothing is copied. Usage (repo root):
//   node docs/design/vnext/captures/RT-659/tools/build-compare.cjs
const fs = require('fs');
const dir = 'docs/design/vnext/captures/RT-659';
const log = JSON.parse(fs.readFileSync(`${dir}/rt659-capture-log.json`, 'utf8'));
const REF = { Ready: 'A-Ready', Loading: 'Loading', Failed: 'Failed' };
const DESC = {
  Ready: 'preview answered: the engine slip in the «الإيصال» region; «إغلاق» only (option A)',
  Loading: 'preview not answered yet: «جارٍ التحضير»',
  Failed: 'preview refused: «تعذّرت معاينة الإيصال»; still closable',
};
const fig = (src, cap) => `<figure><figcaption>${cap}</figcaption><img loading="lazy" src="${src}" alt="${cap}"></figure>`;
const sections = log.map((e) => {
  const h = e.width === 1024 ? 768 : 800;
  const mode = e.mode === 'forced' ? 'forced' : 'light';
  const ref = `../../visual-acceptance/G6P-Receipt-Preview/captures/G6P-${REF[e.name]}-${e.width}-${mode}.png`;
  return `<section data-w="${e.width}" data-m="${e.mode}"><h2>${e.name} · ${e.width}×${h} · ${mode === 'forced' ? 'forced colours' : 'light'}</h2><p class="d">${DESC[e.name]}</p><div class="pair">${fig(e.file, 'Implementation (RT-659)')}${fig(ref, `G6P-${REF[e.name]} ${e.width} (owner-approved 2026-10-17)`)}</div></section>`;
}).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RT-659 receipt preview vs references</title>
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
img { width:100%; height:auto; border:1px solid var(--line); }
</style>
</head>
<body>
<header>
<strong>RT-659 receipt preview as a V5 Dialog (option A): implementation vs the G-6 addendum</strong><br>
<span class="d">The references draw the G-6 frame without the RT-542 store history panel, which main now shows above the lookup; the dialog is the comparison. See README.</span><br>
<label>Width <select id="w"><option value="all">all</option><option>1024</option><option>1280</option></select></label>
<label>Mode <select id="m"><option value="all">all</option><option value="light">light</option><option value="forced">forced colours</option></select></label>
</header>
${sections}
<script>
const f = () => { const w = document.getElementById('w').value, m = document.getElementById('m').value;
  document.querySelectorAll('section').forEach((s) => { s.hidden = (w !== 'all' && s.dataset.w !== w) || (m !== 'all' && s.dataset.m !== m); }); };
['w', 'm'].forEach((id) => document.getElementById(id).addEventListener('change', f));
</script>
</body>
</html>
`;
fs.writeFileSync(`${dir}/compare.html`, html);
console.log('sections', log.length);
