# Handoff: Retail Tower POS — pharmacy point of sale (Arabic RTL)

## Overview

A seven-screen desktop POS for a Saudi pharmacy: shift start, cashier/cart, payment, sale complete with receipt, returns, shift close (Z-report), plus a design-system sheet. Arabic RTL throughout, Latin numerals, teal brand.

The approved mockup is **`design-files/Retail Tower POS v4.dc.html`**. It is the visual authority. Implement it; do not reinterpret it.

## About the design files

The files in `design-files/` are **design references written in HTML** — prototypes showing intended look and behavior. They are not production code to copy. Recreate them in the target application (React + Electron) using that codebase's existing patterns, component library, and build pipeline.

The HTML uses a streaming component format with inline styles. Read it for **values** (hex codes, pixel measurements, copy), not for architecture. Every number in this README was taken from that file.

Open them by double-clicking; they run in any browser with no build step. A floating pill at the bottom switches screens — that switcher is a prototype affordance and must **not** be implemented.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, and interactions. Reproduce pixel-perfectly at the documented canvas width. Two exceptions, both marked in "Known differences" below: product/pharmacist imagery is a striped placeholder, and the ZATCA QR is a visual stand-in rather than a real encoded symbol.

---

## Canvas and viewport assumptions

| Property | Value |
|---|---|
| Design canvas | **1448 × ~1090 px** (per screen; height varies 989–1106) |
| Desk background (outside the window) | `#EEF1F4` |
| App window | full-bleed, radius `2px`, shadow `0 8px 40px rgba(15,23,42,.10)` |
| Assumed minimum target | 1366 × 768 (Electron window) |
| Scaling model | Fixed sidebar (186px) + fixed product panel (500px) + **flexible center** |

The layout was authored with `box-sizing: border-box` and `min-width: 0` on every flexible column. Both are required — without them the hero row and the cart table overflow.

Below ~1280px nothing was designed. If the Electron window can go narrower, raise it as a design question rather than improvising; the intended first move is collapsing the right-hand products panel into a drawer.

---

## RTL rules (read before building)

The reference is an Arabic RTL product with **explicitly ordered chrome**. Do not rely on `dir="rtl"` alone to mirror the page — it will produce the wrong column order.

1. **Page shells are laid out left→right in source order**: sidebar (left) → cart (center) → products (right). On the payment screen: cart summary (left) → methods (center) → amount due (right). This matches every reference screenshot.
2. **Content blocks are RTL**: each card, row, and list sets `dir="rtl"` so Arabic text aligns right, icons lead, and chevrons point `‹`.
3. **Numerals are Latin** (`12.50`, `#250503-0012`, `09:24`) rendered in Inter. Arabic-Indic digits are not used anywhere.
4. **Mixed strings need explicit direction**: labels such as `32/Bold`, `**** 4582`, `Apple Pay / STC Pay`, and IP addresses carry `dir="ltr"` so the segments don't reorder.
5. **Tables**: the `#` column is rightmost in visual RTL order; grid columns are declared in source order inside a `dir="rtl"` container, so the first declared track paints on the right.
6. Prefer logical properties (`padding-inline-start`) in the implementation, but verify against the screenshots — several elements are intentionally asymmetric.

---

## Design tokens

Full machine-readable list: **`tokens.css`**. Summary:

**Colors** — primary `#0F766E`, hover `#115E59`, deep `#0F5C56`; secondary `#10B981`; support `#3B82F6`; info `#60A5FA`; warning `#F59E0B`; error `#EF4444`. Surfaces: desk `#EEF1F4`, bg `#FAFBFC`, surface `#FFFFFF`, muted `#F8FAFC`, border `#E5E7EB`, row separator `#F1F5F9`, hairline `#EEF1F4`. Text: `#0F172A` / `#64748B` / `#94A3B8` / `#CBD5E1`.

**Tints** — teal `#ECFDF5` (border `#D1FAE5`), selected teal `#F0FDFA`, green `#DCFCE7`/`#15803D`/dot `#16A34A`, blue `#EFF6FF`/`#1D4ED8`/border `#BFDBFE`, amber `#FEF3C7`/`#B45309` and banner `#FFFBEB`/`#FDE68A`, red `#FEF2F2`/`#FEE2E2`/`#DC2626`/border `#FECACA`, slate chip `#F1F5F9`, disabled `#E2E8F0` + `#94A3B8`.

