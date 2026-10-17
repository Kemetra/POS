// RT-658 — writes compare.html: every capture beside its frozen G-2 reference, with width and mode
// filters. The references are the owner-approved G-2 pack captures, linked in place (not copied).
// Usage (repo root): node docs/design/vnext/captures/RT-658/tools/build-compare.cjs
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..');
const REF = '../../visual-acceptance/G2-Shift/captures';
const SIZES = { 1024: 768, 1280: 800 };
const STATES = [
  ['Open', 'فتح وردية'],
  ['OpenInvalid', 'فتح وردية: مبلغ غير صالح'],
  ['Opened', 'فُتحت الوردية'],
  ['Status', 'وردية مفتوحة: الملخص والإغلاق'],
  ['PayIn', 'إيداع نقدي'],
  ['PayOut', 'سحب نقدي'],
  ['PayOutRefused', 'سحب نقدي غير مقبول'],
  ['Recorded', 'سُجّل الإيداع'],
  ['CloseCount', 'إغلاق الوردية: العدّ قبل التسجيل'],
  ['CloseApproval', 'إغلاق الوردية: موافقة المدير'],
  ['Closed', 'أُغلقت الوردية'],
  ['ClosedApproved', 'أُغلقت الوردية بفرق معتمد'],
  ['ParkedBlocked', 'إغلاق الوردية مرفوض: مبيعات معلّقة'],
  ['Unavailable', 'تعذّرت قراءة حالة الوردية'],
  ['MgrOpen', 'حالة الوردية: وردية مفتوحة'],
  ['MgrNoShift', 'حالة الوردية: لا توجد وردية'],
  ['MgrStranded', 'حالة الوردية: سجلات من إقران سابق'],
  ['MgrPinSaved', 'حُفظ الرقم السري'],
  ['MgrPinError', 'الرقمان غير متطابقين'],
  ['MgrUnavailable', 'تعذّرت قراءة حالة الوردية (المدير)'],
];

function section(key, title, w, mode) {
  const h = SIZES[w];
  const mine = `rt658-${key}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
  const ref = `${REF}/G2-${key}-${w}-${mode}.png`;
  const label = mode === 'forced' ? 'forced colours' : 'light';
  return (
    `<section data-w="${w}" data-m="${mode}"><h2>${key} · <span lang="ar" dir="rtl">${title}</span> · ${w}×${h} · ${label}</h2>` +
    '<div class="pair">' +
    `<figure><figcaption>Implementation (RT-658)</figcaption><img loading="lazy" src="${mine}" alt="${key} implementation"></figure>` +
    `<figure><figcaption>Frozen reference (G-2)</figcaption><img loading="lazy" src="${ref}" alt="${key} reference"></figure>` +
    '</div></section>'
  );
}

const sections = STATES.flatMap(([key, title]) =>
  ['1024', '1280'].flatMap((w) => ['light', 'forced'].map((m) => section(key, title, w, m))),
).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RT-658 shift screens vs G-2</title>
<style>
:root { color-scheme: light; --ink:#0f1d2e; --muted:#53647a; --line:#d8dfe7; --bg:#f7f9fa; }
body { margin:0; padding:16px; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
header { position:sticky; top:0; z-index:1; background:var(--bg); padding-block:8px; border-bottom:1px solid var(--line); }
label { margin-inline-end:16px; }
section { margin-block:24px; }
h2 { font-size:15px; margin:0 0 8px; }
.d { margin:0; color:var(--muted); }
.pair { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
figure { margin:0; }
figcaption { color:var(--muted); font-size:12px; }
img { width:100%; height:auto; border:1px solid var(--line); }
</style>
</head>
<body>
<header>
<strong>RT-658 shift screens: implementation vs the frozen G-2 references</strong><br>
<span class="d">The references were drawn before the RT-604 status indicator; the nav footer in the captures shows it. See README.</span><br>
<label>Width <select id="w"><option value="all">all</option><option>1024</option><option>1280</option></select></label>
<label>Mode <select id="m"><option value="all">all</option><option value="light">light</option><option value="forced">forced colours</option></select></label>
</header>
${sections}
<script>
const pick = () => {
  const w = document.getElementById('w').value;
  const m = document.getElementById('m').value;
  for (const s of document.querySelectorAll('section')) {
    s.hidden = (w !== 'all' && s.dataset.w !== w) || (m !== 'all' && s.dataset.m !== m);
  }
};
document.getElementById('w').addEventListener('change', pick);
document.getElementById('m').addEventListener('change', pick);
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT, 'compare.html'), html);
console.log(`[OK] compare.html: ${STATES.length * 4} pairs`);
