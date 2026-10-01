---
name: POS-Pulse
description: Arabic-first pharmacy POS terminal — a calm clinical instrument, light and exact.
colors:
  primary: "#0f766e"
  primary-emphasis: "#0b5b55"
  primary-soft: "#e6f4f1"
  primary-on: "#ffffff"
  background: "#f7f9fa"
  surface: "#ffffff"
  surface-elevated: "#f3f6fa"
  surface-sunken: "#eef2f6"
  text: "#0f1d2e"
  text-muted: "#53647a"
  text-inverse: "#ffffff"
  border: "#d8dfe7"
  border-soft: "#e7ecf2"
  border-strong: "#6f7b89"
  overlay-scrim: "rgba(8, 14, 24, 0.55)"
  success: "#15774d"
  success-emphasis: "#10603d"
  success-soft: "#e7f5ee"
  success-on: "#ffffff"
  warning: "#a35a00"
  warning-emphasis: "#7d4500"
  warning-soft: "#fdf1e0"
  warning-on: "#ffffff"
  danger: "#b3261e"
  danger-emphasis: "#8c1d18"
  danger-soft: "#fbe9e7"
  danger-on: "#ffffff"
  info: "#1b6ca8"
  info-emphasis: "#145184"
  info-soft: "#e4f0f9"
  info-on: "#ffffff"
typography:
  amount-hero:
    fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace"
    fontSize: "2.75rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "'tnum'"
  amount-total:
    fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "'tnum'"
  screen-title:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.3
  section:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.4
  control-lg:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  body-strong:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.6
  money-row:
    fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    fontFeature: "'tnum'"
  meta:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  kbd:
    fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
rounded:
  control: "10px"
  card: "14px"
  pane: "16px"
  pill: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "64px"
  "9": "96px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-on}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.primary-emphasis}"
  button-commit:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-on}"
    typography: "{typography.control-lg}"
    rounded: "{rounded.control}"
    height: "56px"
    width: "100%"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-on}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.danger-emphasis}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "44px"
  scan-target:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  tender-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control-lg}"
    rounded: "{rounded.control}"
    height: "72px"
  tender-tile-selected:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "12px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.pane}"
    width: "560px"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    height: "44px"
  nav-link-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
  badge:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    height: "24px"
  kbd-hint:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    typography: "{typography.kbd}"
    rounded: "{rounded.pill}"
---

# Design System: POS-Pulse

> **Authority.** This file is the operative design system for POS-Pulse agents and humans. It
> carries the owner-approved **RT-104 VNext** design language (approved 2026-10-01, Jira RT-104
> Done, package merged on `main` as `d04a385`). The long-form rationale lives in
> [`design/vnext/`](design/vnext/README.md); start with
> [`04-design-language.md`](design/vnext/04-design-language.md) and
> [`10-direction-comparison.md`](design/vnext/10-direction-comparison.md).
>
> - **RT-24 is the behaviour authority.** Nothing here changes transaction, payment, cart,
>   recovery, scanner, offline or manager semantics. If this file and RT-24 (or a merged
>   GitHub contract) disagree, the functional contract wins; raise the conflict
>   ([`08-rt24-invariants.md`](design/vnext/08-rt24-invariants.md)).
> - **Token values** in the frontmatter are the shipped light `:root` values in
>   `src/renderer/styles/tailwind.css` (the code is the source of values; if they ever differ,
>   the CSS wins and this file is stale).
> - **Approved, not yet shipped** items are tagged with the bounded slice that lands them, e.g.
>   *(VN-S2)*. Do not describe them as shipped and do not implement them outside that slice's
>   Jira issue ([`09-implementation-slices.md`](design/vnext/09-implementation-slices.md)).
> - **Still open** (do not resolve them by design): the RT-24 §C confirmations — direct add vs
>   confirm-first, lazy cart, same-device suspend/resume, key map; OD-3's validation against real
>   Egyptian pharmacy receipts; and the real-app capacity capture that must confirm Direction B
>   before VN-S12 ships.
> - Superseded: the v3.5 navy / Inter / dark-default system and `docs/design/pos-v3.5/`
>   (historical reference only).

## Overview

**Creative North Star: "The Accountable Instrument, in daylight"**