**Typography** — `Noto Kufi Arabic` (400/500/600/700) for Arabic; `Inter` (400/500/600/700) for Latin text **and all numerals**. Documented scale: 32/700 display, 24/600 page title, 20/600 section, 16/400 body, 14/400 secondary, 12/400 small. Working sizes in the screens: 44 (amount due), 38 (cart total), 30 (success title), 28 (refund), 21/19/17 (titles), 14–15 (body), 13 (labels), 11–12 (meta), 9–10 (micro chips). Letter-spacing `-0.4px` on the `Retail Tower POS` wordmark only. Tables and money use `font-variant-numeric: tabular-nums`.

**Radii** — 6 (badges) · 8 · 10 (small controls, 44px buttons) · 12 (buttons, inner cards) · 14 (cards) · 16 (page cards) · 999 (pills).

**Borders** — 1px default `#E5E7EB`; 1.5px for search fields and selected rows; 2px for the selected payment tile and the barcode field. Dashed 1.5px `#CBD5E1` for empty states and receipt dividers.

**Shadows** — only the app window (`0 8px 40px rgba(15,23,42,.10)`). **Cards are separated by borders, not shadows.** Do not add card elevation.

**Spacing** — 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 22. Page padding 14–18, card padding 14–18, grid gaps 10–16.

**Touch targets** — 44 × 44 minimum for quantity steppers and row actions (POS terminals are touch).

---

## Screens

### 1. تسجيل الدخول / بداية الوردية (login + shift start)

**Purpose**: cashier picks their account, enters a PIN, reviews shift details, starts the shift.

**Layout, top to bottom**
- Title bar: height `38px`, white, hairline bottom, 16px logo + wordmark (12/600) at left, window controls at right.
- Hero band (white, 1px bottom border), four columns: `430px` brand lockup · `flex:1, min-width:0` welcome block (bordered both sides with `#EEF1F4`) · `510px` photo panel · `96px` vertical tagline.
  - Brand: 54px mark, wordmark Inter 30/700 `-0.5px`, Arabic subtitle 14 `#0F766E`, `Simple · Secure · Smarter Pharmacy` 12 `#64748B`.
  - Welcome: `مرحباً بك في ريتيل تاور` 26/700, `معاً لصحة مجتمع أكثر إشراقاً` 14 `#64748B`, three feature columns (110/110/130 wide, icon 22, label 12/600, sub 11).
  - Photo panel: teal, white overlay copy — `معاً لصحة` / `مجتمع أكثر إشراقاً` 20/700, `Pharmacy Today` / `A Healthier Tomorrow` 13. **Placeholder** for a real pharmacist photograph.
  - Tagline column: `كل / وصفة / تبدأ بثقة` 14/600, line-height 1.7, 26×3 teal rule beneath.
- Body (`#FAFBFC`, padding 18, gap 16), three columns: `412px` · `flex:1` · `480px`.
  - **Left**: branch card (icon tile 46, title 16/700, sub 13, location 12 `#94A3B8`, chevron); device card (status pill `متصل` green, four label/value rows 13); date-time card (date row 13, clock Inter 34/700, sun icon 40, `صباح الخير` 13/600, sub 12); promo card (gradient `#ECFDF5`→`#F0FDFA`, border `#D1FAE5`, 20/700 teal, sub 12).
  - **Center** (white card, radius 16, padding 22/24): 3-step stepper (circles 34px; active `#0F766E`/white, inactive `#F1F5F9`/`#94A3B8`; connectors 2px `#E5E7EB`; labels 12); `اختر موظفك` 22/700 with 22px icon; sub 13; search field (radius 12, padding 12/14); four employee rows (radius 14, padding 12/14, avatar 44, name 15/700, role 12, ID Inter 12, 26px check circle; **selected** = border 1.5 `#0F766E`, bg `#ECFDF5`, filled check); dashed "موظف غير موجود؟" card with 38px `+` circle.
  - **Right**: PIN card (radius 16, padding 20) — title 19/700, `لوحة مفاتيح آمنة` chip 11, four PIN boxes `62×56` radius 12 (filled = border `#0F766E`, bg `#ECFDF5`, 12px dot), numpad 3 columns gap 10, keys height 56, Inter 20/600, `⌫` and `◎` keys on `#F8FAFC`; `نسيت كلمة المرور؟` 12 teal. Shift-summary card (four rows 13) + primary button height 54, radius 12, 16/700.
