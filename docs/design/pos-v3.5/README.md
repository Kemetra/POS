# Handoff: POS v3.0 — Rahma Qanater retail terminal (POS Pulse)

Full implementation handoff for the **POS v3.0** point-of-sale terminal: an Arabic-first (RTL),
dark-default cashier terminal built on the **Retail Tower OS — POS Pulse** design system. This
package documents the *entire* terminal — sign-in, shift management, the sale/cart workspace,
tender (cash · card · voucher · credit · insurance co-pay), receipts, returns, audit, dashboard,
inventory, settings, and the customer-facing display.

> If you only need the insurance/co-pay tender path, a focused spec lives in
> `../design_handoff_insurance_copay/`. **This** package is the whole terminal.

---

## About the design files

The files in `design-reference/` are a **design reference created in HTML/JSX as a working
prototype** — they show the intended look, copy, math, and behavior. They are **not** production
code to paste in. Your job is to **recreate this terminal in the target codebase's environment**
using its established patterns and libraries. The reference prototype was authored against the
real POS Pulse design system, so its CSS class names (`.btn`, `.badge`, `.cart-pane__*`,
`.tender-slots`, `.pin-pad__*`, `.roster-list__*`, …) map 1:1 onto the shipped stylesheet.

The production target is the **POS-Pulse** repo (Electron 40 + React 19 + Tailwind 4 — see
`github.com/ahmed-shaaban-94/POS-Pulse`). Tokens come from `src/renderer/styles/tailwind.css`;
the spec is `docs/DESIGN.md`. If no codebase exists yet, pick the most appropriate stack and
implement the designs there. Reuse existing primitives — `Button`, `Input`, `PinPad`, `Badge`,
`Card`, `DataTable`, `StatusBanner`, `Toast`, `Dialog`, `NavRail`, `TopBar`, `OperatorBadge`,
`ConnectionIndicator` — and the design tokens; do **not** rebuild restyled lookalikes.

## Fidelity

**High-fidelity.** Colors, typography, spacing, copy, money math, RTL behavior, and interactions
are final. Recreate pixel-faithfully against the production tokens.

## How to run the reference

Open `POS-Terminal-prototype.html` in a browser — it's a fully self-contained, offline build of
the whole terminal (design-system bundle + app + styles inlined). Fonts gracefully fall back to
Segoe UI / system-ui (as the design system specifies until the Inter font file ships). Walk every
screen here before implementing.

`design-reference/pos-app.jsx` + `design-reference/kit.css` are the editable sources and the
authoritative spec for behavior and exact strings.

---

## Brand & global rules (apply everywhere)

- **Arabic-first, RTL default.** `dir="rtl"` on the shell; operator-facing surfaces lead Arabic
  with parenthesized English where helpful. **IDs, SKUs, barcodes, money, member numbers stay
  Latin/mono** and are isolated `dir="ltr"`. Arabic-Indic numerals appear in operator UI;
  **Latin numerals on receipts** (audit compatibility).
- **Tone:** precise, accountable, unhurried. Sentence case. No exclamation marks, no cheerfulness,
  no emoji anywhere. State is named with a colour-dot + text label, never a mood glyph.
- **Honesty-first:** the terminal never claims what it doesn't know ("Last synced 4 min ago", not
  "Up to date"). Failure copy is loud and persistent (banners); success is quiet and ephemeral
  (toasts). Operational state (offline/degraded/syncing) is **always a persistent banner, never a
  toast.**
- **One-Accent Rule:** teal (`--color-accent`) appears only as the nav active-tab marker and focus
  rings — never a fill.
  > ⚠️ **SUPERSEDED for v4.0** (spec 022): teal is the *primary* colour and **MAY fill large
  > primary actions**. Status-Color Containment (next sentence) still stands. **Status-Color Containment:** success/warning/danger/info appear only on
  badges, banners, callouts — never decorative.
- **Money is sacred:** minor units (piasters) internally, mono + tabular numerals, never rounded
  for aesthetics. 14% VAT on `vatable:true` lines; medicines (`vatable:false`) are VAT-exempt.
- **Two themes:** **dark is the default** (Vault Dark register — see token table); a light toggle
  flips token values only (no new components). Theme persists in `localStorage`.
  > ⚠️ **SUPERSEDED for v4.0** (spec 022): **light is the default**; dark remains as a token-only
  > register, retuned to the v4.0 teal identity. Token-values-only and persistence are unchanged.

