// RT-832 — renders RT832-Logo-Slots-Spec.html from slots.cjs and captures/slot-fit.json.
// Usage: node gen_spec.cjs   (run from anywhere; paths come from this file's own location)
const fs = require('fs');
const path = require('path');
const cfg = require('./slots.cjs');

const dir = path.join(__dirname, '..');
const fit = JSON.parse(fs.readFileSync(path.join(dir, 'captures', 'slot-fit.json'), 'utf8'));
const f1 = (n) => (Math.round(n * 10) / 10).toString();

// `contain` fit of an aspect ratio (w:h) inside the box.
const contain = (W, H, ratio) => {
  const w = Math.min(W, H * ratio);
  return { w: Math.round(w), h: Math.round(w / ratio) };
};
const chipOuter = (key, s) => {
  const c = cfg.chip;
  const pi = key === 'sign_in' ? c.stripPadInline : c.cardPad;
  const pb = key === 'sign_in' ? c.stripPadBlock : c.cardPad;
  return { w: s.w + 2 * (pi + c.border), h: s.h + 2 * (pb + c.border), pi, pb };
};

const PLACEMENT = {
  boot: 'Centred horizontally. Stacked above the loading status, with the box, a 24px gap, the status and the powered-by line (24px below the status) centred in the viewport as one stack; the stack, not the logo and status alone, is the centred unit, as the captures show.',
  pairing: 'First child of the 440px card, above the leading icon. Aligned to the inline-start edge of the card content (RTL: the right edge).',
  sign_in: 'Inline-start end of the context strip (RTL: the right end), at the strip gutter (24px at 1280, 16px at 1024). Replaces the 26px mark and the «POS Pulse» wordmark (option A, approved, §4).',
  lock: 'First child of the 440px lock dialog, above the lock head. Aligned to the inline-start edge of the dialog content (RTL: the right edge). The 56px lock glyph stays.',
};
const OUTSIDE = {
  boot: '24px to the status line; the group is vertically centred.',
  pairing: '16px to the card icon (the card grid gap); card padding 32px (28px at 1024).',
  sign_in: '14px to the strip separator (the existing strip gap); 8px above and below at 1280 (6px at 1024), because the strip stays 48px (44px).',
  lock: '12px to the lock head (the dialog grid gap); dialog padding 24px.',
};

const slotKeys = Object.keys(cfg.slots);
const rows = slotKeys
  .map((k) => {
    const s = cfg.slots[k];
    const sq = contain(s.w, s.h, 1);
    const wd = contain(s.w, s.h, 4);
    const co = chipOuter(k, s);
    return `<tr><th scope="row">${s.label}<br><code>${k}</code></th>
<td class="num">${s.w}×${s.h}</td>
<td class="num">${s.w}×${s.h}<br>${s.w * 2}×${s.h * 2}</td>
<td class="num">${sq.w}×${sq.h}</td>
<td class="num">${wd.w}×${wd.h}</td>
<td class="num">${f1((Math.min(s.w, s.h) * cfg.clearBandPct) / 100)}</td>
<td class="num">${co.w}×${co.h}<br><small>pad ${co.pb}/${co.pi} + ${cfg.chip.border}px border</small></td></tr>`;
  })
  .join('\n');

const placementRows = slotKeys
  .map((k) => `<tr><th scope="row">${cfg.slots[k].label}</th><td>${PLACEMENT[k]}</td><td>${OUTSIDE[k]}</td></tr>`)
  .join('\n');

const img = (file, cap) =>
  `<figure><a href="captures/${file}"><img src="captures/${file}" alt="${cap}" loading="lazy"></a><figcaption>${cap}</figcaption></figure>`;

