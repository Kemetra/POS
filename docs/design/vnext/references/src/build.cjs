// RT-104 VNext visual references — generator + renderer.
// DESIGN REFERENCE ONLY. Produces static HTML (references/src/html/*.html) and
// PNG captures (references/*.png) at 1280×800 and 1024×768.
// Usage: node docs/design/vnext/references/src/build.cjs [path/to/playwright/index.mjs]
// CommonJS on purpose: `**/*.cjs` is outside the repo's type-checked ESLint scope,
// which this standalone design tool is not part of (see eslint.config.js).
'use strict';
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const here = __dirname;
const outHtml = join(here, 'html');
const outPng = join(here, '..');
mkdirSync(outHtml, { recursive: true });

// ── icons (inline SVG, stroke = currentColor) ───────────────────────────────
const svg = (d, extra = '') =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const I = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  scan: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  print: svg('<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M7 14h10v6H7z"/>'),
  alert: svg('<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4M12 17h.01"/>'),
  check: svg('<path d="m5 12 4.5 4.5L19 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  offline: svg('<path d="M3 3l18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.6M19 12.9a10 10 0 0 0-2.1-1.6M2 9.3a15 15 0 0 1 4.4-2.8M22 9.3A15 15 0 0 0 12 5.5"/><path d="M12 20h.01"/>'),
  back: svg('<path d="M9 6l6 6-6 6"/>'), // points to inline-end in RTL = "back to previous step"
  pause: svg('<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>'),
  shield: svg('<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
  card: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>'),
  cash: svg('<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/>'),
  db: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),
};

const money = (v) => `<span class="ltr num">${v} EGP</span>`;
const n = (v) => `<span class="ltr num">${v}</span>`;
const kbd = (k) => `<span class="kbd">${k}</span>`;