- Footer: 12/22 padding, version `v3.6.1`, four utility links 12 `#64748B`.

### 2. شاشة الكاشير / سلة المشتريات (cart) — the primary screen

**Header** (padding 12/16, gap 14): logo 42 + wordmark 21/700 + Arabic sub 11; search `flex:1; min-width:0; max-width:520` (border 1.5, radius 14, padding 10/14, placeholder 13, `F2` badge, 24px barcode glyph `#3B82F6`); prescription chip (`min-width:180`, tile 34 `#ECFDF5`, `Rx` Inter 14/700); notification bell 24 with 17px red badge `3`; settings 24; clock block (Inter 19/700 + date 10) with window controls above.

**Body** — `display:flex; gap:14; padding:14; align-items:flex-start`.

**Sidebar `186px`** — six nav items (radius 12, padding 14/12, gap 10, 14/600; active = `#0F766E` + white text + `F1` badge on `rgba(255,255,255,.2)`; inactive = white + 1px `#EEF1F4`); spacer; shift-close button (radius 12, padding 12, 13/600); help card (`#F8FAFC`, radius 14, padding 16, 40px icon circle, 13/700 title, 11 body, white button radius 9); version block (10 `#94A3B8` / `#CBD5E1`).

**Center `flex:1; min-width:0`**
- Four info cards (`flex:1`, radius 12, padding 12, icon tile 36 radius 10, label 11, value 13/700): customer / customer type / loyalty points / prescription.
- **Cart card** (radius 14, padding 14 16 16):
  - Title row: 26px cart glyph + `سلة المشتريات` 19/700 + 20px count badge; four action buttons (radius 10, padding 9/12, 12/600) — note (neutral), discount (blue), save (neutral), clear (red).
  - Table grid: **`36px minmax(0,1fr) 80px 120px 84px 96px`**, identical on header and rows. Header: padding 10/6, bottom border `#E5E7EB`, 12/600 `#64748B`. Rows: padding 10/6, bottom border `#F1F5F9`, **selected row bg `#F0FDFA`**, cursor pointer.
    - Col 1: 16px selection checkbox (radius 5; on = `#0F766E`) + index Inter 13.
    - Col 2: 58×58 thumbnail (radius 10, 1px border, striped placeholder, `flex:0 0 58px`) + text block (`min-width:0`): name 14/600 with optional `Rx` badge (Inter 10/700, `#EFF6FF`/`#1D4ED8`, radius 6, padding 2/6); meta line 11 `#94A3B8` = pack · barcode; third line 10 `#94A3B8` = batch + expiry, with a status chip (9/600, radius 999, padding 2/7) when flagged. **When a chip is present the batch label is hidden** so the line never wraps.
    - Col 3 price / col 6 line total: Inter 14, tabular; total 700.
    - Col 4 quantity: `−` and `+` at **44×44**, radius 10, gap 4, value Inter 15/700.
    - Col 6 actions: edit and delete at **44×44**, radius 10; delete `#FEF2F2` + `#FEE2E2`.
  - Empty state (cart length 0): dashed 1.5 `#E5E7EB`, radius 14, padding 52/20, 40px cart glyph `#CBD5E1`, `السلة فارغة` 16/700 `#64748B`, hint 12, `F2 مسح الباركود` chip.
  - Warning banner (when any line is flagged): `#FFFBEB` / `#FDE68A`, radius 12, padding 11/14, 12/600 `#B45309`.
  - Footer row: item count 13, `تعديل الكميات` button, `حذف المحدد (n)` button — **enabled** red when a selection exists, otherwise `#F8FAFC` + `#CBD5E1` and inert.