The terminal is a calm clinical instrument on a pharmacy counter. It is read at arm's length, under
overhead light, by a cashier whose hands are on a scanner and a keyboard while a customer waits.
Every screen answers three questions in this order: *what is in the sale and what does it cost*,
*what is the one next thing to do*, and *is anything not proven yet*. Anything not yet proven —
payment UNKNOWN, sale not finalized, receipt not printed, sale not synced, terminal offline — is
visible and named, never implied away.

The language is light, quiet, dense, exact and Arabic-first. It is not a new look: it codifies the
shipped 022 light pharmacy-teal system and the 023/V5 Sale screen, then completes them with the
rules they lacked (numerals, focus, scanner ownership, density, states, themes, 1024/1280). The
active-sale journey uses **Direction B** (OD-7): a cart-first workspace with a command bar, a
persistent money column, and a slim navigation rail from Sale through Checkout to completion.

The visual weight of anything tracks its consequence — neutral < primary < warning < destructive —
never brand flourish. It rejects dashboards, marketing gloss, playfulness, decoration and "AI app"
aesthetics.

**Key Characteristics:**
- Money is the loudest thing on screen, and the total / amount due is never scrolled out of view at 1024 or 1280.
- One filled-teal primary per region; teal is the commit colour, not decoration.
- Proven or labelled: success styling only for persisted facts (SETTLED, FINALIZED, PRINTED, POSTED).
- Quiet when healthy, loud when actionable: a small persistent status indicator, banners only when the cashier must act or must know.
- Keyboard and scanner first, touch-capable (44px floor); scanner input has one visible owner.
- Arabic-first RTL; money, codes and quantities are LTR-isolated Western digits with tabular figures.
- Light is the pilot register; Windows contrast themes (forced colours) must work; colour is never the only signal.

## Colors

One calm teal carries every commitment; everything else is cool, near-white clinical neutral, with
four status roles held strictly to status surfaces.

### Primary
- **Pharmacy Teal** (primary): the one next action — the commit button, the selected nav entry, the selected tender, the focus ring. White on it is 5.47:1.
- **Deep Teal** (primary-emphasis): hover and pressed state of the commit (7.95:1 on white).
- **Teal Wash** (primary-soft): selected-state fill — active nav entry, selected tender tile, listbox active option, scan-acknowledge row flash — always with Pharmacy Teal ink (4.84:1 on the wash).

### Neutral
- **Clinical Canvas** (background): the page behind panels.
- **Clean White** (surface): panels, the cart, dialogs.
- **Raised Band** (surface-elevated): titlebars, table headers, the sticky totals band.
- **Recessed Well** (surface-sunken): the scan target, keypad well, disabled tiles, keyboard-hint chips.
- **Clinical Ink** (text): all primary text and every numeral (17:1).
- **Muted Ink** (text-muted): secondary text, meta, hints — 12px and up only; never money or errors.
- **Hairline** (border, border-soft): decorative dividers only.
- **Control Edge** (border-strong): the boundary of every input, button and tile (≥3:1, WCAG 1.4.11).
- **Scrim** (overlay-scrim): behind modal dialogs and the lock screen.

### Status
- **Proven Green** (success family): proven outcomes only, and the healthy indicator dot.
- **Degraded Amber** (warning family): degraded but operable — offline selling, stale catalogue, printer failed after a completed sale.
- **Consequence Red** (danger family): destructive actions (void, cancel sale), blocking errors, and UNKNOWN payment results.
- **Pending Blue** (info family): syncing, informational notices, and "recorded but not yet proven downstream".

### Named Rules
**The Commit-Teal Rule.** Filled teal appears on at most one control per region, plus selected-state washes. Large teal fills are allowed for the primary commit — the v3.5 One-Accent Rule is superseded.

**The No-Accent Rule.** There is no separate accent role. Selection is `primary-soft` fill + `primary` ink + a 2px inline-start bar + `aria-current`. The legacy `--color-accent` (equal to primary today) and the dark `--color-rail*` tokens exist only for legacy surfaces until VN-S10 retires them; new work never uses them.

**The Status-Containment Rule.** Status colours appear only on status surfaces: banner, indicator, badge, outcome panel, destructive button. Never as decoration, hover accent or brand fill.