// ── frame ──────────────────────────────────────────────────────────────────
// DOM order matches V5Frame.tsx: working screen first (right in RTL), nav second (left).
const NAV = [
  ['لوحة المتابعة'],
  ['نقطة البيع', true],
  ['المبيعات'],
  ['المرتجعات'],
  ['سجل المراجعة'],
  ['المخزون'],
  ['الإعدادات'],
];
function nav(active, status) {
  const s = {
    conn: ['متصل', ''],
    sync: ['المزامنة: لا شيء معلّق', ''],
    printer: ['الطابعة جاهزة', ''],
    ...status,
  };
  const row = ([label, tone]) =>
    `<div class="si ${tone}"><span class="dot ${tone}"></span>${label}</div>`;
  return `<nav class="nav" aria-label="التنقل">
    <div class="brand"><span class="brand-mark">+</span><span class="ltr">POS Pulse</span></div>
    ${NAV.map(([l], i) => `<div class="navlink" ${l === active ? 'aria-current="page"' : ''}>${l}</div>`).join('')}
    <div class="nav-spacer"></div>
    <div class="status-cluster" aria-label="حالة الجهاز">${row(s.conn)}${row(s.sync)}${row(s.printer)}</div>
    <div class="operator"><b>منى عادل</b><span class="meta">كاشير · وردية ${n('07:58')}</span></div>
  </nav>`;
}
function page({ id, title, compact, body, navActive = 'نقطة البيع', status, overlay = '', titleExtra = '', slim = false }) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${id} — ${title}</title><link rel="stylesheet" href="../vnext-kit.css"></head>
<body class="${compact ? 'compact' : ''}"><div class="frame ${slim ? 'slim' : ''}">
<div class="main"><header class="titlebar"><h1>${title}</h1>${titleExtra}<span class="grow"></span>
<span class="ref-tag">${id} · مرجع تصميم VNext — ليس لقطة من التطبيق</span></header>
<div class="workspace">${body}</div></div>${slim ? navSlim(navActive, status) : nav(navActive, status)}</div>${overlay}</body></html>`;
}

// ── shared sale fragments ──────────────────────────────────────────────────
const LINES = [
  ['بنادول إكسترا 500 مجم — 24 قرص', 'Panadol Extra 500mg', '45.00', 2, '90.00', ''],
  ['أموكسيسيلين مع حمض الكلافولانيك 875/125 مجم أقراص مغلفة بالفيلم للاستخدام الفموي', 'Amoxicillin/Clavulanate 1g', '187.50', 1, '187.50', 'rx'],
  ['فولتارين جل 1% — 50 جم', 'Voltaren Emulgel 1%', '68.00', 1, '68.00', ''],
  ['كونجستال أقراص', 'Congestal Tablets', '29.50', 1, '29.50', ''],
];
function cartRows(lines, flashLast) {
  return lines
    .map(
      ([ar, en, unit, qty, total, flag], i) => `<div class="cart-row ${flashLast && i === lines.length - 1 ? 'flash' : ''}">
      <span class="muted">${n(i + 1)}</span>
      <div><div class="name">${ar}</div><div class="sub"><span class="ltr">${en}</span>${
        flag === 'rx' ? '<span class="flag rx">يُصرف بوصفة</span>' : ''
      }<span class="link">ملاحظة</span><span class="link" style="color:var(--color-danger-emphasis)">حذف</span></div></div>
      <span class="end muted">${money(unit)}</span>
      <span class="stepper"><span>−</span><span>${qty}</span><span>+</span></span>
      <b class="end">${money(total)}</b></div>`,
    )
    .join('');
}
function cartPanel({ lines = LINES, flash = true, frozen = false } = {}) {
  const items = lines.length;
  const units = lines.reduce((a, l) => a + l[3], 0);
  const sub = lines.reduce((a, l) => a + Math.round(Number(l[4]) * 100), 0);
  const subStr = group((sub / 100).toFixed(2));
  return `<section class="panel" style="flex:1">
    <div class="panel-head"><h2>سلة المشتريات</h2><span class="meta">${n(items)} أصناف · ${n(units)} وحدات</span>
      <span style="flex:1"></span>
      <button class="btn">${I.pause}تعليق البيع ${kbd('F4')}</button>
      <button class="btn danger-quiet">إلغاء البيع</button></div>
    <div class="cart-table"><div class="cart-head"><span>#</span><span>الصنف</span><span class="end">سعر الوحدة</span><span>الكمية</span><span class="end">الإجمالي</span></div>
    ${cartRows(lines, flash)}</div>
    <div class="totals">
      <div class="trow"><span>المجموع الفرعي</span>${money(subStr)}</div>
      <div class="trow"><span>الضريبة</span><span class="meta">قيد الإضافة · لا تُحسب هنا</span></div>
    </div>
    <div class="grand"><div class="grand-box"><b>الإجمالي الحالي</b><span class="amount ltr num">${subStr} EGP</span></div>
      <button class="btn primary lg" style="min-width:230px">الدفع ${kbd('F8')}</button></div>
  </section>`;
}

// ── R1 Sale ────────────────────────────────────────────────────────────────
function saleRail(mode) {
  const scanReady = mode === 'ready';
  const search = mode === 'search';
  return `<section class="panel" style="width:var(--rail);flex:none">
    <div class="panel-head"><h2>إضافة صنف</h2></div>
    <div class="panel-body">
      <div class="scan ${scanReady ? 'ready' : ''}">${I.scan}<div style="flex:1"><div class="scan-state">${
        scanReady
          ? '<span class="dot"></span>جاهز للمسح'
          : '<span class="dot" style="background:var(--color-border-strong)"></span>المسح متوقف أثناء البحث'
      }</div><div class="meta">${scanReady ? 'امسح الباركود في أي وقت' : `اضغط ${kbd('F2')} للعودة إلى المسح`}</div></div></div>
      <div class="label">البحث بالاسم أو الكود ${kbd('F2')}</div>
      <div class="field ${search ? 'focus' : ''}">${I.search}${search ? '<span>بنا</span>' : '<span class="ph">اكتب حرفين على الأقل…</span>'}</div>
      ${
        scanReady
          ? `<div class="notice success" role="status">${I.check}<div>أُضيف بالمسح: <b>كونجستال أقراص</b> · ${money('29.50')}</div></div>`
          : ''
      }
    </div>
    ${
      search
        ? `<div class="results" role="listbox"><div class="cart-head" style="grid-template-columns:1fr auto"><span>نتائج البحث (${n(3)})</span><span>السعر</span></div>
      <div class="result active"><div><b>بنادول إكسترا 500 مجم — 24 قرص</b><div class="meta ltr">Panadol Extra · 6221155012345</div></div>${money('45.00')}</div>
      <div class="result"><div><b>بنادول أدفانس 500 مجم</b><div class="meta ltr">Panadol Advance · 6221155012352</div></div>${money('38.00')}</div>
      <div class="result"><div><b>بنادول نايت</b><div class="meta ltr">Panadol Night · 6221155012369</div></div>${money('52.00')}</div>
      <div class="meta" style="padding:10px var(--pad)">↑ ↓ للتنقل · ${kbd('Enter')} لعرض الصنف قبل الإضافة</div></div>`
        : `<div class="results"><div class="meta" style="padding:14px var(--pad)">آخر كتالوج: اليوم ${n('13:02')} · ${n('4,812')} صنفًا</div></div>`
    }
  </section>`;
}
const saleTitleExtra = `<button class="btn ghost">المبيعات المعلّقة <span class="badge neutral">${n(2)}</span> ${kbd('F3')}</button>`;
const R1 = (compact) =>
  page({
    id: 'VN-R1',
    title: 'البيع',
    compact,
    titleExtra: saleTitleExtra,
    body: `<div style="display:flex;gap:var(--gap);flex:1;min-height:0">${saleRail(compact ? 'search' : 'ready')}${cartPanel()}</div>`,
  });

const R1long = (compact) =>
  page({
    id: 'VN-R1',
    title: 'البيع',
    compact,
    titleExtra: saleTitleExtra,
    body: `<div style="display:flex;gap:var(--gap);flex:1;min-height:0">${saleRail('ready')}${cartPanel({ lines: LONG })}</div>`,
  });

// ── R2 Checkout cash ───────────────────────────────────────────────────────
const coSteps = `<span class="steps"><span>السلة</span>›<b>الدفع</b>›<span>الإيصال</span></span>`;
function orderSummary() {
  return `<section class="panel"><div class="panel-head"><h2>ملخص الطلب</h2><span style="flex:1"></span><span class="lock-pill">${I.lock}مجمّدة أثناء الدفع</span></div>
    ${LINES.map(([ar, , , q, t]) => `<div class="sum-row"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ar}<div class="meta">× ${n(q)}</div></div><b>${money(t)}</b></div>`).join('')}
    <div class="lrow"><span>المجموع الفرعي</span>${money('375.00')}</div>
    <div class="lrow"><span>الضريبة</span><span class="meta">قيد الإضافة</span></div></section>`;
}
function tenderTiles(sel) {
  const t = (key, label, sub, k, dis) =>
    `<div class="tile" role="radio" aria-checked="${sel === key}" ${dis ? 'disabled' : ''}>${
      key === 'cash' ? I.cash : key === 'card' ? I.card : ''
    }<b>${label}</b><span class="meta">${sub}</span>${k ? kbd(k) : ''}</div>`;
  return `<div class="tiles" role="radiogroup" aria-label="طريقة الدفع">
    ${t('cash', 'نقدي', 'عملات ورقية ومعدنية')}
    ${t('card', 'بطاقة', 'جهاز البطاقة الخارجي')}
    ${t('voucher', 'قسيمة', 'غير متاحة حاليًا', '', true)}</div>`;
}
function cashEntry(received) {
  return `<div class="label">المبلغ المستلم من العميل</div>
    <div class="moneyfield"><span class="v ltr">${received}</span><span class="meta ltr">EGP</span></div>
    <div class="quick"><div class="chip exact">بالضبط ${kbd('F9')}</div><div class="chip ltr">400.00</div><div class="chip ltr">500.00</div><div class="chip ltr">1,000.00</div></div>
    <div class="meta">أزرار المبالغ تضبط المبلغ المستلم ولا تضيف إليه.</div>
    <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map((k) => `<div class="key">${k}</div>`).join('')}</div>`;
}
function ledger({ received, change, short, commitLabel, commitDisabled, reason, back = true, backReason }) {
  return `<section class="panel ledger" aria-label="حساب الدفع">
    <div class="due"><div class="label">المبلغ المستحق</div><div class="amount ltr num">375.00 EGP</div></div>
    ${received ? `<div class="lrow"><span>المستلم نقدًا</span><span class="v ltr num">${received} <small>EGP</small></span></div>` : ''}
    ${change ? `<div class="lrow change"><span>الباقي للعميل</span><span class="v ltr num">${change} <small>EGP</small></span></div>` : ''}
    ${short ? `<div class="lrow short"><span>المتبقي على العميل</span><span class="v ltr num">${short} <small>EGP</small></span></div>` : ''}
    <div class="commit">
      ${reason ? `<div class="notice warn">${I.alert}<div>${reason}</div></div>` : ''}
      <button class="btn primary lg block" ${commitDisabled ? 'disabled' : ''}>${commitLabel} ${kbd('Ctrl+Enter')}</button>
      <button class="btn block" ${back ? '' : 'disabled'}>${I.back}رجوع للسلة ${kbd('Esc')}</button>
      ${backReason ? `<div class="meta">${backReason}</div>` : ''}
      <button class="btn danger-quiet block">${I.shield}إلغاء البيع · بموافقة المسؤول</button>
    </div></section>`;
}
const R2 = (compact) => {
  const received = compact ? '300.00' : '400.00';
  const center = `<section class="panel"><div class="panel-head"><h2>طريقة الدفع</h2></div><div class="panel-body">${tenderTiles('cash')}${cashEntry(received)}</div></section>`;
  const led = compact
    ? ledger({ received: '300.00', short: '75.00', commitLabel: 'تأكيد الدفع النقدي', commitDisabled: true, reason: 'المبلغ المستلم أقل من المستحق بـ <b class="ltr num">75.00 EGP</b>.' })
    : ledger({ received: '400.00', change: '25.00', commitLabel: 'تأكيد الدفع النقدي' });
  const strip = `<div class="strip"><span class="lock-pill">${I.lock}مجمّدة</span><b>${n(4)} أصناف · ${n(5)} وحدات</b><span class="meta">المجموع الفرعي ${money('375.00')}</span><span style="flex:1"></span><span class="link">عرض الأصناف</span></div>`;
  return page({
    id: 'VN-R2',
    title: 'الدفع',
    compact,
    titleExtra: coSteps,
    body: compact
      ? `${strip}<div class="co-grid">${center}${led}</div>`
      : `<div class="co-grid">${orderSummary()}${center}${led}</div>`,
  });
};

// ── R3 Card UNKNOWN recovery ───────────────────────────────────────────────
const R3 = () => {
  const center = `<section class="panel"><div class="panel-head"><h2>طريقة الدفع</h2><span style="flex:1"></span><span class="lock-pill">${I.lock}مقفلة حتى التحقق</span></div>
  <div class="panel-body">
    <div class="notice danger" style="padding:14px">${I.alert}<div><b style="font-size:16px">نتيجة الدفع بالبطاقة غير مؤكدة</b><br>
      لم يُسجَّل ما أظهره جهاز البطاقة لمحاولة ${money('375.00')} الساعة ${n('14:06')}. <b>لا تطلب من العميل الدفع مرة أخرى</b> قبل التحقق.</div></div>
    <div class="steps-list" style="max-width:none">
      <div class="step"><span class="s" style="background:var(--color-info)">1</span><div>انظر إلى شاشة جهاز البطاقة أو إيصاله المطبوع.</div></div>
      <div class="step"><span class="s" style="background:var(--color-info)">2</span><div>سجّل ما يُظهره الجهاز بالضبط:</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <button class="btn lg">${I.check}تمت الموافقة على الجهاز</button>
      <button class="btn lg">${I.x}رُفضت أو أُلغيت على الجهاز</button></div>
    <div class="label">مرجع الجهاز (اختياري، حتى 6 أحرف/أرقام)</div>
    <div class="field"><span class="ph ltr">A1B2C3</span></div>
    <div class="step"><span class="s" style="background:var(--color-border-strong)">3</span><div>لا تستطيع التحقق؟ <span class="link">اطلب المسؤول</span> — تبقى المحاولة معلّقة ولا يُحسب أي مبلغ.</div></div>
  </div></section>`;
  const led = `<section class="panel ledger"><div class="due"><div class="label">المبلغ المستحق</div><div class="amount ltr num">375.00 EGP</div></div>
    <div class="lrow"><span>محاولة بطاقة</span><span class="badge warn">${I.alert}غير مؤكدة</span></div>
    <div class="lrow"><span>المبلغ المسجَّل كمدفوع</span><span class="v ltr num">0.00 <small>EGP</small></span></div>
    <div class="commit"><button class="btn block" disabled>${I.back}رجوع للسلة ${kbd('Esc')}</button>
    <div class="meta">لا يمكن الرجوع أو تغيير طريقة الدفع حتى تُسجَّل نتيجة الجهاز.</div>
    <button class="btn danger-quiet block">${I.shield}إلغاء البيع · بموافقة المسؤول</button></div></section>`;
  return page({ id: 'VN-R3', title: 'الدفع', titleExtra: coSteps, body: `<div class="co-grid">${orderSummary()}${center}${led}</div>` });
};

// ── R4 Card entry (normal) 1024 ────────────────────────────────────────────
const R4 = () => {
  const center = `<section class="panel"><div class="panel-head"><h2>طريقة الدفع</h2></div><div class="panel-body">${tenderTiles('card')}
    <div class="notice info" style="padding:14px">${I.card}<div><b>أدخل ${money('375.00')} على جهاز البطاقة.</b><br>بعد انتهاء العميل، سجّل النتيجة التي يُظهرها الجهاز. نقطة البيع لا تتصل بالبنك ولا تحفظ بيانات البطاقة.</div></div>
    <div class="label">مرجع الجهاز (اختياري، حتى 6 أحرف/أرقام)</div>
    <div class="field focus"><span class="ltr num">A1B2C3</span></div>
    <div class="meta">لا تُدخل رقم البطاقة. المرجع يُستخدم للمطابقة فقط.</div></div></section>`;
  const led = `<section class="panel ledger"><div class="due"><div class="label">المبلغ المستحق</div><div class="amount ltr num">375.00 EGP</div></div>
    <div class="lrow"><span>بطاقة (جهاز خارجي)</span><span class="badge info">${I.clock}بانتظار نتيجة الجهاز</span></div>
    <div class="commit"><button class="btn primary lg block">تمت الموافقة على الجهاز ${kbd('Ctrl+Enter')}</button>
    <button class="btn block">مرفوضة أو ملغاة على الجهاز</button>
    <button class="btn block">${I.back}رجوع للسلة ${kbd('Esc')}</button></div></section>`;
  const strip = `<div class="strip"><span class="lock-pill">${I.lock}مجمّدة</span><b>${n(4)} أصناف · ${n(5)} وحدات</b><span class="meta">المجموع الفرعي ${money('375.00')}</span><span style="flex:1"></span><span class="link">عرض الأصناف</span></div>`;
  return page({ id: 'VN-R4', title: 'الدفع', compact: true, titleExtra: coSteps, body: `${strip}<div class="co-grid">${center}${led}</div>` });
};

// ── R5 Completion + print failure ──────────────────────────────────────────
const R5 = () => {
  const st = (tone, icon, text, extra = '') =>
    `<div class="step"><span class="s" style="background:var(--color-${tone})">${icon}</span><div style="flex:1">${text}</div>${extra}</div>`;
  const body = `<div class="banner warn">${I.print}<span class="t">الطابعة لا تستجيب</span><span class="grow">تحقّق من الورق والتوصيل. البيع محفوظ ولن يتأثر.</span><button class="btn">إعادة المحاولة ${kbd('Ctrl+P')}</button></div>
  <section class="panel" style="flex:1"><div class="outcome">
    <span class="big" style="background:var(--color-success)">✓</span>
    <h2>تم البيع</h2>
    <div class="meta">رقم البيع <b class="ltr num" style="color:var(--color-text)">S-0412-000187</b> · ${n('14:07')} · نقدي</div>
    <div style="display:flex;gap:28px;margin:6px 0"><div><div class="meta">الإجمالي</div><div class="ltr num" style="font:700 30px/1.1 var(--font-num)">375.00 EGP</div></div>
      <div><div class="meta">الباقي للعميل</div><div class="ltr num" style="font:700 30px/1.1 var(--font-num)">25.00 EGP</div></div></div>
    <div class="steps-list">
      ${st('success', '✓', 'الدفع مسجَّل')}
      ${st('success', '✓', 'البيع محفوظ على الجهاز')}
      ${st('warning', '!', '<b>الإيصال: لم يُطبع</b> — الطابعة لا تستجيب', `<button class="btn">طباعة ${kbd('Ctrl+P')}</button>`)}
      ${st('info', '…', 'الإرسال إلى النظام: بانتظار المزامنة')}
    </div>
    <div style="display:flex;gap:10px;margin-top:8px"><button class="btn primary lg" style="min-width:240px">بيع جديد ${kbd('Ctrl+N')}</button><button class="btn lg">سلّمت إيصالًا يدويًا</button></div>
  </div></section>`;
  return page({ id: 'VN-R5', title: 'اكتمال البيع', titleExtra: `<span class="steps"><span>السلة</span>›<span>الدفع</span>›<b>الإيصال</b></span>`, status: { printer: ['الطابعة لا تستجيب', 'warn'], sync: ['المزامنة: بيع واحد معلّق', 'info'] }, body });
};

// ── R6 Manager approval over Sale ─────────────────────────────────────────
const R6 = () => {
  const overlay = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true">
    <div class="dialog-head">${I.shield}<h2>موافقة المسؤول مطلوبة</h2><span style="flex:1"></span><span class="meta">المسح معلّق</span></div>
    <div class="dialog-body">
      <div class="meta">كل خصم يدوي يحتاج موافقة المسؤول، مهما كانت نسبته.</div>
      <dl class="fact"><dt>الإجراء</dt><dd>خصم على سطر</dd><dt>الصنف</dt><dd>بنادول إكسترا 500 مجم × ${n(2)}</dd><dt>الخصم</dt><dd><span class="ltr num">5%</span> · ${money('4.50')}</dd><dt>طلبه</dt><dd>منى عادل (كاشير) · ${n('14:04')}</dd></dl>
      <div><div class="label">السبب (مطلوب)</div><div class="select"><span>اختر السبب…</span><span>▾</span></div></div>
      <div><div class="label">رمز الموظف للمسؤول</div><div class="field"><span class="ph">رمز الموظف</span></div></div>
      <div><div class="label">الرقم السري للمسؤول</div><div class="pin"><span>•</span><span>•</span><span class="f"></span><span></span></div></div>
      <div class="meta">الموافقة مرتبطة بالسلة الحالية؛ أي تعديل على السلة يلغي هذا الطلب.</div>
    </div>
    <div class="dialog-foot"><button class="btn primary lg" disabled style="flex:1">موافقة وتطبيق الخصم</button><button class="btn lg">إلغاء ${kbd('Esc')}</button></div>
  </div></div>`;
  return page({ id: 'VN-R6', title: 'البيع', titleExtra: saleTitleExtra, body: `<div style="display:flex;gap:var(--gap);flex:1;min-height:0">${saleRail('ready')}${cartPanel({ flash: false })}</div>`, overlay });
};