---

## App shell & navigation

Fixed shell: **64px top bar** + **dark NavRail** + scrollable workspace.

- **TopBar:** wordmark/tenant ("Rahma Qanater"), connection pill (`ConnectionIndicator`),
  theme toggle, `OperatorBadge` (initials avatar + name + role), sign-out. A persistent
  `StatusBanner` appears full-width under the bar whenever connection ≠ online.
- **NavRail** (`POS_NAV`, dark — the only dark surface in light theme; active entry gets Command
  Navy fill + 4×24px teal tab):

  | id | Arabic | English | icon (lucide) |
  |----|--------|---------|---------------|
  | `dashboard` | لوحة المتابعة | Dashboard | `layout-dashboard` |
  | `cart` | نقطة البيع | Sale | `shopping-cart` |
  | `sales` | المبيعات | Sales | `receipt-text` |
  | `returns` | المرتجعات | Returns | `undo-2` |
  | `audit` | سجل المراجعة | Audit | `shield-check` |
  | `inventory` | المخزون | Inventory | `package` |
  | `settings` | الإعدادات | Settings | `settings` |

- **Connection states cycle:** `online → degraded → offline → syncing`. `degraded` = amber banner
  "الاتصال بطيء — Connection slow"; `offline` = red "غير متصل — البيع من قائمة الانتظار المحلية";
  `syncing` = teal banner with pulse-dot "جارٍ المزامنة…".
- **Keyboard shortcuts (cart route):** `/` focus search · `F2` open tender · `F3` hold sale ·
  `F8` toggle customer display · `Esc` close overlay/tender.

---

## Screens / Views

### 1. Sign-in (`SignInScreen`)
Operator signs in by **staff code (typed) + 6-digit PIN** on a centred pane over the dark
workspace. Roster of operators (`POS_OPERATORS`): code `1001` منى خليل (cashier), `1002`
يوسف حسن (cashier), `2001` دينا فاروق (manager). Uses the `PinPad` in a sunken recess; wrong PIN
shows an error halo. Role names: cashier=صيدلي, manager=مدير الصيدلية, admin=مشرف.

### 2. Open shift (`OpenShiftScreen`)
After sign-in with no open shift: cashier enters the **opening cash float** (`FLOAT`
denominations / amount pad). Confirms → records `openedAt`/`openedBy`, audit-logs
"فتح وردية — عهدة {amount}", routes to the sale screen.

### 3. Sale / cart (`SaleScreen`) — the core workspace
Two-column: **catalogue (left)** + **cart pane (right, `.cart-pane`)**.
- **Search** (`searchRef`, Arabic placeholder, barcode-scanner friendly) + **category chips**
  (`CATEGORIES`: quick items, pain & fever, prescription, cold & flu, vitamins, medical supplies,
  personal care).
- **Product grid** (`POS_PRODUCTS`, 20 items): each tile shows Arabic name, pack label, price.
  Items with `units>1` are sellable **by pack or by single unit** (strip/tablet/piece). `rx:true`
  items trigger a **prescription gate Dialog** (صرف بوصفة طبية) capturing Rx ref + dosage before
  adding — logged to audit.
- **Honesty features:** **drug-interaction warnings** (`INTERACTIONS` — e.g. two NSAIDs together),
  **frequently-bought-together** suggestions (`BOUGHT_TOGETHER`), **nearest-batch expiry** chips
  (`EXPIRY`), **stock** levels (`STOCK`).
- **Cart pane:** line items (qty steppers, per-unit/pack, Rx badge, remove — destructive removes
  go through an `AdminGate`), running subtotal / VAT / total, **void sale** (gated), **hold sale**
  (F3), and **Hand off to payment** (F2) → tender.

### 4. Tender (`TenderScreen`)
Method grid → branch panel → confirm + print. Methods:
- **نقدي Cash** — amount pad (`AmountPad`) + quick-amount buttons (`quickAmounts`), animated
  change roll (`MoneyRoll`). Opens the cash drawer.
- **بطاقة Card** — card terminal flow.
- **قسيمة Voucher** — voucher code field (`VOUCHERS`), applies a deduction.
- **آجل Credit** — credit account (`CREDIT`) + down-payment % (`CREDIT_PCTS`: بدون مقدّم / ٢٥٪ /
  ٥٠٪ / ٧٥٪); remainder deferred.