**The Pending-Is-Not-Success Rule.** "Recorded but not yet proven downstream" (payment SETTLED while the sale is still FINALIZING; sale FINALIZED but not POSTED) uses info, not success. Success green is reserved for the proven fact the cashier is being told about.

**The UNKNOWN-Is-Not-A-Decline Rule.** An UNKNOWN card result uses the danger role with «النتيجة غير مؤكدة», never the word «مرفوض».

The dark register (`:root[data-theme='dark']`) is maintained but **not offered** in the pilot (OD-4); it returns only after a dedicated dark QA slice captures every V5 screen.

## Typography

**Body Font:** Dubai (with Segoe UI, Tahoma, Arial, system-ui)
**Mono Font:** ui-monospace (with Cascadia Code, JetBrains Mono, Consolas)

**Character:** one quiet Arabic-first system face for every word (Dubai ships with Windows 10/11), and a monospace with tabular figures for every amount, quantity and code, so digits align in dense cart rows and totals never jitter. No font is bundled (OD-2: Dubai is kept for the pilot; the bundled-font option is declined), so the `no-brand-font` guard stays green.

### Hierarchy
The frontmatter roles map onto the shipped size scale; the `--type-*` role tokens themselves land in *(VN-S2)* — until then, pick the scale size the role names, not a raw literal.

- **Amount hero** (700, 44px, 1.1, mono tabular): the Checkout amount due and the completion amount. 36px at 1024.
- **Amount total** (700, 30px, 1.1, mono tabular): the Sale grand total and ledger totals. 24px at 1024 compact.
- **Screen title** (700, 20px, 1.3): one per screen, in the titlebar.
- **Section** (700, 16px, 1.4): panel headings.
- **Control large** (700, 16px, 1.3): the primary commit button and tender tile labels.
- **Body / body strong** (400 / 600, 14px, 1.6): default cashier text; product names and button text are strong.
- **Money row** (600, 14px, 1.4, mono tabular): line prices and ledger rows.
- **Meta** (400–600, 12px, 1.5): hints, secondary names, timestamps.
- **Kbd** (600, 11px, mono): keyboard-hint chips only — the one place below 12px is allowed.

### Numerals
Approved policy (OD-3): **Western digits everywhere** — money, quantities, counts, times, dates, barcodes, SKUs, sale and receipt numbers, terminal ids. Money reads `1,250.00 EGP`: thousands grouping, two decimals, the `EGP` label, minus as U+2212 at the inline start of the isolated run. Times use the pinned `ar-EG-u-nu-latn` locale. Inputs accept Arabic-Indic and Persian digits and normalise them to ASCII before validation.

Today's code still prints `123.45 EGP` with no grouping, and renders some times and counts in Arabic-Indic digits; the change is *(VN-S3, absorbed into VN-S12)*, must not alter integer minor-unit semantics, and stays subject to the still-open check against real Egyptian pharmacy receipts.

### Named Rules
**The Twelve-Pixel Rule.** Nothing a cashier must read is below 12px; 11px exists only for keyboard-hint chips.

**The Arabic Leading Rule.** Arabic body text keeps line-height ≥ 1.5 — ascenders, descenders and dots clip at 1.25. Long product names wrap to two lines in the cart, then ellipsis, with the full name in the row's accessible name.

**The Plain Emphasis Rule.** No italics and no all-caps; weight carries emphasis. All-caps Latin codes hurt scanning of `O/0` and `I/1`.

## Layout

**RTL composition.** `<html lang="ar" dir="rtl">` is set once at the root; components never re-declare RTL and only declare `dir="ltr"` on isolated Latin runs. Reading order is importance order: the inline start (right) holds *where you are and what you are adding*; the inline end (left) holds *money and the commit action*. Only CSS logical properties are used; a physical `left/right` needs a code comment explaining why. Money, quantities, barcodes, SKUs, sale and receipt numbers, terminal ids, times, card references and Latin product names are LTR-isolated (`unicode-bidi: isolate` or `<bdi>`) — isolate the number, never the whole Arabic sentence. Keypads stay LTR (1-2-3 on the top row). Direction-implying icons mirror; search, scan, print, lock, clock and check never do.