// ── R7 Offline selling 1024 ───────────────────────────────────────────────
const R7 = () =>
  page({
    id: 'VN-R7',
    title: 'البيع',
    compact: true,
    titleExtra: saleTitleExtra,
    status: { conn: ['غير متصل', 'warn'], sync: ['المزامنة: 3 مبيعات معلّقة', 'info'] },
    body: `<div class="banner warn">${I.offline}<span class="t">تعمل دون اتصال</span><span class="grow">المبيعات تُحفظ على هذا الجهاز وتُرسل تلقائيًا عند عودة الاتصال. الكتالوج من ${n('13:02')}.</span></div>
    <div style="display:flex;gap:var(--gap);flex:1;min-height:0">${saleRail('ready')}${cartPanel({ lines: LINES.slice(0, 3) })}</div>`,
  });

// ── R8 Inactivity lock with live tender ───────────────────────────────────
const R8 = () => {
  const center = `<section class="panel"><div class="panel-head"><h2>طريقة الدفع</h2></div><div class="panel-body">${tenderTiles('cash')}${cashEntry('400.00')}</div></section>`;
  const overlay = `<div class="scrim" style="background:rgba(8,14,24,.72)"><div class="dialog" role="dialog" aria-modal="true">
    <div class="dialog-head">${I.lock}<h2>الجهاز مقفل</h2><span style="flex:1"></span><span class="meta">منذ ${n('14:11')}</span></div>
    <div class="dialog-body">
      <div class="notice info">${I.shield}<div><b>لم يُفقد شيء.</b> السلة والدفع الجاري محفوظان كما تركتهما.</div></div>
      <dl class="fact"><dt>السلة</dt><dd>${n(4)} أصناف · ${money('375.00')}</dd><dt>الدفع</dt><dd>نقدي · مستلم ${money('400.00')} · <span style="color:var(--color-warning-emphasis)">لم يُؤكَّد بعد</span></dd><dt>الكاشير</dt><dd>منى عادل</dd></dl>
      <div><div class="label" style="text-align:center">أدخل رقمك السري للمتابعة</div><div class="pin" style="margin-top:8px"><span>•</span><span class="f"></span><span></span><span></span></div></div>
    </div>
    <div class="dialog-foot"><button class="btn ghost" style="flex:1">موظف آخر؟ يلزم تسليم الجلسة</button></div>
  </div></div>`;
  return page({ id: 'VN-R8', title: 'الدفع', titleExtra: coSteps, body: `<div class="co-grid">${orderSummary()}${center}${ledger({ received: '400.00', change: '25.00', commitLabel: 'تأكيد الدفع النقدي' })}</div>`, overlay });
};