- **تأمين Insurance** — health-insurance co-pay split (`INSURERS`). Reimburses a % of the
  **eligible (medicine-only) basket**; patient pays the co-pay in cash. Full spec in
  `../design_handoff_insurance_copay/INSURANCE_COPAY_HANDOFF.md`.

On confirm: builds the sale payload, opens drawer (cash/voucher/insurance), prints receipt,
records sales-history row, audit-logs, shows quiet success toast, updates customer display, and
clears the cart. Offline → the sale is queued (`Queued`) instead of `Synced`.

### 5. Receipt (`Receipt` / `ReceiptOverlay`)
Thermal-printer receipt artifact: store header, bilingual line items, totals (subtotal, VAT,
deductions, grand total), payment block (method, tendered, change / deferred / insurer + member +
co-pay), barcode/sale number, operator + timestamp. Latin numerals for all money & IDs. Reprint
available from dashboard and sales history.

### 6. Sales history (`SalesHistoryScreen`)
`DataTable` of completed sales (uppercase 11px headers, hover-tinted rows): sale #, time, method
label, total, sync status badge. Row → opens the receipt overlay.

### 7. Returns (`ReturnsScreen`)
Look up a prior sale, select lines to refund, produce a **refund slip** (negative receipt). Refund
is gated and audit-logged.

### 8. Audit (`AuditScreen`)
Chronological, append-only audit log (`logAudit`) — every accountable action (sign-in, shift
open/close, Rx dispense, void, line removal, refund, sale) with operator, timestamp, and ok/warn
status. The "accountable instrument" surface.

### 9. Dashboard (`DashboardScreen`)
Shift-at-a-glance: operator, shift open time, today's sales count/total, top items
(`topItems` bar list), connection state, quick actions (print last receipt, open drawer, close
shift). No metric-hero cards — plain `Card`s and tables per the anti-patterns list.

### 10. Close shift / Z-report (`CloseShiftScreen`)
Cash reconciliation: counted denominations vs. expected (float + cash sales), variance, then a
**Z-report**. Closing is gated and audit-logged; routes back to sign-in.

### 11. Inventory (`InventoryScreen`)
`DataTable` of products with stock, expiry, VAT status; low-stock badges.

### 12. Settings (`SettingsScreen`)
Terminal label, receipt header, theme, connection simulation, and other terminal prefs.

### 13. Customer-facing display (`CustomerDisplay`, F8)
Second-screen view for the customer: current cart total / amount due / change / thank-you.

---

## State management (prototype shape — see `PosApp`)
Top-level state in `PosApp`: `theme`, `operator`, `shift`, `route`, `conn`, `cart`, `tender`,
`receipts`, `audit`, `viewReceipt`, `showCustomer`, plus toasts and a boot splash. Each screen
owns its local tender/branch state. In production, map these onto the repo's existing store
(sales queue, audit logger, shift record, sync engine). Sales persist locally and sync up when
online — durably recorded and attributable to the signed-in operator regardless of network state.

---

## Design tokens

Light is the design-system base; **dark is the terminal default** (token overrides only).

| Token | Light | Dark (default) | Use |
|-------|-------|----------------|-----|
| `--color-background` | `#fbfcfd` | `#0a1420` | workspace |
| `--color-surface` | `#ffffff` | `#111f30` | cards / panels |
| `--color-surface-elevated` | `#f3f6fa` | `#182a3e` | tiles, chips, banner band |
| `--color-surface-sunken` | `#eef2f6` | `#0b1623` | PIN recess, inset wells |
| `--color-text` | `#0f1d2e` | `#e8eef5` | ink |
| `--color-text-muted` | `#5b6b7c` | `#93a5b7` | meta lines |
| `--color-primary` | `#1f4e7a` | `#3b7ab2` | primary actions, active nav |
| `--color-primary-emphasis` | `#163d61` | `#4f8ec6` | hover |
| `--color-primary-soft` | `#e6eef6` | `rgba(79,142,198,.14)` | selected states, tags |
| `--color-accent` (teal) | `#2e7da3` | `#52abd2` | nav active tab + focus rings ONLY |
| `--color-success` | `#1f8a5b` | `#41b283` | confirmations, covered amount |
| `--color-warning` | `#b87600` | `#d9a13a` | degraded / low stock |
| `--color-danger` | `#b32e36` | — | void/refund/offline |
| `--color-info` | `#1e6f8c` | — | syncing |
| `--color-rail` | `#0e1b2a` | — | dark nav rail (the one dark surface in light theme) |
| `--color-rail-hover` | `#162a40` | — | rail entry hover |
| `--color-border` | `#d8dfe7` (Quiet Edge) | — | default 1px borders |
| `--color-border-soft` | `#e7ecf2` (Whisper Edge) | — | soft dividers |
| `--color-overlay-scrim` | `rgba(8,14,24,.55)` | — | dialog scrim (only transparency allowed) |

