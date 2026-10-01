# 04 — Retail Tower POS Design Language (VNext) — APPROVED

> **Status: APPROVED by the owner on 2026-10-01 (RT-104 Done).** This is the design-language
> authority behind [`docs/DESIGN.md`](../../DESIGN.md), the operative summary agents read first.
> Implementation still happens only through bounded Jira slices ([09](09-implementation-slices.md)).
> The text below was written as the proposal. Where it says "Δ proposal" or names an owner
> decision, the outcome is:
>
> - **OD-1:** keep teal. R-C6 stands, so Tower Blue is not adopted.
> - **OD-2:** keep Dubai. The Noto Sans Arabic option in §4.1 is declined.
> - **OD-3:** the §4.3 numeral policy is approved. It is not yet implemented and is still to be
>   checked against real receipts.
> - **OD-4:** §15 light-first is approved, and forced-colors support is required.
> - **OD-5:** keep «POS Pulse».
> - **OD-6:** hide placeholder navigation from cashiers.
> - **OD-7:** **Direction B**. §16 below now describes B.
>
> The RT-24 §C confirmations remain open ([README](README.md#carried-forward--still-open)).
>
> **RT-24 remains the behaviour authority.**
> Where this document and RT-24 (or a merged GitHub contract) disagree, the functional contract
> wins and the conflict is listed in [08-rt24-invariants.md](08-rt24-invariants.md).
>
> Baseline: `Kemetra/POS@28890fa` (origin/main, verified 2026-09-30).

This is **not** a new look. It is the codification of what the owner already approved on
production (the 022 light clinical teal system and the 023/V5 Sale screen, approved 2026-09-25),
completed with the rules that were missing — numerals, focus, scanner ownership, density,
states, themes, 1024/1280 — so that every later screen can be built **without agents inventing
design ad hoc**. The two existing design documents (`docs/DESIGN.md`, `.impeccable/design.json`)
describe a superseded navy/Inter/dark system and must be replaced by this language once approved
(slice VN-S1, see [09-implementation-slices.md](09-implementation-slices.md)).

---

## 1. Visual north star — "The Accountable Instrument, in daylight"

The terminal is a **calm clinical instrument** on a pharmacy counter. It is read at arm's length,
under overhead light, by a cashier whose hands are on a scanner and a keyboard, with a customer
waiting. Three questions decide every screen:

1. **What is in the sale and what does it cost?** — the cart and the money are always the
   visually dominant truth.
2. **What is the one next thing I should do?** — exactly one primary action per state.
3. **Is anything not proven yet?** — any state that is not proven (payment UNKNOWN, not yet
   finalized, not printed, not synced, offline) is *visible and named*, never implied away.

Character words: **light, quiet, dense, exact, Arabic-first.**
Anti-words: dashboard, marketing, playful, glossy, decorative, "AI app".

The name "The Accountable Instrument" is retained from the v3.5 DESIGN.md on purpose — the
principle survived; the navy/Inter/dark palette that expressed it did not.

### 1.1 Principles (testable)

| # | Principle | Test that proves it |
|---|---|---|
| P1 | **Money is the loudest thing on screen.** In Sale the grand total, in Checkout the amount due, is the largest numeral and is never scrolled out of view at 1024 or 1280. | Screenshot at 1024×768 and 1280×800 in every checkout sub-state shows the amount due without scrolling. |
| P2 | **One primary per state.** At most one filled-teal button is visible per surface/dialog. | DOM check: ≤1 `[data-intent="primary"]` visible per region. |
| P3 | **Proven or labelled.** No success colour/icon/word appears before the underlying fact is persisted (RT-24 core rule 2). | Every success visual maps to a named RT-24 proven state (SETTLED, FINALIZED, PRINTED, POSTED). |
| P4 | **Quiet when healthy, loud when actionable.** Operational status (connection, sync, printer, catalogue) is a small persistent indicator when healthy and becomes a banner only when the cashier must act or must know. | Healthy state renders no banner; each degraded state renders one named banner. |
| P5 | **Keyboard and scanner first, touch-capable.** Every action has a visible control; shortcuts are accelerators shown on the control. Scanner input has one visible owner. | Keyboard-only walkthrough of the full cashier journey; scan-owner indicator present on every surface that accepts scans. |
| P6 | **Arabic-first, number-exact.** Layout is RTL; money, codes, quantities are LTR-isolated Western digits with tabular alignment. | Numeral policy lint (§4.3) + bidi isolation check on every money/code node. |
| P7 | **Consequence, not decoration.** Visual weight tracks financial/destructive consequence (neutral < primary < warning < destructive), never brand flourish. | Destructive actions use the danger role; no status colour used decoratively. |
| P8 | **Never color alone.** Every state has text and/or icon in addition to color. | axe + forced-colors screenshot shows every state still distinguishable. |

---

## 2. Arabic-first RTL composition

- `<html lang="ar" dir="rtl">` is set once (already true, `index.html:16`). Components never
  re-declare `dir="rtl"`; they only declare `dir="ltr"` on isolated Latin runs. (Today several
  frames redundantly re-set RTL — harmless, cleaned up opportunistically only inside a slice.)
- **Reading order = importance order.** Inline-start (right) holds *where you are / what you are
  adding*; inline-end (left) holds *money and the commit action*. This is how the approved V5
  Sale already reads (product rail right, cart centre, total + CTA bottom-left) and Checkout
  VNext follows the same muscle memory (§10). **Amended for Direction B (OD-7):** the
  reading-order rule stands, but during an active sale the inline start is the command bar
  above a full-width cart, not a product rail, and money plus the commit sit in the money column
  at the inline end (§16).
- **CSS logical properties only** (`margin-inline-start`, `inset-inline-end`, `border-inline`…).
  Physical `left/right` allowed only with a code comment explaining why (existing: dialog
  centring, amount alignment).
- **LTR isolation** (`.v5-ltr` → `direction:ltr; unicode-bidi:isolate`, or `<bdi>`) on: money,
  quantities, barcodes, SKUs, sale/receipt numbers, terminal IDs, times, card reference, Latin
  product names. Never isolate a whole Arabic sentence that merely contains a number — isolate
  the number.
- **Copy is Arabic-led on every cashier surface.** English appears only as a secondary product
  name (catalogue data) or inside isolated codes. Bilingual headings such as
  «طريقة الدفع (Payment method)» are retired. Manager/admin surfaces follow the same rule when
  they are migrated.
- **Icons that imply direction** (back/forward, chevrons, "next") mirror in RTL. Icons that do not
  (search, scan, print, lock, clock, check) never mirror.
- **Keypads stay LTR** (1-2-3 top row as on physical keypads; already `dir="ltr"`, D-006).

---

## 3. Color roles

The shipped 022 tokens in `src/renderer/styles/tailwind.css` are the **source of values**. VNext
changes **roles and rules**, not hex values, except where noted as a proposal (Δ).

### 3.1 Roles (light register — the pilot register)

| Role | Token | Value (shipped) | Use | Never |
|---|---|---|---|---|
| Canvas | `--color-background` | `#f7f9fa` | Page behind panels | Panels |
| Surface | `--color-surface` | `#ffffff` | Panels, cart, dialogs | — |
| Raised | `--color-surface-elevated` | `#f3f6fa` | Titlebars, sticky totals band, table headers | Full-screen fills |
| Sunken | `--color-surface-sunken` | `#eef2f6` | Scan target, keypad well, disabled tiles | Interactive fill on hover |
| Ink | `--color-text` | `#0f1d2e` | All primary text, numerals | — |
| Ink muted | `--color-text-muted` | `#53647a` | Secondary text, meta, hints (≥12px) | Money, errors |
| **Commit (primary)** | `--color-primary` / `-emphasis` / `-soft` / `-on` | `#0f766e` / `#0b5b55` / `#e6f4f1` / `#fff` | The one next action; selected nav; selected tender; focus ring | Status, decoration, text blocks |
| Info | `--color-info*` | `#1b6ca8`… | Syncing, informational notices, "not yet proven" (neutral pending) | Commit actions |
| Success | `--color-success*` | `#15774d`… | **Proven** outcomes only (SETTLED/FINALIZED/PRINTED/POSTED, healthy indicator dot) | Buttons, "ready" hints |
| Warning | `--color-warning*` | `#a35a00`… | Degraded but operable (offline selling, stale catalogue, printer failed after sale) | Destructive actions |
| Danger | `--color-danger*` | `#b3261e`… | Destructive actions (void, cancel sale), blocking errors, UNKNOWN payment | Warnings |
| Hairline | `--color-border` / `-soft` | `#d8dfe7` / `#e7ecf2` | Decorative dividers | Control boundaries |
| Control edge | `--color-border-strong` | `#6f7b89` | Input/button/tile boundaries (≥3:1, WCAG 1.4.11) | Dividers |
| Scrim | `--color-overlay-scrim` | `rgba(8,14,24,.55)` | Behind modal dialogs/lock | — |

### 3.2 Rules

- **R-C1 Commit-teal budget.** Filled teal appears on ≤ 1 control per region plus selected-state
  tints. Large teal *fills* are allowed for the primary commit (022 FR-3/4 superseded the v3.5
  One-Accent Rule; this stays).
- **R-C2 Accent retired.** `--color-accent` equals primary today, which made the legacy nav
  "active tab" invisible. VNext has **no separate accent role**; selection is shown with
  `primary-soft` fill + `primary` ink + a 2px inline-start bar **plus** `aria-current`.
  (Δ proposal: alias `--color-accent` to `--color-primary-emphasis` until the legacy rail is
  retired, then delete the token.)
- **R-C3 Status containment.** Status colours only on status surfaces (banner, indicator, badge,
  outcome panel, destructive button). Unchanged from DESIGN.md.
- **R-C4 Pending ≠ success.** "Recorded but not yet proven downstream" (e.g. payment SETTLED but
  sale still FINALIZING; sale FINALIZED but not POSTED) uses **info**, not success. Success green
  is reserved for the proven fact the cashier is being told about.
- **R-C5 UNKNOWN is danger-framed, not decline-framed.** A card result that is UNKNOWN uses the
  danger role with the words «النتيجة غير مؤكدة» and never the word «مرفوض» (RT-24: UNKNOWN is not
  a decline).
- **R-C6 Tower Blue** (RT-27 handoff) is **not adopted** as a palette: its token bundle is not
  retrievable from Atlassian and it would re-open an approved, shipped direction. It remains a
  layout/interaction reference. → owner decision **OD-1** in [README](README.md#owner-decisions).

---

## 4. Typography and numerals

### 4.1 Families

- **Sans (UI + Arabic):** `'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif` — retained.
  Dubai ships with Windows 10/11, needs no bundle, and keeps the `no-brand-font` guard green.
- **Numerals and codes:** `ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace`
  with `font-variant-numeric: tabular-nums` — retained for money, quantities, codes (022 FR-12).
- **Δ Option (owner decision OD-2):** bundle **Noto Sans Arabic** (SIL OFL 1.1) via a local font
  file. It is the only measured candidate whose Western *and* Arabic-Indic digits are tabular by
  default, which would let money use the UI face instead of a monospace face. This is a
  dependency/asset change and needs explicit authorisation (CLAUDE.md §10); recommended **only**
  if target-hardware review finds Dubai + Consolas mixing visually unacceptable. Not required for
  VNext.

### 4.2 Type roles (replace raw size picking)

Today components pick raw sizes (34 off-scale literals in `tailwind.css`). VNext introduces
**role tokens** that alias the existing size scale:

| Role token | Size / weight / line-height | Use |
|---|---|---|
| `--type-amount-hero` | 44px / 700 / 1.1, mono tabular | Checkout amount due; completion amount |
| `--type-amount-total` | 30px / 700 / 1.1, mono tabular (24px at 1024 compact) | Sale grand total; ledger totals |
| `--type-screen-title` | 20px / 700 / 1.3 | One per screen (titlebar h1) |
| `--type-section` | 16px / 700 / 1.4 | Panel headings |
| `--type-body` | 14px / 400 / 1.6 | Default cashier text, cart product names |
| `--type-body-strong` | 14px / 600 / 1.6 | Product name, labels, button text |
| `--type-control-lg` | 16px / 700 / 1.3 | Primary commit button, tender tile label |
| `--type-meta` | 12px / 400–600 / 1.5 | Hints, secondary name, timestamps, kbd hints |
| `--type-money-row` | 14px / 600 / 1.4, mono tabular | Line prices, ledger rows |

Rules:
- **Minimum 12px** for anything a cashier must read; 11px (`--font-size-2xs`) only for
  keyboard hint chips.
- **Arabic line-height ≥ 1.5** for body text (Arabic ascenders/descenders and dots clip at 1.25).
- Long product names wrap to **two lines max** in the cart, then ellipsis with the full name in
  the line's accessible name and on focus/hover.
- No all-caps (irrelevant to Arabic; for Latin codes it hurts scanning of `O/0`, `I/1`).
- No italics.

### 4.3 Numeral policy (Δ proposal — owner decision OD-3)

Today one screen mixes systems: money is Latin (`money.format` → `"123.45 EGP"`) while
timestamps/counts use `Intl('ar-EG')` → Arabic-Indic (`LiveProductRail.tsx:24-34`,
`SaleSyncStatus.tsx:81-92`). VNext proposes **one policy**:

| Content | System | Formatting |
|---|---|---|
| Money | Western digits | `1,250.00 EGP` — thousands grouping (Δ: today no grouping), 2 decimals, minus as `−` U+2212 at inline-start of the isolated run, `tabular-nums` |
| Quantities, counts, line numbers | Western digits | `3 أصناف · 5 وحدات` with correct Arabic plural forms (today "1 أصناف" is ungrammatical) |
| Times and dates | Western digits | `ar-EG-u-nu-latn` (pinned locale tag) → `30 سبتمبر 2026، 14:05` |
| Barcodes, SKUs, sale/receipt numbers, card reference, terminal id | Western digits | always LTR-isolated, mono |
| Input | Accept `٠-٩` and `۰-۹`, normalise to ASCII before validation | (behaviour already partly in scanner path — confirm per field in slice) |

Rationale: money and scanner output are already Western; mixing systems inside one line
("منذ ٥ دقائق · 375.00 EGP") is the defect to remove; Western digits are the common convention on
printed Egyptian retail receipts (secondary sources — **owner to confirm against real pharmacy
receipts**). The currency label stays **`EGP`** (accepted in 023 Slice F finding 9, shipped via
RT-23); «ج.م» is an owner option, not a VNext default.

> Any change to `shared/money.ts` output (grouping, minus sign) is a presentation change with test
> impact on receipts and snapshots; it is its own slice (VN-S3) and must not alter integer
> minor-unit semantics.

---

## 5. Spacing, density and layout grid

- **4px base scale** — unchanged (`--space-1…9` = 4…96).
- **Two density profiles** (RT-24 "controlled customization", switchable **only between
  transactions**, never mid-sale):

| Token | Compact (default ≤1279px) | Comfortable (default ≥1280px) |
|---|---|---|
| `--density-gutter` | 8px | 12px |
| `--density-gap` | 8px | 12px |
| `--density-row-block` (cart row min height) | 52px | 60px |
| `--density-panel-pad` | 12px | 16px |
| `--density-titlebar` | 44px | 48px |

  Density never changes: target sizes (§8), type roles for money, visibility of total/next action,
  shortcut semantics.
- **Frame grid** (retained from V5): `[screen][nav]` in RTL order; nav 208px ≥1280 / 140px
  1024–1279, labels always visible. The workspace is a size container (`v5-screen`) and screens
  adapt with **container queries**, not viewport media queries. **Amended for Direction B
  (OD-7):** the labelled 208/140px nav applies off-sale only. On an active sale (Sale, Checkout
  and completion) the nav is the ≈76px slim rail (§16).
- **No nested cards.** Regions are separated by panel boundaries, hairlines or tint — never card in
  card (retained rule).

---

## 6. Elevation and surface hierarchy

Four levels, **flat by default**, borders before shadows:

| Level | Surface | Treatment | Examples |
|---|---|---|---|
| L0 Canvas | `--color-background` | none | page |
| L1 Panel | `--color-surface` | 1px hairline border, `--radius-card` 14px, no shadow | product rail, cart, tender panel |
| L2 Raised band | `--color-surface-elevated` | inside a panel; no shadow | titlebars, table header, sticky totals band |
| L3 Overlay | `--color-surface` on scrim | `--shadow-overlay`, `--radius-pane` 16px | dialogs, manager approval, lock |

Rules: shadows only on L3 (and the pairing pane, legacy). Sticky regions (totals, commit bar) use
L2 + a top hairline, not a shadow, so they survive forced-colors mode. Radii: controls 10px, panels
14px, overlays 16px, chips pill — `--radius-md` (4px) is not used for controls (fixes the V5
sign-out outlier).

---

## 7. Focus and keyboard states

- **Focus ring:** `outline: 2px solid var(--color-focus-ring); outline-offset: 2px` on every
  focusable element (retained). Focus is **never** expressed only by `box-shadow` (it disappears
  in Windows contrast themes) and never removed without a `:focus-within` replacement on the
  wrapper (audit list of `outline:none` sites to re-verify in VN-S2).
- **Contrast target:** ring ≥ 3:1 against both the control and its background (WCAG 2.4.13 AAA
  target adopted as the house standard for a keyboard-first terminal; teal `#0f766e` on white is
  5.47:1).
- **Focus not obscured (WCAG 2.4.11 AA):** scroll containers under a sticky totals/commit band set
  `scroll-padding-block-end` ≥ band height so a focused cart row is never hidden.
- **Keyboard selection ≠ focus.** Listbox active option (search results) uses `primary-soft` fill +
  2px inline-start bar + `aria-activedescendant`; focus stays in the input (already fixed in the
  023 polish pass — codified here).
- **Keyboard hint chips (`Kbd`):** 11–12px mono in a sunken pill on the control it accelerates,
  e.g. «الدفع ‹F8›». Hints are shown on primary cashier controls at comfortable density and on
  focus/hover at compact density. A hint is shown **only if the binding exists** in code (today
  none do — the static proof's "F2" is unbound). Key choices come from RT-24's proposed map and
  need conflict testing (see [08](08-rt24-invariants.md)).
- **Esc** always closes the top layer or performs the RT-24 safe back; it never commits or
  destroys.

---

## 8. Touch-target rules

| Control class | Minimum | Notes |
|---|---|---|
| Any interactive control | **44×44 px** | House floor (NFR-1), above WCAG 2.5.8's 24px AA minimum |
| Primary commit (Checkout CTA, Confirm payment, New sale) | **56px** block size, full panel width | 60px at comfortable |
| Tender method tiles | 72px (compact) / 84px (comfortable) | today 83px, retained |
| Numpad keys | 56×56 (compact) / 60×64 (comfortable) | spacing ≥ 8px |
| Quick-amount chips | 48px block | set, not add (RT-24) |
| Cart row actions (qty −/+, note, remove) | 44×44, ≥ 8px apart | destructive "remove" never adjacent to "+" |
| Chip/badge (non-interactive) | any | if interactive → 44px |

Destructive and commit actions are **spatially separated** (≥ 16px or separate region) from
frequent actions so a mis-tap never voids or pays.

---

## 9. Scanner-safe interaction

Behaviour belongs to RT-24; this section defines how it is **made visible**.

- **One scan owner.** Exactly one element owns scanner input at a time (today: the dedicated scan
  field `#v5-live-scan`). VNext adds a **Scan-owner indicator** in the product rail:
  - `جاهز للمسح` (teal dot) when the scan field has focus;
  - `المسح متوقف — اضغط F2 أو انقر هنا` (muted, sunken) when focus is elsewhere;
  - `المسح معلّق أثناء النافذة` when a dialog is open.
  This exposes the existing focus-dependent behaviour honestly instead of silently dropping scans.
- **Scanner never reaches** PIN fields, money fields, card reference, or a focused financial
  button. Financial confirmation is **never bound to bare Enter** (RT-24: no tendering via scanner
  Enter); financial confirm uses click/tap or `Ctrl+Enter`, shown on the button.
- **Dialogs over Sale** (confirm-add, note, void) show the scan-suspended state; a scan while a
  dialog is open must not activate the dialog's default button (known hazard,
  `slice-f-visual-review.md:151` — a behaviour fix in VN-S5, flagged in 08).
- **Immediate acknowledgement.** A resolved scan flashes the affected cart row (`primary-soft`
  150ms, none under reduced motion) and updates the count; unknown barcode shows an inline notice
  in the rail («لم يُعثر على الباركود 6221234567890») — never a modal.

---

## 10. Component vocabulary

One vocabulary, one implementation each, under `src/renderer/v5/**` (clean-room wall retained).
Full state matrix in [06-component-state-inventory.md](06-component-state-inventory.md).

**Frame:** `Frame`, `NavPanel`, `NavLink`, `Titlebar`, `StatusIndicator` (connection/sync/printer
cluster), `Banner` (persistent operational), `ScreenTooSmall`, `RouteLoading`, `ErrorScreen`.
**Actions:** `Button` (intents: primary · secondary · ghost · danger · danger-quiet; sizes md 44 /
lg 56), `Kbd`, `IconButton`.
**Inputs:** `SearchField`, `ScanTarget` (+ scan-owner states), `MoneyField`, `CodeField`
(card reference, staff code), `NoteField`, `PinPad`, `AmountPad`.
**Sale:** `ProductResultList` (listbox), `CartTable`, `CartRow`, `QtyStepper`, `TotalsBand`,
`CheckoutCTA`, `SuspendedSaleList`, `ResumeConflictPanel`.
**Checkout:** `OrderSummary` (frozen), `TenderPicker` (tiles incl. disabled-by-policy),
`CashEntry`, `QuickAmounts`, `CardTerminalEntry`, `PaymentLedger`, `PaymentOutcome`,
`RecoveryPanel`.
**Post-sale:** `CompletionPanel`, `ReceiptStatus`, `ReceiptPreview`.
**Overlays:** `Dialog` (single mechanism: focus trap, Esc, focus restore), `ConfirmDialog`
(destructive), `ManagerApprovalSheet`, `LockScreen`.
**Status atoms:** `Badge`, `StateLine` (icon + text + tone), `Notice` (inline, in-region).

Retired as vocabularies (kept alive only until their screens migrate): 007 `ui/primitives/*`
(unused in production), `.btn`, `.v4-*`, v3.5 `method-card/tender-row/quick-amount-btn`, legacy
`Workspace`, the four hand-rolled dialog mechanisms.

---

## 11. Status, error, warning and success treatment

| Tone | Where | Anatomy | Dismissal |
|---|---|---|---|
| **Inline notice** (info/warning/danger) | inside the region that caused it (rail, cart, tender panel) | icon + one-line Arabic sentence + optional action | clears when condition clears or on next action |
| **Banner** (warning/danger/info) | frame, under titlebar, full workspace width | icon + title + detail + ≤2 actions | **persistent** until condition resolves — never auto-dismiss |
| **Outcome panel** (success/info/danger) | Checkout/Completion main region | large icon + state sentence + reference + next action | replaced by next state |
| **Acknowledgement toast** (neutral) | bottom inline-end of workspace | text only, ≤ 4s | auto — **only** for user-initiated, non-financial acks ("تم حفظ الملاحظة") |
| **Blocking error screen** (danger) | replaces workspace | what happened + what is safe + what to do + support reference | only by resolving |

Copy rules: state *what is true*, *what is safe*, *what to do* — in that order.
Example (print failure): «تم البيع بنجاح. لم تُطبع الإيصال — الطابعة لا تستجيب. أعد المحاولة أو
سلّم إيصالاً يدويًا.» Never "Error 500", never English, never blame the cashier.

---

## 12. Offline and sync treatment

- **StatusIndicator** (frame, nav panel footer, always present): three compact rows — connection
  (`متصل` / `غير متصل`), sale sync (`لا شيء بانتظار المزامنة` / `3 مبيعات بانتظار المزامنة`),
  printer (`الطابعة جاهزة` / `الطابعة لا تستجيب`). Each: dot + text, never color alone.
- **Offline selling** → warning banner «أنت تعمل دون اتصال. المبيعات تُحفظ على هذا الجهاز وتُرسل
  تلقائيًا عند عودة الاتصال.» Sale continues; no modal.
- **Backlog needing attention** (sync `ATTENTION`/dead-letter) → danger banner with "تفاصيل" to a
  manager/diagnostics surface; the cashier is told the sale is safe locally.
- **Local success ≠ ERP posting** (RT-24): the completion panel never says «تم الترحيل»; posting
  status lives only in the sync indicator/diagnostics.
- **Dependency, not design:** today the connection state is hard-coded `online`
  (`connection-state.ts:18-23`) and `SaleSyncStatus` is unmounted. The visual treatment above is
  ready; making it truthful needs a real connectivity/sync signal — slice VN-S6 must not fake it.

---

## 13. Dialogs and manager-approval states

- **Dialogs are the last resort** (retained). Allowed for: confirm-add (current 009 confirm-first
  flow), note, destructive confirmation, manager approval, resume conflict, lock.
- **One `Dialog` mechanism**: `role="dialog"` + `aria-modal="true"`, focus moves to the first
  safe control (never to the destructive/commit button), Esc = cancel, focus returns to invoker,
  scanner suspended while open.
- **ManagerApprovalSheet** (RT-24 manager rules, RT-28 manager-only discounts):
  - shows **exactly what is being approved**: action, amount/percentage, sale reference, cart
    version («خصم 5% على «بنادول إكسترا» — 1.50 EGP»);
  - requires **reason** (select + optional note) before approval;
  - manager authenticates in the sheet (PIN/staff code) — the cashier's session is not replaced,
    no credential is shown or stored in the renderer;
  - outcomes: **approved** → returns to the exact prior state with the change applied and an
    audit line «وافق: أ. سامي · 14:05»; **denied** → returns to the exact prior state unchanged,
    inline notice «لم تتم الموافقة»; **cancelled** → prior state unchanged;
  - approval is bound to that cart version — if the cart changes, the sheet closes and
    approval must be requested again.
- **Destructive confirmation** (void line with care, cancel sale, cancel post-handoff): danger
  intent, states the consequence («سيتم إلغاء البيع بالكامل. لا يمكن التراجع.»), the safe option is
  the default focus.

---

## 14. Motion and reduced motion

- **State-change only.** Motion confirms something happened; it never decorates or delays.
- Tokens (retained from design.json): `--duration-1` 80ms (press), `--duration-2` 150ms (row
  flash, notice in), `--duration-3` 220ms (dialog in), `--ease-out` `cubic-bezier(.2,.7,.25,1)`.
  No springs, overshoot, bounce, parallax, skeleton shimmer longer than needed.
- **Never animate money values** during entry (the current animated change-due `MoneyRoll` is
  reviewed in VN-S4: a rolling number is hard to read and can show intermediate wrong values).
- `@media (prefers-reduced-motion: reduce)` → all durations 0 except focus ring; state changes
  remain visible by colour/text. Chromium follows the Windows "Animation effects" setting.
- Hard-coded durations in CSS (≈20 sites) move to tokens inside the slice that touches them.

---

## 15. Light / dark / high-contrast strategy

| Register | VNext status | Rule |
|---|---|---|
| **Light** | **The pilot register.** Default and only supported cashier theme for pilot. | All references and acceptance captures are light. |
| **Dark** | **Maintained, not offered in pilot** (Δ, owner decision OD-4). Token values stay in `:root[data-theme='dark']`; the toggle is not exposed on V5 surfaces. | A dark register is re-offered only after a dedicated QA slice captures every V5 screen in dark. Known dark defects (rail hover navy-on-navy) die with the legacy rail. |
| **Windows contrast themes** (`forced-colors: active`) | **Must work** (accessibility, not a theme). | Outlines not shadows; every state has text/icon/border; selected tiles use `Highlight`/`HighlightText`; `forced-color-adjust: none` only for product images. Verified by a forced-colors capture of Sale and Checkout (VN-S2). |

Theme and density changes only between transactions (RT-24).

---

## 16. 1024 and 1280 production behaviour

> **Amended for OD-7 = Direction B (approved 2026-10-01).** The table below is the approved B
> layout ([10-direction-comparison.md](10-direction-comparison.md); references `VN-B1-*`,
> `VN-B2-*`). Column widths are reference-kit values, to be confirmed in the real app by VN-S12
> (Sale and slim nav) and VN-S4 (Checkout content). The superseded Direction A table is kept
> after it for the record. The two places where earlier sections described the A composition,
> §2 (reading order) and §5 (frame grid), carry matching Direction B amendments. Every other
> section applies unchanged. The suspend controls in the B Sale row are conditional on VN-S11
> and the RT-24 §C.4 confirmation; VN-S12 must not ship them without that contract.

| Aspect | 1280×800 (comfortable) | 1024×768 (compact) |
|---|---|---|
| Nav, active sale (Sale, Checkout, completion — from the first item until «بيع جديد») | slim rail, icon + short label, ≈76px | slim rail, ≈76px |
| Nav, elsewhere | labelled panel, 208px | labelled panel, 140px |
| Sale | command bar (scan target · search · suspended-sales entry *(VN-S11)*) above a full-width cart; **money column** ≈320px on the inline end: total at the top, «الدفع», suspend *(VN-S11)* and cancel pinned at the bottom | same; money column ≈280px; cart ≥ 6 rows visible |
| Search results | dropdown over the cart, capped at 3–5 results, closes on Esc or selection | same |
| Checkout | 3 regions: order summary ≈280px · tender panel fluid · payment ledger ≈320px (amount due + commit pinned, in the money column's place) | 2 regions: tender panel fluid · payment ledger ≈296px; order summary collapses to a one-line strip with «عرض الأصناف» disclosure |

<details><summary>Superseded: the Direction A table (V5-based, not chosen)</summary>

| Aspect | 1280×800 (comfortable) | 1024×768 (compact) |
|---|---|---|
| Nav panel | 208px, labels | 140px, labels |
| Sale | product rail 360px · cart fluid · totals band + CTA pinned bottom | product rail 320px · cart fluid (≥ 6 rows visible) · total 24px |
| Checkout | 3 regions: order summary 280px · tender panel fluid · payment ledger 320px (amount due + commit pinned) | 2 regions: tender panel fluid · payment ledger 300px; order summary collapses to a one-line strip with «عرض الأصناف» disclosure |

</details>

| Aspect (both directions) | 1280×800 (comfortable) | 1024×768 (compact) |
|---|---|---|
| Amount due | always visible, `--type-amount-hero` | always visible, 36px |
| Dialogs | max 560px | max 520px |
| Below 1024 | `ScreenTooSmall` (Arabic copy — today English) | — |

Hard rule (P1/RT-24): at neither width may total, amount due, safe back/cancel, suspend (when
applicable) or the primary action be scrolled out of view.

---

## 17. What varies by POS profile (controlled customization)

Allowed (between transactions only): density profile, type scale ±1 step for body/product names,
light/contrast presentation, brand wordmark/accent within contrast limits (see OD-5 on the
«POS Pulse» / «Retail Tower POS» wordmark), optional quick-product surface (post-pilot).
Never varies: state machine, guards, shortcut meanings, visibility of total/payment/back/suspend,
completed-sale immutability, manager gates, money typography, one-primary rule.