// ── R9 Storage blocked ────────────────────────────────────────────────────
const R9 = () =>
  page({
    id: 'VN-R9',
    title: 'البيع متوقف',
    status: { conn: ['متصل', ''], sync: ['تعذّر قراءة حالة المزامنة', 'danger'] },
    body: `<div class="blank"><div class="center-card" role="alert">
      <div style="display:flex;gap:12px;align-items:center;color:var(--color-danger-emphasis)">${I.db}<h2 style="margin:0;font:700 22px/1.3 var(--font-sans)">لا يمكن الحفظ على هذا الجهاز</h2></div>
      <div class="notice danger">${I.alert}<div><b>لا تستلم أي مبالغ جديدة الآن.</b> لا يمكن تسجيل بيع لا يُحفظ.</div></div>
      <div class="steps-list" style="max-width:none">
        <div class="step"><span class="s" style="background:var(--color-success)">✓</span><div>المبيعات المكتملة قبل ${n('14:20')} محفوظة ولم تتأثر.</div></div>
        <div class="step"><span class="s" style="background:var(--color-warning)">!</span><div>السلة الحالية (${n(2)} أصناف) لم تُحفظ آخر تعديلاتها — راجعها بعد الإصلاح.</div></div>
        <div class="step"><span class="s" style="background:var(--color-info)">i</span><div>تحقق من مساحة القرص، ثم أعد المحاولة. إذا تكرر الخطأ اتصل بالدعم.</div></div>
      </div>
      <div style="display:flex;gap:10px"><button class="btn primary lg" style="flex:1">إعادة المحاولة</button><button class="btn lg">تفاصيل للدعم</button></div>
      <div class="meta">مرجع الدعم: <span class="ltr num">STG-7F3A-20260930-1420</span></div>
    </div></div>`,
  });