- Discount card (`flex:0 0 320`) + totals card (`flex:1`): rows 14; grand-total block `#ECFDF5`, radius 12, padding 18, label 16/700 teal, value **Inter 38/700 tabular** teal.
- Action row: print button `flex:0 0 190` (radius 14, padding 16, `F10` badge) + pay button `flex:1` (radius 12, padding 13, `#0F766E`, label 17/700, `F12` badge on `rgba(255,255,255,.18)`). **Disabled** (empty cart): `#E2E8F0` / `#94A3B8`, no navigation.

**Right panel `500px`**
- Products card: title 18/700 + 36px search button; **one** category row — 4×2 tiles (radius 12, padding 14/6, icon 19, label 11/600; active = `#ECFDF5` + 1.5px `#0F766E`).
- Best sellers card: title 17/700 + `الأحدث` / `العروض` chips; 2-column grid gap 10; card radius 12 padding 10 — name 13/700, form 11, price Inter 17/700 teal, `متوفر` chip, 30×30 add button, 74×74 thumbnail.
- Quick actions: four tiles (radius 12, padding 14/8) — `مرتجع` (red, navigates to the returns screen), `إيقاف مؤقت`, `فاتورة جديدة`, `بحث متقدم`.

### 3. شاشة الدفع (payment)

Header: logo + wordmark, search `max-width:470`, pharmacy name block, bell, cashier chip, window controls. Below: back button + 3-step breadcrumb (`01 السلة › 02 الدفع › 03 إتمام العملية`, active pill `#0F766E`).

Three columns `392 / flex:1 / 400`, gap 16, padding `0 18 18`.
- **Cart summary** (radius 16, padding 18): title 19/700 + count pill + `تعديل` link; four line items (58px thumb, name 14/600, English name Inter 11, `× 1`, price Inter 15/700 + `ر.س` 11); three totals rows; `المبلغ المستحق` block `#ECFDF5`/`#D1FAE5` radius 12 padding 16 with Inter 24/700; registered-customer row.
- **Methods + details**: `اختر طريقة الدفع` 19/700 with encrypted-transactions chip; 3×2 tiles radius 14 padding 18/14 — icon 30, label 15/700, sub 11; **selected** = 2px `#0F766E`, bg `#F0FDFA`, 20px check at top-right (10/10). Order: نقداً (selected) · بطاقة مدى · بطاقة ائتمان · شركة تأمين · محفظة رقمية · قسيمة هدية. Payment-details table `1.2fr 1fr 1.2fr 70px` with delete buttons; green summary banner (30px check, 15/700 label, Inter 24/700 amount, 12 sub).
- **Amount panel**: `المبلغ المستحق` card — coins glyph, Inter **44/700** left-aligned; `جاهز لتأكيد الدفع` teal block. Received-amount card — field border 1.5 radius 12 padding 14 with Inter 26/700; quick amounts 4-up (5/10/20/50) then 3-up (100/200/500), radius 10 padding 10/4. Remaining-due card Inter 30/700. `المبلغ كامل` teal card.
- Footer bar: note field `flex:0 0 360`; two toggle cards (track 44×24 radius 999, knob 18 — on `#0F766E`, off `#E2E8F0`); `إلغاء العملية` (hover turns red); `إتمام الدفع` primary padding 15/40, 16/700.

### 4. إتمام العملية / الإيصال (sale complete)

Slim working header (padding 14/20): 34px mark + wordmark 19/700, status chip `اكتملت العملية` + invoice number, cashier chip, window controls. (The marketing hero from the reference was intentionally removed here — see "Design decisions".)