**Type:** Inter Variable (fallback Segoe UI / system-ui). Weight is the hierarchy lever —
700 display/headline, 600 title/label, 400 body. Negative letter-spacing on headings
(−0.01em / −0.008em). **Mono** (Cascadia/system mono) for IDs, money, barcodes, amounts.
Table headers: 11px uppercase, +0.06em tracking (the one uppercase surface).

**Spacing:** 4px base scale (4→96). Cards pad 32px; workspace 48px inline / 32px block,
max-width 1280px. **Radii:** 10px controls, 14px cards, 16px panes, pill (999px) badges.
**Touch-target floor:** 44×44px on everything interactive.

**Elevation:** flat by default. `--shadow-card` (navy-tinted ambient) for cards, `--shadow-pane`
for centred panels, `--shadow-overlay` for dialogs, `--shadow-inset` for sunken wells. Decorative
shadows prohibited.

**Motion:** state-change only, 80–320ms, ease-out `cubic-bezier(0.2,0.7,0.25,1)`; no bounce.
Only loops: pulse-dot (syncing), skeleton shimmer, button spinner. `prefers-reduced-motion`
degrades everything to instant state swaps (incl. the `MoneyRoll`).

**Anti-patterns (do not introduce):** no light-mode-only assumption (support both, dark default),
no gradient text, no glassmorphism/blur, no metric-hero cards, no icon-heading-text card grids,
no >1px colored left-border accent stripes, no second font, no emoji, no auto-dismissing toasts
for operational state.

## Iconography
Production renderer ships no icon set (nav entries are 20×20 `[data-icon]` placeholders); the
prototype uses **Lucide at 20px / 1.75px stroke** as the agreed substitution — flag this when
implementing. Color dots (8px, currentColor) + text labels are the primary state iconography.
Unicode `✓` and `×` appear sparingly (handoff banner / dismiss). **No emoji.**

## Assets
- `design-reference/assets/pos-pulse-logo.svg` — app-icon logo (midnight gradient, POS glyph).
- `design-reference/assets/retail-tower-hero.png` — program-brand hero (gold tower + crest);
  **program-brand only — never inside terminal UI** (the terminal uses no imagery).
- Icons: Lucide via CDN/package. No other in-product imagery.

## Files in this bundle
| File | What |
|------|------|
| `POS-Terminal-prototype.html` | Self-contained, offline-runnable build of the whole terminal — open this first |
| `design-reference/pos-app.jsx` | Full prototype source (all screens, data, behavior) — the authoritative spec |
| `design-reference/kit.css` | Prototype stylesheet — dark-theme token overrides + retail additions; class names map to the production stylesheet |
| `design-reference/assets/` | Logo + program hero |
| `../design_handoff_insurance_copay/` | Focused spec for just the insurance/co-pay tender path |

## Acceptance checklist
- [ ] RTL shell; Arabic operator copy with Latin/mono IDs & money; Latin numerals on receipts.
- [ ] Dark default + light toggle (token overrides only); theme persists.
- [ ] All 7 nav routes + sign-in, open/close shift, tender, receipt, returns, customer display.
- [ ] Cash/card/voucher/credit/insurance tender with correct change/deferral/co-pay math (minor units, 14% VAT on vatable lines only).
- [ ] Rx gate, interaction warnings, expiry/stock honesty surfaces present.
- [ ] Persistent banners for offline/degraded/syncing; toasts only for ephemeral acknowledgements.
- [ ] One-Accent + Status-Color-Containment respected; no anti-pattern introduced.
- [ ] Every accountable action audit-logged; sales attributable to operator; offline → Queued.
- [ ] `prefers-reduced-motion` honored.