// ── R10 Suspended sales + resume conflict ─────────────────────────────────
const R10 = () => {
  const li = (sel, time, who, label, items, total, badge = '') =>
    `<div class="li ${sel ? 'sel' : ''}"><div><b>${label || 'بدون اسم'}</b><div class="meta">${n(time)} · ${who} · ${n(items)} أصناف ${badge}</div></div><b>${money(total)}</b><span class="link">${sel ? 'محدد' : 'اختيار'}</span></div>`;
  const body = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:var(--gap);flex:1;min-height:0">
    <section class="panel"><div class="panel-head"><h2>المبيعات المعلّقة على هذا الجهاز</h2><span class="meta">${n(3)}</span></div>
      <div class="list">${li(true, '13:41', 'منى عادل', 'عميل — روشتة د. سامي', 3, '212.00', '<span class="badge warn">تغيّر سعر صنف</span>')}${li(false, '13:55', 'منى عادل', '', 1, '45.00')}${li(false, '12:10', 'أحمد نبيل', 'حجز مع الصيدلي', 5, '640.25')}</div>
      <div class="meta" style="padding:12px var(--pad)">المبيعات المعلّقة غير مدفوعة ولا تحجز المخزون، وتبقى على هذا الجهاز فقط.</div></section>
    <section class="panel"><div class="panel-head"><h2>استئناف «عميل — روشتة د. سامي»</h2></div><div class="panel-body">
      <div class="notice warn">${I.alert}<div><b>لديك بيع نشط الآن</b> — ${n(2)} أصناف بقيمة ${money('95.00')}. لا يمكن دمج بيعين أو استبدال أحدهما.</div></div>
      <div class="notice info">${I.clock}<div>تغيّر سعر <b>فولتارين جل</b> من ${money('64.00')} إلى ${money('68.00')} منذ التعليق — ستراجعه وتوافق عليه قبل المتابعة.</div></div>
      <button class="btn primary lg block">علّق البيع الحالي واستأنف المحدد</button>
      <button class="btn lg block">ابقَ على البيع الحالي</button>
    </div></section></div>`;
  return page({ id: 'VN-R10', title: 'المبيعات المعلّقة', titleExtra: `<button class="btn ghost">${I.back}رجوع للبيع ${kbd('Esc')}</button>`, body });
};

// ── R11 Shift required ─────────────────────────────────────────────────────
const R11 = () =>
  page({
    id: 'VN-R11',
    title: 'بدء العمل',
    body: `<div class="blank"><div class="center-card">
      <div style="display:flex;gap:12px;align-items:center">${I.user}<div><b style="font-size:18px">مرحبًا، منى عادل</b><div class="meta">كاشير · الفرع الرئيسي · جهاز ${n('T-03')}</div></div></div>
      <div class="notice info">${I.clock}<div><b>لا توجد وردية مفتوحة على هذا الجهاز.</b> افتح وردية لبدء البيع.</div></div>
      <div><div class="label">النقدية الافتتاحية في الدرج</div><div class="moneyfield" style="margin-top:6px"><span class="v ltr">500.00</span><span class="meta ltr">EGP</span></div><div class="meta" style="margin-top:6px">عُدّ النقدية قبل الإدخال. يُسجَّل المبلغ باسمك ووقت الفتح.</div></div>
      <div style="display:flex;gap:10px"><button class="btn primary lg" style="flex:1">فتح الوردية وبدء البيع</button><button class="btn lg">تسجيل الخروج</button></div>
      <div class="meta">مرجع حدودي — تفاصيل الوردية والجرد يحددها RT-17.</div>
    </div></div>`,
    navActive: '',
  });

// ── R12 Returns entry (gated) ──────────────────────────────────────────────
const R12 = () =>
  page({
    id: 'VN-R12',
    title: 'المرتجعات',
    navActive: 'المرتجعات',
    body: `<div class="blank"><div class="center-card">
      <h2 style="margin:0;font:700 20px/1.3 var(--font-sans)">مرتجع من بيع سابق</h2>
      <div class="notice warn">${I.lock}<div><b>المرتجعات غير مفعّلة على هذا الجهاز في مرحلة التجربة.</b> وجّه العميل إلى المسؤول.</div></div>
      <div><div class="label">رقم البيع أو امسح باركود الإيصال</div><div class="field" style="margin-top:6px;background:var(--color-surface-sunken)">${I.scan}<span class="ph ltr">S-0412-000187</span></div></div>
      <div class="meta">عند التفعيل: يُختار البيع الأصلي، ثم الأصناف والكميات القابلة للإرجاع، ويُحسب المبلغ وطريقة الاسترداد من العقد — لا يُعدَّل البيع الأصلي أبدًا.</div>
      <button class="btn primary lg" disabled>بحث عن البيع</button>
    </div></div>`,
  });

// ── Direction B: cart-first command bar (comparison candidate) ─────────────
const NI = {
  'لوحة': svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  'البيع': svg('<path d="M4 5h2l2 10h10l2-7H7"/><circle cx="10" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>'),
  'المبيعات': svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6"/>'),
  'المرتجعات': svg('<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>'),
  'المراجعة': svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>'),
  'المخزون': svg('<path d="M4 8 12 4l8 4v8l-8 4-8-4Z"/><path d="M4 8l8 4 8-4M12 12v8"/>'),
  'الإعدادات': svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
};
const NAV_SHORT = { 'لوحة المتابعة': 'لوحة', 'نقطة البيع': 'البيع', 'المبيعات': 'المبيعات', 'المرتجعات': 'المرتجعات', 'سجل المراجعة': 'المراجعة', 'المخزون': 'المخزون', 'الإعدادات': 'الإعدادات' };
function navSlim(active, status) {
  const s = { conn: ['متصل', ''], sync: ['مزامنة', ''], printer: ['طابعة', ''], ...status };
  const row = ([label, tone]) => `<div class="si ${tone}"><span class="dot ${tone}"></span>${label}</div>`;
  return `<nav class="nav" aria-label="التنقل">
    <div class="brand"><span class="brand-mark">+</span></div>
    ${NAV.map(([l]) => { const k = NAV_SHORT[l]; return `<div class="navlink" ${l === active ? 'aria-current="page"' : ''} title="${l}">${NI[k]}<span>${k}</span></div>`; }).join('')}
    <div class="nav-spacer"></div>
    <div class="status-cluster" aria-label="حالة الجهاز">${row(s.conn)}${row(s.sync)}${row(s.printer)}</div>
    <div class="operator" title="منى عادل · كاشير"><span class="avatar">م.ع</span></div>
  </nav>`;
}
const LONG = [
  ...LINES,
  ['أوجمنتين 1 جم — 14 قرص', 'Augmentin 1g', '156.00', 1, '156.00', 'rx'],
  ['سنتروم فيتامينات متعددة — 30 قرص', 'Centrum Multivitamin', '310.00', 1, '310.00', ''],
  ['بيبانثين كريم 30 جم', 'Bepanthen Cream 30g', '92.00', 2, '184.00', ''],
  ['ديتول مطهر 250 مل', 'Dettol Antiseptic 250ml', '71.00', 1, '71.00', ''],
  ['شاش طبي معقم 10×10 سم', 'Sterile Gauze 10x10', '12.00', 5, '60.00', ''],
  ['أومبريزول 20 مجم — 14 كبسولة', 'Omeprazole 20mg', '38.50', 1, '38.50', 'rx'],
];
const sumOf = (lines) => (lines.reduce((a, l) => a + Math.round(Number(l[4]) * 100), 0) / 100).toFixed(2);
const group = (v) => { const [i, d] = v.split('.'); return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`; };