Three columns `flex:1 / 380 / 380`, gap 16, padding 18.
- **Success panel**: 112px `#ECFDF5` ring with 78px `#0F766E` disc and 40px check; `تمت عملية البيع بنجاح!` 30/700; `شكراً لثقة عميلك` 18 teal; sub 13; four info tiles (radius 12, padding 14/8, icon 20, label 12, value 13/700). Then `ماذا تريد أن تفعل الآن؟` 19/700 with four action tiles, the `عملية بيع جديدة` block (`#0F5C56`, radius 14, padding 18, 18/700 + Inter 12 sub) and `عرض جميع المبيعات`.
- **Receipt preview**: card radius 16 padding 18; inner receipt radius 12 padding 18/16 — logo row, pharmacy block, dashed `#CBD5E1` dividers, meta rows 12, line-item grid `20px 1fr 42px 52px 58px` at 11px, totals, teal grand-total block (Inter 17/700), thank-you line, **ZATCA block** (104×104 QR, caption `فاتورة ضريبية مبسطة — رمز ZATCA`, `الرقم الضريبي 300123456700003`), then the barcode strip and its digits.
- **Right column**: `أحدث المبيعات اليوم` (five rows, radius 12, first row highlighted `#ECFDF5`/`#D1FAE5`, method chips) and `إحصائيات اليوم` (three rows, icon tile 34, value Inter 19/700).

Footer: brand, `صحة أفضل .. حياة أجمل`, date/time and system-ready dot.

### 5. مرتجع (returns) — new screen

Header: brand + red `عملية مرتجع` chip + cashier. Breadcrumb `01 البحث عن الفاتورة › 02 اختيار الأصناف › 03 طريقة الاسترداد` (first two active).

Columns `340 / flex:1 / 360`.
- **Left**: invoice search field + barcode glyph; `آخر الفواتير` list (three rows; selected `#F0FDFA` + `#0F766E`); original-invoice card (five label/value rows).
- **Center**: `اختر الأصناف المرتجعة` 18/700 + `n من 4 أصناف`; table grid **`36px minmax(0,1fr) 78px 64px 150px 88px`** — checkbox, 50px thumbnail + name/pack, price, qty, reason dropdown (radius 9, padding 8/10, 11/600; `—` `#CBD5E1` when the line is unselected), refund value Inter 14/700 `#DC2626`. **Blocked lines** (cold-chain, e.g. أنسولين) render at `opacity .55`, `cursor:not-allowed`, with a `غير قابل للإرجاع` red chip and cannot be selected. Return-policy note block `#F8FAFC`, 11/1.9.
- **Right**: refund summary (items value, VAT refunded 15%, net refund block `#FEF2F2`/`#FECACA` with Inter 28/700 `#DC2626`); refund-method radio list (original method selected); manager-approval warning block (amber).
- Footer: note field `flex:0 0 420`, `إلغاء`, and `تأكيد المرتجع` — **disabled** (`#E2E8F0`/`#94A3B8`) until at least one line is selected.

Reason options: `صنف خاطئ` · `منتهي الصلاحية` · `تلف بالعبوة` · `إلغاء الوصفة` · `سبب آخر`.

### 6. إغلاق الوردية (shift close / Z-report) — new screen

Header: brand + `إغلاق الوردية` chip with `Z-Report` label + cashier.

Columns `360 / flex:1 / 340`.
- **Left**: shift details (employee, branch, device `POS-01`, start `09:24 ص`, close `05:36 م`, duration `8:12`); sales movement (invoices 42, collected 4,355.50, returns −85.00, discounts −120.00, VAT collected 557.02, net sales 4,270.50, average invoice 101.68).
- **Center**: expected-by-method table `1fr 120px 120px` (نقداً 1,245.50 · مدى 2,310.00 · ائتمان 480.00 · تأمين 320.00, each with a green `مطابق` chip). Cash-drawer count card: difference chip in the title row (green `مطابق` at zero, amber `عجز`/`زيادة` otherwise); denomination table `60px 54px 1fr`, rows padding 9/10, zero-count rows dimmed to `#CBD5E1`; two summary tiles — expected `#F8FAFC` and counted `#ECFDF5`, both Inter 22/700.
- **Right**: handover card (amount handed over, float retained, receiver) with a dashed signature box; shift-notes card; action card with `طباعة تقرير الوردية` and the primary `إغلاق الوردية وتسجيل الخروج` (returns to login).

Denominations shown: 500×2, 200×0, 100×2, 50×0, 20×2, 10×0, 5×1, 1×0, 0.50×1 → counted **1,245.50**, expected **1,245.50**, difference **0.00 مطابق**.