**Spacing.** A 4px base scale (4 to 96). Two density profiles, switchable only between transactions, never mid-sale: **compact** (8px gutter and gap, 52px cart rows, 12px panel padding, 44px titlebar) and **comfortable** (12px gutter and gap, 60px rows, 16px padding, 48px titlebar). The profile follows the width of the `v5-screen` workspace container, not the viewport. Shipped code switches to compact at a container width of 1120px or less (`live-sale.css`). With Direction B's slim nav, that means compact in a 1024 window and comfortable in a 1280 window. The density tokens land in *(VN-S2)*. Density never changes target sizes, money type, the visibility of the total and next action, or shortcut meanings.

**Frame — Direction B (OD-7).** The workspace is a size container and screens adapt with container queries, not viewport media queries. Navigation sits on the inline end (left), after the screen.

| Aspect | 1280×800 (comfortable) | 1024×768 (compact) |
|---|---|---|
| Nav on an active sale (Sale, Checkout, completion — first item until «بيع جديد») | slim rail, icon + short label, ≈76px | slim rail, ≈76px |
| Nav elsewhere (sign-in boundary, manager/admin screens) | labelled panel, 208px | labelled panel, 140px |
| Sale | command bar (scan target, search, suspended-sales entry *(VN-S11)*) above a full-width cart; money column ≈320px on the inline end: total at the top, «الدفع», suspend *(VN-S11)* and cancel at the bottom | same, money column ≈280px; at least 6 cart rows visible |
| Search results | drop down over the cart, 3–5 results, close on Esc or selection | same |
| Checkout | order summary ≈280px · tender panel fluid · payment ledger ≈320px (amount due and commit pinned) | tender panel fluid · payment ledger ≈296px; summary collapses to a one-line strip with «عرض الأصناف» |
| Below 1024 | `ScreenTooSmall`, Arabic copy *(VN-S2; today English)* | — |

The money column keeps the same place through the whole journey: the Sale total becomes the Checkout amount due and «الدفع» becomes «تأكيد الدفع». Column widths are reference-kit values (`design/vnext/references/`), confirmed in the real app by *(VN-S12)* (Sale layout and slim nav) and *(VN-S4)* (Checkout content); today's shipped Sale is still the Direction A V5 layout.

**The Never-Scrolled-Away Rule.** At neither width may the total, the amount due, the safe back/cancel, suspend (when applicable) or the primary action be scrolled out of view.

**Touch targets.** Every interactive control is at least 44×44px. The primary commit is 56px tall and full panel width (60px at comfortable). Tender tiles are 72px (compact) / 84px (comfortable); numpad keys 56×56 / 60×64 with ≥ 8px spacing; quick-amount chips 48px (they *set* the amount, never add). Cart row actions are 44×44 and ≥ 8px apart, and remove is never adjacent to plus. Destructive and commit actions are separated from frequent actions by ≥ 16px or a separate region.

## Elevation & Depth

Flat by default, borders before shadows. Four levels: **canvas** (background, no treatment), **panel** (surface, 1px hairline, card radius, no shadow — product search, cart, tender panel, money column), **raised band** (surface-elevated inside a panel, no shadow — titlebars, table headers, the sticky totals band) and **overlay** (surface on the scrim, with the overlay shadow and pane radius — dialogs, manager approval, lock). Sticky regions use a raised band plus a top hairline instead of a shadow, so they survive forced-colours mode.

### Shadow Vocabulary
- **Overlay** (`0 20px 25px -5px rgba(0,0,0,0.25), 0 8px 10px -6px rgba(0,0,0,0.25)`): dialogs, manager approval sheet, lock screen. The only shadow new work uses.
- **Pane** (`0 18px 60px rgba(15,29,46,0.10)`): the legacy pairing pane only.
- `--shadow-card` and `--shadow-inset` remain for legacy surfaces until they migrate; they are not used on V5/VNext panels.

### Named Rules
**The Borders-Before-Shadows Rule.** Depth below the overlay level is expressed with hairlines and tint, never shadow.

**The Forced-Colours Rule.** Every state stays distinguishable in Windows contrast themes: outlines rather than shadows, text, icon or border on every state, `Highlight`/`HighlightText` on selected tiles, and `forced-color-adjust: none` only for product images. A forced-colours capture of every touched surface is part of each slice's evidence.

## Shapes