function commandBar({ search = false } = {}) {
  return `<div class="cmdbar">
    <div class="scan ${search ? '' : 'ready'}" style="flex:1">${I.scan}<div style="flex:1"><div class="scan-state">${
      search ? '<span class="dot" style="background:var(--color-border-strong)"></span>المسح متوقف أثناء البحث' : '<span class="dot"></span>جاهز للمسح'
    }</div><div class="meta">${search ? `اضغط ${kbd('F2')} للعودة إلى المسح` : 'امسح الباركود في أي وقت'}</div></div></div>
    <div style="flex:1.3;position:relative"><div class="field ${search ? 'focus' : ''}" style="min-height:52px">${I.search}${
      search ? '<span>بنا</span>' : '<span class="ph">ابحث بالاسم أو الكود…</span>'
    }<span style="flex:1"></span>${kbd('F2')}</div>${
      search
        ? `<div class="dropdown" role="listbox"><div class="cart-head" style="grid-template-columns:1fr auto"><span>نتائج البحث (${n(3)})</span><span>السعر</span></div>
      <div class="result active"><div><b>بنادول إكسترا 500 مجم — 24 قرص</b><div class="meta ltr">Panadol Extra · 6221155012345</div></div>${money('45.00')}</div>
      <div class="result"><div><b>بنادول أدفانس 500 مجم</b><div class="meta ltr">Panadol Advance · 6221155012352</div></div>${money('38.00')}</div>
      <div class="result"><div><b>بنادول نايت</b><div class="meta ltr">Panadol Night · 6221155012369</div></div>${money('52.00')}</div>
      <div class="meta" style="padding:8px var(--pad)">↑ ↓ للتنقل · ${kbd('Enter')} لعرض الصنف قبل الإضافة · ${kbd('Esc')} للإغلاق</div></div>`
        : ''
    }</div>
    <button class="btn" style="min-height:52px">المعلّقة <span class="badge neutral">${n(2)}</span> ${kbd('F3')}</button>
  </div>`;
}
function cartPanelB(lines, flash = true) {
  const units = lines.reduce((a, l) => a + l[3], 0);
  return `<section class="panel" style="flex:1;min-width:0">
    <div class="panel-head"><h2>سلة المشتريات</h2><span class="meta">${n(lines.length)} أصناف · ${n(units)} وحدات</span></div>
    <div class="cart-table"><div class="cart-head"><span>#</span><span>الصنف</span><span class="end">سعر الوحدة</span><span>الكمية</span><span class="end">الإجمالي</span></div>
    ${cartRows(lines, flash)}</div></section>`;
}
function moneyColumn(lines, { lastScan = true } = {}) {
  const t = group(sumOf(lines));
  return `<section class="panel ledger" aria-label="الإجمالي">
    <div class="due"><div class="label">الإجمالي الحالي</div><div class="amount ltr num" style="color:var(--color-primary-emphasis)">${t} EGP</div></div>
    <div class="lrow"><span>المجموع الفرعي</span><span class="ltr num">${t} <small class="meta">EGP</small></span></div>
    <div class="lrow"><span>الضريبة</span><span class="meta">قيد الإضافة · لا تُحسب هنا</span></div>
    ${lastScan ? `<div style="padding:var(--pad)"><div class="notice success" role="status">${I.check}<div>أُضيف بالمسح: <b>${lines[lines.length - 1][0]}</b></div></div></div>` : ''}
    <div class="commit">
      <button class="btn primary lg block">الدفع ${kbd('F8')}</button>
      <button class="btn block">${I.pause}تعليق البيع ${kbd('F4')}</button>
      <button class="btn danger-quiet block">إلغاء البيع</button>
      <div class="meta">آخر كتالوج: اليوم ${n('13:02')} · ${n('4,812')} صنفًا</div>
    </div></section>`;
}
const B1 = (compact, { lines = LINES, search = false } = {}) =>
  page({
    id: 'VN-B1', title: 'البيع', compact, slim: true,
    body: `${commandBar({ search })}<div class="sale-b">${cartPanelB(lines, !search)}${moneyColumn(lines, { lastScan: !search })}</div>`,
  });