### 7. نظام التصميم (design-system sheet)

Reference sheet, not a product screen — implement only if you want an in-app style page. Cards: color palette (11 swatches, 54px chips), typography (specimen + 6-row scale), status chips (8), buttons (6 variants), search & barcode fields, cart-item component, payment methods (8 tiles), and four 300px-tall mini-screen thumbnails.

---

## Reusable components

| Component | Props | Where used |
|---|---|---|
| `AppWindow` | `children` | all screens — 1448px shell, radius 2, window shadow |
| `WindowChrome` | `title`, `showClock` | all screens — `– ◻ ✕` at 14/11/13px, `#64748B` |
| `BrandLockup` | `size: 'sm' \| 'md' \| 'lg'`, `showTagline` | header (21/700), hero (30/700), receipt (17/700) |
| `SearchField` | `placeholder`, `shortcut`, `showBarcode` | cart, payment, returns, employee search |
| `ShortcutBadge` | `label` | `F1` `F2` `F10` `F12` — Inter 11/700, radius 6, padding 4/8 |
| `StatusChip` | `tone: success \| info \| warning \| error \| neutral \| rx`, `label`, `dot?` | stock, expiry, sync, payment methods |
| `InfoTile` | `icon`, `label`, `value`, `tint` | cart info row, sale-complete tiles |
| `NavItem` | `icon`, `label`, `active`, `badge` | sidebar |
| `CartRow` | `item`, `selected`, `onToggle`, `onInc`, `onDec`, `onRemove` | cart table |
| `QtyStepper` | `value`, `onChange`, `size=44` | cart table |
| `IconButton` | `tone: neutral \| danger`, `size=44` | row actions, payment-detail rows |
| `Button` | `variant: primary \| outline \| ghost \| secondary \| danger`, `disabled`, `shortcut` | everywhere |
| `Toggle` | `checked` | payment footer (44×24, knob 18) |
| `SummaryRow` | `label`, `value`, `tone` | totals, shift report, refund summary |
| `TotalBlock` | `label`, `value`, `tone: teal \| red`, `size` | cart total, amount due, net refund |
| `PaymentMethodTile` | `icon`, `label`, `sub`, `selected` | payment screen, DS sheet |
| `ProductCard` | `name`, `form`, `price`, `inStock`, `onAdd` | products panel |
| `CategoryTile` | `icon`, `label`, `active` | products panel |
| `Stepper` | `steps`, `current` | login, payment, returns |
| `ReceiptPreview` | `invoice` | sale complete |
| `EmptyState` | `icon`, `title`, `hint`, `shortcut` | empty cart |
| `OfflineBanner` | `queued`, `lastSync` | cart, payment |
| `ImagePlaceholder` | `label`, `size` | every product/photo slot until real assets exist |

---

## States and interactions

**Hover** — neutral bordered controls: `border-color: #0F766E` (some also gain `#ECFDF5`). Primary buttons: `#0F766E → #115E59`. `إلغاء العملية`: border and text turn `#EF4444`. No transitions were specified; `120ms ease` is a safe default.

**Selected** — cart row `#F0FDFA`; employee row and invoice row border 1.5 `#0F766E` + `#ECFDF5`; payment tile border 2 `#0F766E` + `#F0FDFA` + check badge; category tile `#ECFDF5` + 1.5 `#0F766E`; nav item solid `#0F766E`.

**Disabled** — `#E2E8F0` background, `#94A3B8` text, `cursor: default`, **and the handler must be inert**. Applies to: pay button with an empty cart, `حذف المحدد` with no selection, `تأكيد المرتجع` with no lines selected.

**Blocked** — non-returnable line: `opacity .55`, `cursor: not-allowed`, red chip, click ignored.

**Flows implemented in the mockup**
- login → `بدء الوردية والدخول للنظام` → cart
- cart → `المتابعة إلى الدفع (F12)` → payment *(blocked when the cart is empty)*
- payment → `إتمام الدفع` → sale complete; `إلغاء العملية` / back → cart
- sale complete → `عملية بيع جديدة` → cart
- cart quick action `مرتجع` → returns; returns `إلغاء` → cart
- sidebar `إغلاق الوردية` → shift close → `إغلاق الوردية وتسجيل الخروج` → login

