// RT-832 — capture the real boot / pairing / sign-in / lock screens from the dev harness and draw
// the tenant-logo slot IN FLOW (so the real reflow shows), then annotate. Needs playwright-core and
// an installed Chromium (set PLAYWRIGHT_CORE to a playwright-core folder if it is not resolvable).
// Usage: node capture_rt832.cjs <base-url> <out-dir>
//   <base-url>  a Vite dev server for this repo, e.g. http://localhost:5832
//   Boot is not a dev-harness route. The capture needs a throwaway page, never committed:
//   src/renderer/rt832-boot.html + rt832-boot.tsx rendering <RouteLoading /> (see the spec doc §Method).
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const cfg = require('./slots.cjs');

const BASE = process.argv[2];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // e.g. ONLY=sign_in re-captures one screen
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'captures'));
if (!BASE) {
  console.error('usage: node capture_rt832.cjs <base-url> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(path.join(OUT, 'dark-not-offered'), { recursive: true });

// About 100 characters of Arabic: stands in for a long admin-entered terminal label (no length limit exists).
const LONG_LABEL = 'صيدلية النور الفرع الرئيسي مدينة نصر الطرفية رقم 3 بجوار الصراف' + ' - ' + 'صيدلية النور الفرع الرئيسي مدينة نصر الطرفية رقم 3 بجوار الصراف';

const ROUTES = {
  boot: '/rt832-boot.html',
  pairing: '/index.html#/dev/sign-in-proof?screen=pairing',
  sign_in: '/index.html#/dev/sign-in-proof?screen=sign-in',
  lock: '/index.html#/dev/sign-in-proof?screen=locked',
};

// Synthetic sample logos; each already carries the 8% clear band S2 adds.
const svg = (w, h, body) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  );
const SAMPLES = {
  square: svg(
    100,
    100,
    '<rect x="8" y="8" width="84" height="84" rx="18" fill="#17324d"/><path d="M30 62 L50 24 L70 62 Z" fill="#f2b84b"/><circle cx="50" cy="66" r="9" fill="#fff"/>',
  ),
  wide: svg(
    400,
    100,
    '<rect x="32" y="8" width="84" height="84" rx="18" fill="#17324d"/><path d="M54 62 L74 24 L94 62 Z" fill="#f2b84b"/><rect x="140" y="30" width="228" height="14" rx="7" fill="#17324d"/><rect x="140" y="56" width="150" height="14" rx="7" fill="#17324d" opacity=".55"/>',
  ),
  pale: svg(
    400,
    100,
    '<rect x="32" y="8" width="84" height="84" rx="18" fill="#f3e9b7"/><path d="M54 62 L74 24 L94 62 Z" fill="#fffbe6"/><rect x="140" y="30" width="228" height="14" rx="7" fill="#f3e9b7"/><rect x="140" y="56" width="150" height="14" rx="7" fill="#f3e9b7" opacity=".8"/>',
  ),
};

// Runs in the page. Inserts the slot in flow at the proposed spot and returns the measured boxes.
function inject({ screen, slot, sample, chip, forced, powered, cfg, longLabel }) {
  const doc = document;
  const mk = (tag, css, text) => {
    const e = doc.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  };
  const c = cfg.chip;
  const strip = screen === 'sign_in';
  const padB = strip ? c.stripPadBlock : c.cardPad;
  const padI = strip ? c.stripPadInline : c.cardPad;
  const wrap = mk('div', 'display:flex;box-sizing:content-box;flex:none;');
  wrap.setAttribute('data-rt832', 'slot-wrap');
  if (chip) {
    wrap.style.cssText += `padding:${padB}px ${padI}px;border:${c.border}px solid ${forced ? '#6b7280' : 'var(--color-border)'};border-radius:8px;background:#fff;forced-color-adjust:none;`;
  }
  const box = mk('div', `inline-size:${slot.w}px;block-size:${slot.h}px;flex:none;`);
  box.setAttribute('data-rt832', 'slot-box');
  const img = mk(
    'img',
    `inline-size:100%;block-size:100%;object-fit:contain;object-position:${slot.align === 'center' ? 'center' : 'right'} center;display:block;forced-color-adjust:none;`,
  );
  img.src = sample;
  img.alt = '';
  box.appendChild(img);
  wrap.appendChild(box);
  const pb = mk(
    'p',
    `margin:0;font-size:${cfg.poweredBy.sizePx}px;line-height:16px;color:var(--color-text-muted);text-align:center;white-space:nowrap;`,
  );
  pb.setAttribute('data-rt832', 'powered-by');
  pb.append(cfg.poweredBy.prefix + ' ');
  pb.appendChild(mk('span', 'direction:ltr;unicode-bidi:isolate;font-weight:600;', cfg.poweredBy.name));

  if (screen === 'boot') {
    const main = doc.querySelector('main');
    const status = main.firstElementChild;
    const col = mk('div', 'display:flex;flex-direction:column;align-items:center;');
    wrap.style.marginBlockEnd = slot.after + 'px';
    main.appendChild(col);
    col.appendChild(wrap);
    col.appendChild(status);
    if (powered) {
      pb.style.marginBlockStart = '24px';
      col.appendChild(pb);
    }
  } else if (screen === 'pairing') {
    const card = doc.querySelector('.v5-entry__card');
    wrap.style.justifySelf = 'start';
    card.prepend(wrap);
    if (powered) card.appendChild(pb);
  } else if (screen === 'lock') {
    const dlg = doc.querySelector('[role=dialog]');
    wrap.style.justifySelf = 'start';
    dlg.prepend(wrap);
    if (powered) {
      pb.style.paddingBlock = '12px';
      dlg.appendChild(pb);
    }
  } else {
    const bar = doc.querySelector('.v5-entry__bar');
    bar.querySelector('.v5-entry__brand').style.display = 'none';
    // The terminal label is admin free text with no length limit: the branded strip must truncate it.
    const ctx = bar.querySelector('.v5-entry__context');
    if (ctx) {
      ctx.style.cssText += 'min-inline-size:0;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;';
      if (longLabel) ctx.querySelector('bdi').textContent = longLabel;
    }
    bar.querySelector('.v5-entry__sep').style.flex = 'none';
    bar.prepend(wrap);
    if (powered) {
      pb.style.marginInlineStart = 'auto';
      pb.style.flex = 'none';
      bar.appendChild(pb);
    }
  }

  const r = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const out = {
    box: r(doc.querySelector('[data-rt832=slot-box]')),
    wrap: r(doc.querySelector('[data-rt832=slot-wrap]')),
    powered: r(doc.querySelector('[data-rt832=powered-by]')),
    scrollW: doc.documentElement.scrollWidth,
    scrollH: doc.documentElement.scrollHeight,
  };
  if (screen === 'sign_in') {
    out.bar = r(doc.querySelector('.v5-entry__bar'));
    out.lastStageControl = r([...doc.querySelectorAll('.v5-entry__stage button')].pop());
  }
  if (screen === 'pairing') out.card = r(doc.querySelector('.v5-entry__card'));
  if (screen === 'lock') out.dialog = r(doc.querySelector('[role=dialog]'));
  if (screen === 'boot') out.status = r(doc.querySelector('.v5-route-state__status'));
  return out;
}

// Runs in the page. Draws the annotation layer: slot box, the 8% clear band, outside padding, labels.
function annotate({ m, slot, screen, label, cfg }) {
  const d = document;
  const layer = d.createElement('div');
  layer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;forced-color-adjust:none;font:600 11px/1 Consolas,monospace;';
  const INK = '#d1176b';
  const rect = (x, y, w, h, st) => {
    const e = d.createElement('div');
    e.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;${st}`;
    layer.appendChild(e);
  };
  const tag = (x, y, text, anchorRight) => {
    const e = d.createElement('div');
    e.textContent = text;
    e.style.cssText = `position:absolute;left:${x}px;top:${y}px;padding:2px 4px;background:${INK};color:#fff;white-space:nowrap;border-radius:2px;direction:ltr;${anchorRight ? 'transform:translateX(-100%);' : ''}`;
    layer.appendChild(e);
    return e;
  };
  const b = m.box;
  rect(b.x, b.y, b.w, b.h, `border:1.5px solid ${INK};background:rgba(209,23,107,.07);`);
  const band = (Math.min(b.w, b.h) * cfg.clearBandPct) / 100;
  rect(b.x + band, b.y + band, b.w - 2 * band, b.h - 2 * band, `border:1px dashed ${INK};`);
  if (m.wrap.w - b.w > 1 || m.wrap.h - b.h > 1) rect(m.wrap.x, m.wrap.y, m.wrap.w, m.wrap.h, `border:1px dotted ${INK};`);
  const sizeText = `${slot.w}×${slot.h} (2x ${slot.w * 2}×${slot.h * 2}) · 8% band ${band.toFixed(1)}px`;
  if (screen === 'sign_in') {
    // the strip is only 44-48px tall: keep every tag inside it, on the inline-end side of the slot
    const t = tag(m.wrap.x - 8, m.wrap.y + m.wrap.h / 2 - 8, `${sizeText} · inline-start edge (RTL: right) →`, true);
    t.style.fontSize = '10px';
  } else {
    const ty = m.wrap.y > 40 ? m.wrap.y - 38 : m.wrap.y + m.wrap.h + 4;
    tag(m.wrap.x + m.wrap.w, ty, `${slot.w}×${slot.h}  (2x ${slot.w * 2}×${slot.h * 2})`, true);
    tag(m.wrap.x + m.wrap.w, ty + 17, `clear band ${band.toFixed(1)}px (${cfg.clearBandPct}%)`, true);
    if (screen !== 'boot') tag(m.wrap.x - 6, b.y + b.h / 2 - 8, 'inline-start edge (RTL: right)  →', true);
    else tag(b.x + b.w / 2, b.y + b.h + 4, 'centred', false);
  }
  const corner = tag(8, innerHeight - 24, label, false);
  corner.style.background = '#1f2937';
  d.body.appendChild(layer);
}

(async () => {
  const browser = await chromium.launch();
  const jsonPath = path.join(OUT, 'slot-fit.json');
  const record = ONLY && fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
  const fail = [];
  const plan = [
    ['light', 'none'],
    ['light', 'square'],
    ['light', 'wide'],
    ['light', 'lowc'],
    ['light', 'annotated'],
    ['forced', 'none'],
    ['forced', 'wide'],
    ['forced', 'annotated'],
    ['dark', 'wide'],
    ['light', 'longlabel'],
  ];
  for (const [screen, route] of Object.entries(ROUTES)) {
    if (ONLY && !ONLY.includes(screen)) continue;
    const slot = cfg.slots[screen];
    for (const vp of cfg.viewports) {
      for (const [mode, variant] of plan) {
        if (variant === 'longlabel' && screen !== 'sign_in') continue;
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        if (mode === 'forced') await page.emulateMedia({ forcedColors: 'active' });
        await page.goto(BASE + route);
        await page.waitForTimeout(1500);
        if (mode === 'dark') await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        const forced = mode === 'forced';
        const sample = variant === 'lowc' ? 'pale' : variant === 'square' || variant === 'annotated' ? 'square' : 'wide';
        const longLabel = variant === 'longlabel' ? LONG_LABEL : null;
        // forced colours: images are not forced, so a logo's contrast on Canvas is unknowable -> always the white card.
        const chip = variant === 'lowc' || (forced && variant !== 'none');
        const key = `${screen}-${vp.w}-${mode}-${variant}`;
        let m = null;
        if (variant !== 'none') {
          m = await page.evaluate(inject, { screen, slot, sample: SAMPLES[sample], chip, forced, powered: true, cfg, longLabel });
          await page.waitForTimeout(150);
          if (m.scrollW > vp.w + 0.5 || m.scrollH > vp.h + 0.5) fail.push(`${key}: page overflows ${vp.w}x${vp.h} (${m.scrollW}x${m.scrollH})`);
          const edge = (o) => o && (o.x < -0.5 || o.y < -0.5 || o.x + o.w > vp.w + 0.5 || o.y + o.h > vp.h + 0.5);
          if (edge(m.wrap) || edge(m.powered)) fail.push(`${key}: slot or powered-by leaves the viewport`);
          if (screen === 'sign_in') {
            if (m.bar.h > (vp.w === 1024 ? 44 : 48) + 0.5) fail.push(`${key}: strip grew to ${m.bar.h}px`);
            const last = m.lastStageControl;
            if (last && last.y + last.h > vp.h + 0.5) fail.push(`${key}: sign-in stage control below the fold`);
          }
          if (variant === 'annotated') {
            const label = `${slot.label} slot · ${vp.w}×${vp.h} · ${forced ? 'forced-colors' : 'light'} · sample logo`;
            await page.evaluate(annotate, { m, slot, screen, label, cfg });
          }
        }
        const file = mode === 'dark' ? path.join(OUT, 'dark-not-offered', `${key}.png`) : path.join(OUT, `${key}.png`);
        await page.screenshot({ path: file });
        record[key] = m;
        await ctx.close();
      }
    }
  }
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 1));
  await browser.close();
  if (fail.length) {
    console.error('FIT FAILURES:\n' + fail.join('\n'));
    process.exit(1);
  }
  console.log('all fit checks passed');
})();