const B2 = (compact) => {
  const received = compact ? '300.00' : '400.00';
  const center = `<section class="panel"><div class="panel-head"><h2>طريقة الدفع</h2></div><div class="panel-body">${tenderTiles('cash')}${cashEntry(received)}</div></section>`;
  const led = compact
    ? ledger({ received: '300.00', short: '75.00', commitLabel: 'تأكيد الدفع النقدي', commitDisabled: true, reason: 'المبلغ المستلم أقل من المستحق بـ <b class="ltr num">75.00 EGP</b>.' })
    : ledger({ received: '400.00', change: '25.00', commitLabel: 'تأكيد الدفع النقدي' });
  const strip = `<div class="strip"><span class="lock-pill">${I.lock}مجمّدة</span><b>${n(4)} أصناف · ${n(5)} وحدات</b><span class="meta">المجموع الفرعي ${money('375.00')}</span><span style="flex:1"></span><span class="link">عرض الأصناف</span></div>`;
  return page({
    id: 'VN-B2', title: 'الدفع', compact, slim: true, titleExtra: coSteps,
    body: compact ? `${strip}<div class="co-grid">${center}${led}</div>` : `<div class="co-grid">${orderSummary()}${center}${led}</div>`,
  });
};

const SCREENS = [
  ['VN-R1-sale-1280', R1(false), 1280, 800],
  ['VN-R1-sale-1024', R1(true), 1024, 768],
  ['VN-R2-checkout-cash-1280', R2(false), 1280, 800],
  ['VN-R2-checkout-cash-shortfall-1024', R2(true), 1024, 768],
  ['VN-R3-card-unknown-recovery-1280', R3(), 1280, 800],
  ['VN-R4-card-terminal-entry-1024', R4(), 1024, 768],
  ['VN-R5-complete-print-failed-1280', R5(), 1280, 800],
  ['VN-R6-manager-approval-1280', R6(), 1280, 800],
  ['VN-R7-offline-selling-1024', R7(), 1024, 768],
  ['VN-R8-lock-live-tender-1280', R8(), 1280, 800],
  ['VN-R9-storage-blocked-1280', R9(), 1280, 800],
  ['VN-R10-suspended-resume-conflict-1280', R10(), 1280, 800],
  ['VN-R11-shift-required-1280', R11(), 1280, 800],
  ['VN-R12-returns-entry-gated-1280', R12(), 1280, 800],
  // Direction comparison (10-direction-comparison.md): A = V5-based, B = cart-first command bar
  ['VN-B1-sale-1280', B1(false), 1280, 800],
  ['VN-B1-sale-search-1024', B1(true, { search: true }), 1024, 768],
  ['VN-B2-checkout-cash-1280', B2(false), 1280, 800],
  ['VN-B2-checkout-cash-shortfall-1024', B2(true), 1024, 768],
  ['CMP-A-long-cart-1024', R1long(true), 1024, 768],
  ['CMP-A-long-cart-1280', R1long(false), 1280, 800],
  ['CMP-B-long-cart-1024', B1(true, { lines: LONG }), 1024, 768],
  ['CMP-B-long-cart-1280', B1(false, { lines: LONG }), 1280, 800],
];
for (const [name, html] of SCREENS) writeFileSync(join(outHtml, `${name}.html`), html);