**Live behavior** — add to cart from the products panel; quantity +/− (floor 1); remove line; clear cart; row selection and bulk delete; subtotal/VAT/total recompute; discount clamped to `min(discount, subtotal)` so the ledger always balances; refund total recomputes from selected return lines.

**Not implemented (build as real behavior)** — F-key bindings, barcode input, reason-code dropdown, insurance eligibility, parked sales, loyalty redemption, receipt printing, signature capture.

---

## State model

```ts
type Screen = 'login' | 'cart' | 'pay' | 'done' | 'return' | 'shift';

interface PosState {
  screen: Screen;
  employeeId: string;            // 'EMP-001'…'EMP-004'
  pinLength: number;             // 0–4
  category: string;              // 'جميع الأصناف' | …
  cart: { id: string; qty: number }[];
  selected: string[];            // cart line ids selected for bulk delete
  returnSelected: string[];      // return line ids
  returnReasons: Record<string, string>;
  offline: boolean;              // drives the offline banner
}
```

Derived per render: `subtotal`, `discount = min(configuredDiscount, subtotal)`, `vat = (subtotal - discount) * vatRate`, `total = subtotal - discount + vat`, `selectedCount`, `warningCount`, refund `net / vat / total`, drawer `counted / expected / difference`.

Configurable values exposed as props in the mockup — wire these to settings, not constants: `vatRate` (default 15%), `discountAmount` (default 10.00), `expiryWarnings` (default on), `offlineMode` (default off).

---

## Implementation notes — React + Electron

1. **Fonts must be bundled locally.** The prototype loads Noto Kufi Arabic and Inter from Google Fonts; an Electron POS may be offline. Ship both as local `@font-face` (weights 400/500/600/700) and keep the same stack order: Arabic → `Noto Kufi Arabic`, Latin/numerals → `Inter`.
2. **Do not translate the inline styles verbatim.** Use the codebase's styling layer; import `tokens.css` (or convert it to the existing token format) and build the component list above.
3. **`box-sizing: border-box` globally**, and `min-width: 0` on every `flex: 1` column. Both were required to stop the hero row and cart table from overflowing 1448px.
4. **Grid track definitions are load-bearing.** Use `minmax(0, 1fr)` for the item-name column; a bare `1fr` resolves to `minmax(auto, 1fr)` and the row overflows on long product names. Header and body rows must declare identical tracks.
5. **Numerals**: format with `Intl.NumberFormat('en-US', { minimumFractionDigits: 2 })` — the design uses Latin digits with two decimals and thousands separators (`1,245.50`). Apply `tabular-nums` in tables and totals.
6. **ZATCA**: the QR in the mockup is a decorative 25×25 pattern. Replace it with a real Phase-2 symbol encoding the base64 TLV payload (seller name, VAT number, timestamp, total with VAT, VAT amount) — e.g. `qrcode.react`. Keep the 104×104 footprint, the caption, and the VAT-number line.
7. **Printing**: the receipt column is screen preview only. Thermal output (80mm) needs its own stylesheet; nothing here is designed for it.
8. **Electron window**: `1448 × 1090` is the design canvas; set a minimum around `1366 × 768` and let the center column absorb the difference. Frameless + custom `– ◻ ✕` matches the mockup; wire them to `BrowserWindow` controls, and keep them top-right on every screen.
9. **Prototype-only elements to drop**: the bottom screen-switcher pill, the `PHARMACIST PHOTO` badge, and all `ImagePlaceholder` stripes once real assets exist.
10. **Icons** are hand-written inline SVGs in a Lucide-like 24×24 stroke style, `stroke-width: 1.7–1.9`, round caps/joins. Swap them for the codebase's icon set with matching weight; keep the rendered sizes (13–30px per the screens).

---

## Element → mockup mapping

