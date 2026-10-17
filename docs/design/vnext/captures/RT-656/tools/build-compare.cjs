// RT-656 — build compare.html: each capture next to its owner-approved RC reference
// (docs/design/vnext/visual-acceptance/RC-Recovery/captures), with width and mode filters.
// Usage (repo root): node docs/design/vnext/captures/RT-656/tools/build-compare.cjs
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..');
const REF = '../../visual-acceptance/RC-Recovery/captures';
// [state, what it shows]. Loading and Unavailable have references but no capture: the harness
// answers at once and never fails, so jsdom covers them (recovery-g6 / recovery-screen tests).
const STATES = [
  ['Typical', 'a stuck payment (cash 50.00 of 150.00) and four held sales, one owner not on the roster'],
  ['RecoveryMode', 'recovery-mode note; cash, card and voucher tender live'],
  ['Long', 'nine held sales, long names wrap, never cut'],
  ['Empty', 'nothing stuck, nothing held'],
  ['Refused', 'listHeld refused: role_mismatch'],
  ['Complete', '«إكمال البيع» dialog, first focus on «رجوع»'],
  ['CompleteReady', 'cash and PIN entered, «تأكيد» enabled'],
  ['CancelPayment', '«إلغاء الدفع» with both tender confirmations'],
  ['CancelPaymentReady', 'both confirmations ticked, PIN entered'],
  ['CancelSale', '«إلغاء البيع» for a held sale'],
  ['WrongPin', 'approval refused: PIN cleared, focus back in the PIN (OD-4)'],
  ['NoPin', 'the manager has no PIN on this terminal'],
  ['ApproverLocked', 'approver read refused: session_locked'],
  ['Completed', 'outcome: completed with change, the amount LTR-isolated'],
  ['CancelledPayment', 'outcome: payment cancelled'],
  ['CancelledSale', 'outcome: held sale cancelled'],
];
const SIZES = [[1024, 768], [1280, 800]];

function figure(caption, src) {
  return `<figure><figcaption>${caption}</figcaption><img loading="lazy" src="${src}" alt="${caption}"></figure>`;
}

const sections = [];
for (const [state, what] of STATES) {
  for (const [w, h] of SIZES) {
    for (const mode of ['light', 'forced']) {
      const cap = `rt656-${state}-${w}x${h}${mode === 'forced' ? '-forced' : ''}.png`;
      if (!fs.existsSync(path.join(DIR, cap))) throw new Error(`missing ${cap}`);
      const label = mode === 'forced' ? 'forced colours' : 'light';
      sections.push(
        `<section data-w="${w}" data-m="${mode}"><h2>${state} · ${w}×${h} · ${label}</h2><p class="d">${what}</p>` +
          `<div class="pair">${figure('Implementation (RT-656)', cap)}${figure(`RC-${state}-${w} reference (owner-approved)`, `${REF}/RC-${state}-${w}-${mode}.png`)}</div></section>`,
      );
    }
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RT-656 recovery vs references</title>
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
<strong>RT-656 Manager → المبيعات المعلقة: implementation vs the owner-approved RC references</strong><br>
<span class="d">Captures are the real screen in the real V5 frame (DEV harness #/dev/recovery-proof). The references draw the frame without the connection indicator, and render the brand in full at 1024; both are frame-owned, not this slice. Loading and Unavailable are covered by jsdom only. See README.</span><br>
<label>Width <select id="w"><option value="all">all</option><option>1024</option><option>1280</option></select></label>
<label>Mode <select id="m"><option value="all">all</option><option value="light">light</option><option value="forced">forced colours</option></select></label>
</header>
${sections.join('\n')}
<script>
const w = document.getElementById('w'), m = document.getElementById('m');
function apply() {
  for (const s of document.querySelectorAll('section')) {
    s.hidden = (w.value !== 'all' && s.dataset.w !== w.value) || (m.value !== 'all' && s.dataset.m !== m.value);
  }
}
w.onchange = apply; m.onchange = apply;
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(DIR, 'compare.html'), html);
console.log(`[OK] compare.html: ${sections.length} pairs`);