const pw = process.argv[2];
async function render() {
  const { chromium } = await import(pathToFileURL(pw).href);
  const browser = await chromium.launch();
  const report = [];
  for (const [name, , w, h] of SCREENS) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.goto(pathToFileURL(join(outHtml, `${name}.html`)).href);
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => document.fonts.ready);
    const overflow = await p.evaluate(() => ({
      x: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('.panel, .workspace')].some((e) => e.scrollHeight > e.clientHeight + 1),
    }));
    const metrics = await p.evaluate(() => {
      const t = document.querySelector('.cart-table');
      if (!t) return {};
      const tb = t.getBoundingClientRect();
      const rows = [...t.querySelectorAll('.cart-row')];
      const visible = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= tb.top - 1 && b.bottom <= tb.bottom + 1; }).length;
      const nm = t.querySelector('.cart-row .name');
      const cta = [...document.querySelectorAll('.btn.primary')].find((b) => b.textContent.includes('الدفع'));
      const cb = cta && cta.getBoundingClientRect();
      return { rows: `${visible}/${rows.length}`, nameColPx: nm ? Math.round(nm.getBoundingClientRect().width) : null, ctaXY: cb ? `${Math.round(cb.left)},${Math.round(cb.top)}` : null };
    });
    await p.screenshot({ path: join(outPng, `${name}.png`) });
    report.push({ name, w, h, ...overflow, ...metrics });
    await p.close();
  }
  // Windows contrast-theme emulation (04 §15) for the two core surfaces.
  for (const name of ['VN-R1-sale-1280', 'VN-R2-checkout-cash-1280']) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
    await p.goto(pathToFileURL(join(outHtml, `${name}.html`)).href);
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: join(outPng, `${name}-forced-colors.png`) });
    await p.close();
  }
  await browser.close();
  console.table(report);
}
if (pw) {
  render().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