Gently rounded, consistent by role: controls (buttons, fields, tiles, nav entries) 10px; panels 14px; overlays 16px; chips, badges and keyboard hints a full pill. The 2px, 4px and 8px radii exist in the token scale but are not used for controls (the V5 sign-out button at 4px is the known outlier). Panels never contain panels.

## Components

One vocabulary, one implementation each, under `src/renderer/v5/**` (the clean-room wall stays). The full state matrix is [`06-component-state-inventory.md`](design/vnext/06-component-state-inventory.md). The legacy 007 `ui/primitives/*`, `.btn`, `.v4-*`, the v3.5 tender classes and the four hand-rolled dialog mechanisms are retired vocabularies, kept alive only until their screens migrate.

### Buttons
- **Shape:** control radius (10px); sizes medium 44px and large 56px.
- **Primary / commit:** Pharmacy Teal fill, white text. The commit (Checkout CTA, confirm payment, new sale) is large and full panel width. Hover deepens to Deep Teal.
- **Secondary:** white surface with a Control Edge boundary and ink text — supporting actions next to a primary.
- **Ghost:** transparent, ink text — cancel, back, low-commitment navigation.
- **Danger / danger-quiet:** Consequence Red fill (or red ink on white for the quiet form) — void, cancel sale, cancel after handoff. Hover deepens to the danger emphasis.
- **Focus:** `outline: 2px solid` the focus ring (primary) with a 2px offset on every focusable element — never only a box-shadow, which disappears in contrast themes.
- **Disabled-by-policy:** visibly present, sunken, with a reason line (the RT-103 internal-voucher tender tile is the reference case).

### Keyboard hints
A Recessed Well pill with an 11–12px mono key, on the control it accelerates (for example «الدفع ‹F8›», once that key is bound). Always shown at comfortable density and on focus/hover at compact density. A hint appears **only if the binding exists in code** — no key is bound today; the key map awaits RT-24 confirmation and conflict testing *(VN-S5)*.

### Inputs / Fields
- **Style:** white surface, Control Edge boundary, control radius, 44px minimum.
- **Focus:** the 2px teal outline with 2px offset.
- **Error / disabled:** danger boundary plus a message in the same region; disabled dims label and value together.
- **Scan target:** a Recessed Well field in the command bar with a visible scan-owner state — «جاهز للمسح» (teal dot) when it has focus, «المسح متوقف — …» (muted) when focus is elsewhere, «المسح معلّق أثناء النافذة» while a dialog is open *(VN-S3/VN-S12)*. The scanner never reaches PIN, money or card-reference fields or a focused financial button; financial confirmation is never bound to bare Enter.

### Cart and money column
Cart rows show name (wrapping to two lines), quantity stepper, unit price and line total as LTR-isolated tabular figures. A resolved scan flashes the affected row with Teal Wash for 150ms (none under reduced motion); an unknown barcode shows an inline notice with the scanned code — never a modal. The money column holds the total at the top and the commit and cancel at the bottom, all pinned. The suspend control and the suspended-sales entry are added only by *(VN-S11)*, after the park/resume contract and the RT-24 §C.4 confirmation. VN-S12 lays out their place but must not ship them without that contract.

### Checkout
`OrderSummary` (frozen), `TenderPicker` (tiles, including disabled-by-policy), `CashEntry` with `QuickAmounts`, `CardTerminalEntry`, `PaymentLedger` (amount due pinned at hero size), `PaymentOutcome` and `RecoveryPanel` for UNKNOWN, cancelling and reversal states. Selected tender tile: Teal Wash fill, Pharmacy Teal ink and boundary. Money values are never animated during entry (the current `MoneyRoll` is removed in *(VN-S4)*).

### Navigation
- **Labelled panel** (208 / 140px) off-sale, **slim rail** (≈76px, icon + short 12px label) during an active sale.
- **Default:** muted ink on canvas, control radius, 44px entries.
- **Active:** Teal Wash fill, Pharmacy Teal ink, a 2px inline-start bar and `aria-current="page"`.
- Cashiers do not see unavailable or unauthorised placeholder routes (OD-6); manager and admin roles keep them *(VN-S10)*.
- The nav footer hosts the **status indicator**: connection, sale sync and printer, each a dot plus text *(VN-S6)*.