| What | Where in the mockup |
|---|---|
| All screens | `design-files/Retail Tower POS v4.dc.html` (screen switcher at the bottom) |
| Login / shift start | switcher `01 تسجيل الدخول` · `screenshots/01-screen.png` · `references/01-login-shift-start.png` |
| Cart / cashier | `02 السلة` · `screenshots/02-screen.png` · `references/02-cart-cashier.png` |
| Payment | `03 الدفع` · `screenshots/03-screen.png` · `references/03-payment.png` |
| Sale complete + receipt | `04 إتمام البيع` · `screenshots/04-screen.png` · `references/04-sale-complete.png` |
| Returns | `05 مرتجع` · `screenshots/05-screen.png` (new; no reference image) |
| Shift close / Z-report | `06 إغلاق الوردية` · `screenshots/06-screen.png` (new; no reference image) |
| Tokens, chips, buttons, cart item | `نظام التصميم` · `screenshots/07-screen.png` · `references/05-design-system-sheet.png` |
| Reference-faithful first pass | `design-files/Retail Tower POS v1 (reference-faithful).dc.html` |

---

## Assets

- `references/` — the five original reference images (the visual source of truth for screens 1–4 and the DS sheet).
- `screenshots/` — captures of the approved v4 mockup, one per screen. **Note:** these were taken in a preview pane narrower than the 1448px canvas, so the right edge is cropped. Use them for reading structure; use the HTML file or the reference images for exact appearance.
- No production imagery exists yet. Every product shot, the pharmacist photo, and the receipt QR are placeholders.

---

## Design decisions applied on top of the references

The mockup is not a literal copy of the reference images. These changes were requested and approved:

1. Grand total enlarged to 38px; the pay button reduced so the total reads as the primary figure.
2. Duplicate customer chip removed from the cart header (the info-card row carries it).
3. The two category controls merged into one icon grid.
4. `Simple · Secure · Smarter Pharmacy` and the marketing hero removed from working screens; login and the DS sheet keep the hero.
5. Category icons restricted to teal; the remaining non-teal colors are semantic only.
6. Quantity and row actions raised to 44×44.
7. Tabular numerals with consistent alignment.
8. `معاً لصحة أفضل` reduced to one appearance per screen.
9. Added: cart line selection, batch/expiry with warning chips, `Rx` line marker, empty-cart state, disabled pay button, clamped discount.
10. Added screens: returns, shift close. Added: offline banner, ZATCA block on the receipt.

`design-files/Retail Tower POS v1 (reference-faithful).dc.html` preserves the untouched recreation if you need to compare.

---

## Known differences and compromises

- **Imagery**: all product shots, the pharmacist hero photo, and category imagery are striped placeholders with monospace labels. Real assets are needed.
- **ZATCA QR**: decorative pattern, not an encoded symbol. Must be generated from live invoice data.
- **Barcode strip** on the receipt is drawn with `<span>` bars, not a real Code-128 render.
- **Reason dropdown** on the returns screen displays the current value but does not open a menu.
- **Signature box** on the shift-close screen is a dashed area; no capture surface.
- **Design-system mini-screens** are simplified interpretations of the reference sheet's thumbnails, not pixel copies.
- **Shift-close figures** are internally consistent sample data, not derived from the cart.
- **Payment and receipt totals** are fixed sample values (188.03 / 88.75) and do not follow the live cart — intentional, matching the reference screenshots.
- **Below 1280px** is undesigned.
- **Arabic copy** is taken verbatim from the reference images; new screens follow the same register. Have a native reviewer confirm the new strings before release.

---

## Files

```
design_handoff_retail_tower_pos/
├── README.md                                        ← this document
├── tokens.css                                       ← design tokens + required resets
├── design-files/
│   ├── Retail Tower POS v4.dc.html                  ← APPROVED — the visual authority
│   └── Retail Tower POS v1 (reference-faithful).dc.html
├── references/                                      ← original reference images
│   ├── 01-login-shift-start.png
│   ├── 02-cart-cashier.png
│   ├── 03-payment.png
│   ├── 04-sale-complete.png
│   └── 05-design-system-sheet.png
└── screenshots/                                     ← captures of the approved mockup
    ├── 01-screen.png … 07-screen.png
```