const frames = slotKeys
  .map((k) => {
    const s = cfg.slots[k];
    const blocks = cfg.viewports
      .map((vp) => {
        const w = vp.w;
        const p = (m, v) => `${k}-${w}-${m}-${v}.png`;
        const m1 = fit[`${k}-${w}-light-wide`];
        const ev = [
          `slot box at (${f1(m1.box.x)}, ${f1(m1.box.y)}) ${f1(m1.box.w)}×${f1(m1.box.h)}`,
          k === 'sign_in' ? `strip ${f1(m1.bar.h)}px (unchanged)` : null,
          k === 'pairing' ? `card ${f1(m1.card.w)}×${f1(m1.card.h)}, bottom ${f1(m1.card.y + m1.card.h)} of ${vp.h}` : null,
          k === 'lock' ? `dialog ${f1(m1.dialog.w)}×${f1(m1.dialog.h)}, bottom ${f1(m1.dialog.y + m1.dialog.h)} of ${vp.h}` : null,
          `page ${m1.scrollW}×${m1.scrollH} inside ${w}×${vp.h}`,
        ]
          .filter(Boolean)
          .join(' · ');
        return `<h3>${w}×${vp.h}</h3>
<p class="ev">Measured: ${ev}.</p>
<div class="shots">
${img(p('light', 'annotated'), `${s.label} ${w} · annotated · light`)}
${img(p('forced', 'annotated'), `${s.label} ${w} · annotated · forced-colors`)}
${img(p('light', 'none'), `${s.label} ${w} · no logo (today's screen) · light`)}
${img(p('light', 'square'), `${s.label} ${w} · square logo · light`)}
${img(p('light', 'wide'), `${s.label} ${w} · 4:1 logo · light`)}
${img(p('light', 'lowc'), `${s.label} ${w} · low_contrast logo on the white card · light`)}
${img(p('forced', 'none'), `${s.label} ${w} · no logo · forced-colors`)}
${img(p('forced', 'wide'), `${s.label} ${w} · 4:1 logo on the white card · forced-colors`)}
${k === 'sign_in' ? img(p('light', 'longlabel'), `${s.label} ${w} · long terminal label (about 100 characters), truncated with an ellipsis`) : ''}
</div>
<p class="ev">Dark register, <b>not offered</b> in the pilot, for reference only: <a href="captures/dark-not-offered/${k}-${w}-dark-wide.png">${k}-${w}-dark-wide.png</a>.</p>`;
      })
      .join('\n');
    return `<section class="frame" id="${k}"><h2>${s.label} <small class="num">${k}</small></h2>
<p>Box <b class="num">${s.w}×${s.h}</b> CSS px · 1x ${s.w}×${s.h} px · 2x ${s.w * 2}×${s.h * 2} px · ${s.kind}.</p>
${blocks}</section>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APPROVED · RT-832 tenant-logo slot references</title>
<style>
:root{--primary:#0f766e;--primary-soft:#e6f4f1;--bg:#f7f9fa;--surface:#fff;--text:#0f1d2e;--muted:#53647a;--border:#d8dfe7;--warn-soft:#fdf1e0;--warn:#7d4500;--ink:#d1176b;--mono:ui-monospace,'Cascadia Code',Consolas,monospace}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 'Segoe UI',Tahoma,Arial,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
h1{margin:0 0 4px;font-size:24px}h2{margin:48px 0 8px;font-size:20px}h3{margin:20px 0 4px;font-size:16px}
p{margin:0 0 12px;max-width:80ch}

.status{margin:20px 0;padding:14px 16px;border:1px solid #a35a00;border-radius:10px;background:var(--warn-soft);color:var(--warn);font-weight:600}
.status.ok{border-color:#0f766e;background:#e6f4f1;color:#0b5b55}
code,.num{font-family:var(--mono);font-size:.9em}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border)}
th,td{padding:8px 12px;border-bottom:1px solid #e7ecf2;text-align:left;vertical-align:top}
thead th{background:#f3f6fa;font-size:13px;color:var(--muted)}
small{color:var(--muted)}
.shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.shots figure{margin:0}.shots img{display:block;width:100%;height:auto;border:1px solid var(--border)}
.shots figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.ev{font-size:13px;color:var(--muted)}
a{color:var(--primary)}a:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
ul{margin:0 0 12px;padding-left:20px}li{margin-bottom:6px}
@media (max-width:760px){.shots{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
</style>
</head>
<body><main>
<h1>RT-832 · Tenant-logo slot references</h1>
<p>Boot, pairing, sign-in header and lock, at 1024×768 and 1280×800. Feeds RT-473 OD-7 (slot pixel boxes).</p>
<div class="status ok">APPROVED 2026-10-23 (owner). The four slot boxes, sign-in option A, forced colours on an un-forced white card, and the powered-by line were signed off. Recorded on RT-832 and on RT-473 as OD-7. The receipt rendition stays PENDING OD-8. No runtime code is changed by this pack.</div>

<h2>1 · Slot table (for RT-473 S2)</h2>
<p>One box per slot, <b>the same at 1024 and 1280</b>. The S1 contract has exactly one screen rendition per (slot, scale), 8 in all, with no per-width entry, so a width-dependent box would need a contract change. 1x is the box in px; 2x serves 1.25× to 2× displays. Renditions are fitted with <code>contain</code> inside the box × scale and never above the master's native size.</p>
<table>
<thead><tr><th>Slot</th><th>Box (CSS px)</th><th>Rendition px<br>1x / 2x</th><th>Square logo<br>fitted</th><th>4:1 logo<br>fitted</th><th>8% band<br>(px, inside box)</th><th><code>low_contrast</code> card outer<br>(outside the box)</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p class="ev">Box = the rendition bounds <b>including</b> the uniform 8% clear space that S2 normalization adds. Layout spacing outside the box (below) is separate, so clear space is never applied twice. Smallest accepted masters: a square logo is at least 512×512 and a horizontal one at least 256 px tall, so a 4:1 master is at least 1024×256. Every 2x rendition above is within those: the largest 2x square fit is 240×240 (boot, 2x box 480×240), under 512, and no 2x box is taller than 240, under 256.</p>

<h2>2 · Placement and spacing (RTL)</h2>
<table><thead><tr><th>Slot</th><th>Placement</th><th>Spacing outside the box</th></tr></thead><tbody>
${placementRows}
</tbody></table>
<ul>
<li><b>Fit.</b> A square logo is fitted to the box height (centred in the boot slot; on the inline-start edge in the others). A 4:1 logo fills the box width when the box is 4:1 or wider in height terms (sign-in), and is limited by width otherwise. Logos are never cropped or stretched.</li>
<li><b>No logo.</b> The slot collapses: no placeholder, no reserved space, no powered-by line. Every screen renders exactly as it does today (the «no logo» captures are unmodified real screens). The sign-in strip keeps the «POS Pulse» wordmark.</li>
<li><b>Powered-by line (OD-12 decided: «Retail Tower»).</b> Shown only when a logo is shown. 12px muted text, «${cfg.poweredBy.prefix} <span dir="ltr">${cfg.poweredBy.name}</span>», the name isolated LTR. Boot: centred under the status, 24px below. Pairing and lock: centred at the foot of the card or dialog. Sign-in: the inline-end end of the strip. The Arabic prefix and the line are approved (2026-10-23).</li>
<li><b><code>low_contrast</code> (FR-11).</b> When the server reports <code>low_contrast</code> (contrast below 3:1 against the light surface) the logo sits on a white card: <code>#fff</code>, a 1px border, 8px radius. The card padding is <b>outside</b> the box: ${cfg.chip.cardPad}px on the card slots, ${cfg.chip.stripPadBlock}px block / ${cfg.chip.stripPadInline}px inline in the strip, so the strip stays within 48px (44px at 1024).</li>
<li><b>Forced colours.</b> Images are not recoloured by forced-colors, so a logo's contrast on <code>Canvas</code> cannot be known. The frames show the approved treatment: in forced-colors every logo sits on the white card, with <code>forced-color-adjust: none</code> on the card and a visible 1px border. This extends the shipped un-force precedent (selected and current states) to a logo card, and the owner approved it on 2026-10-23.</li>
<li><b>Long terminal label.</b> The terminal label is admin free text with no length limit, and the strip does not wrap. With a logo and the powered-by line in the strip, the label must truncate: the context gets <code>min-inline-size: 0; overflow: hidden; text-overflow: ellipsis</code> while the logo, the separator and the powered-by line stay <code>flex: none</code>. The sign-in frames include a long-label capture at both widths (no overflow asserted).</li>
<li><b>Dark.</b> Dark is not offered in the pilot (DESIGN.md, OD-4), so no dark slot is proposed. <code>low_contrast</code> is computed only against the light surface, so a logo's contrast in the dark register is unverified. The dark captures are reference only.</li>
</ul>

<h2>3 · Receipt rendition — pending OD-8</h2>
<p>Not sized here. The receipt rendition needs the printer dpi and printable width from the printer self-test, which the owner still owes. Formula only, with no chosen value: <code>width_px ≤ floor(48 / 25.4 × dpi)</code> and <code>height_px ≤ floor(15 / 25.4 × dpi)</code>, at most 48×15 mm. <b>PENDING OD-8.</b></p>

<h2>4 · Owner decisions (signed 2026-10-23)</h2>
<ol>
<li>The four boxes and their 1x/2x sizes (§1): <b>approved</b>.</li>
<li>Sign-in placement: <b>option A</b> (the logo replaces the 26px mark and the «POS Pulse» wordmark): <b>approved</b>. Option B (logo beside the wordmark) is <b>rejected</b>.</li>
<li>Forced colours: every logo on the white card, with <code>forced-color-adjust: none</code>: <b>approved</b>.</li>
<li>The powered-by line «${cfg.poweredBy.prefix} ${cfg.poweredBy.name}», shown only with a logo and never as a placeholder: <b>approved</b>.</li>
</ol>
<p>Still open: the receipt rendition, <b>PENDING OD-8</b> (§3).</p>

<h2>6 · Frames</h2>
<p>Each frame is the real screen on <code>main</code> captured from the dev harness, with the slot inserted <b>in flow</b>, so the real reflow shows. Sample logos are synthetic. Annotation: solid = box, dashed = 8% band, dotted = card padding, tags = sizes. Light and forced-colors frames are the sign-off set.</p>
${frames}

<h2>Method</h2>
<p>Screens: the real <code>SignInRoute</code>, <code>PairingScreen</code> and <code>SessionLockGate</code> through <code>#/dev/sign-in-proof</code> (<code>screen=sign-in | pairing | locked</code>), and the real <code>RouteLoading</code> for boot through a throwaway page that is not committed. The script <code>tools/capture_rt832.cjs</code> inserts the slot in flow, asserts that nothing leaves the viewport, that the sign-in strip does not grow and that the sign-in controls stay above the fold, and writes <code>captures/slot-fit.json</code>. It fails on any violation. <code>tools/gen_spec.cjs</code> renders this page from <code>tools/slots.cjs</code> and the JSON.</p>
</main></body></html>
`;
fs.writeFileSync(path.join(dir, 'RT832-Logo-Slots-Spec.html'), html);
console.log('spec written');