### Status and feedback
| Form | Where | Anatomy | Dismissal |
|---|---|---|---|
| Inline notice (info/warning/danger) | inside the region that caused it | icon + one Arabic sentence + optional action | clears with the condition or the next action |
| Banner (warning/danger/info) | frame, under the titlebar, full workspace width | icon + title + detail + ≤ 2 actions | persistent until the condition resolves |
| Outcome panel (success/info/danger) | Checkout / completion main region | large icon + state sentence + reference + next action | replaced by the next state |
| Acknowledgement toast (neutral) | inline-end bottom of the workspace | text only, ≤ 4s | only for user-initiated, non-financial acknowledgements |
| Blocking error screen (danger) | replaces the workspace | what happened + what is safe + what to do + support reference | only by resolving |

Copy states what is true, what is safe, and what to do — in that order, in Arabic, never blaming the cashier and never "Error 500". Offline selling is a warning banner while the sale continues; a sync backlog needing attention is a danger banner that tells the cashier the sale is safe locally. The completion panel never says «تم الترحيل» — posting status lives only in the sync indicator. Today the connection state is hard-coded online and the sync status is unmounted; the treatment above must be driven by a real signal *(VN-S6)*, never faked.

### Dialogs and manager approval
One `Dialog` mechanism: `role="dialog"`, `aria-modal`, focus on the first *safe* control (never the destructive or commit button), Esc cancels, focus returns to the invoker, scanner suspended while open. Dialogs are a last resort — confirm-add, note, destructive confirmation, manager approval, resume conflict, lock. The **manager approval sheet** states exactly what is approved (action, amount, sale reference, cart version), requires a reason, authenticates the manager inside the sheet without replacing the cashier's session, and returns to the exact prior state on approved, denied or cancelled. Approval is bound to the cart version.

### Motion
State-change only, from the shipped motion tokens: 80ms press, 150ms row flash and notice in, 220ms dialog in, `ease-out` `cubic-bezier(0.2, 0.7, 0.25, 1)`. No springs, overshoot, bounce or parallax. Under `prefers-reduced-motion: reduce` every duration is zero except the focus ring, and the state change stays visible by colour and text.

## Do's and Don'ts

### Do:
- **Do** keep the total (Sale) and amount due (Checkout) as the largest numerals, in tabular mono, visible without scrolling at 1024×768 and 1280×800.
- **Do** use exactly one filled-teal primary per region and reserve the large commit (56px, full width) for the one next action.
- **Do** isolate every money value, quantity and code as an LTR run with Western digits and tabular figures.
- **Do** keep the money column in the same place from Sale through Checkout to completion (Direction B).
- **Do** give every state text and/or an icon in addition to colour, and verify it under forced colours.
- **Do** draw control boundaries with Control Edge (`border-strong`) and keep the hairline (`border`) for decorative dividers.
- **Do** show the scan owner, and suspend scanning visibly while a dialog is open.
- **Do** use info (Pending Blue) for recorded-but-unproven states and success only for proven facts.
- **Do** tag anything not yet shipped with its VN slice, and stop and raise it if a visual choice would change RT-24 behaviour.

### Don't:
- **Don't** use the superseded v3.5 system — navy `#1f4e7a`, Inter, dark default, the One-Accent Rule, the dark command rail — for new work.
- **Don't** use `--color-accent` or `--color-rail*` on new surfaces; they exist only until the legacy shell is retired (VN-S10).
- **Don't** offer the dark theme or a theme toggle on cashier surfaces in the pilot.
- **Don't** show success colour, a check icon or a success word before the underlying fact is persisted.
- **Don't** call an UNKNOWN payment a decline, or a local sale "posted".
- **Don't** auto-dismiss operational state (offline, sync attention, printer, drawer, shift closed) — those are persistent banners.
- **Don't** animate money values during entry, or use bounce, elastic or decorative motion.
- **Don't** bind financial confirmation to bare Enter, or show a keyboard hint for a key that is not bound.
- **Don't** use shadows below the overlay level, nest panels, or put status colours on decoration.
- **Don't** mix numeral systems on one screen, or write bilingual headings such as «طريقة الدفع (Payment method)».
- **Don't** use the RT-27 Tower Blue palette or the 022 handoff's Saudi/ZATCA/15% VAT/mada content; they are references, not authority, for this Egyptian product.
