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
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "'tnum', 'lnum'"
  amount-total:
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "'tnum', 'lnum'"
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
    fontFamily: "'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    fontFeature: "'tnum', 'lnum'"
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
    textColor: "{colors.text-muted}"
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

> **Authority.** This file is the POS repository's record of the shipped design tokens and its
> working summary of the design rules for agents and humans. It carries the owner-approved
> **RT-104 VNext** design language (approved 2026-10-01, Jira RT-104 Done, package merged on
> `main` as `d04a385`), reconciled with the **UX/UI Constitution** by RT-261. The long-form
> rationale lives in [`design/vnext/`](design/vnext/README.md); start with
> [`04-design-language.md`](design/vnext/04-design-language.md) and
> [`10-direction-comparison.md`](design/vnext/10-direction-comparison.md).
>
> **Precedence** (Confluence RETAIL, VNext Constitution Rebaseline, 2026-10-07). A higher layer
> wins over every layer below it:
>
> 1. **RT-24 and later approved domain / behaviour contracts.** Nothing here changes transaction,
>    payment, cart, recovery, scanner, offline or manager semantics. If this file and RT-24 (or a
>    merged GitHub contract) disagree, the functional contract wins; raise the conflict
>    ([`08-rt24-invariants.md`](design/vnext/08-rt24-invariants.md)).
> 2. **UX/UI Constitution UX-01…UX-13 and its
>    [Final Audit](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24510466)**
>    (owner-approved 2026-10-07). It owns the target visual language, interaction, motion,
>    states, accessibility, copy and localization. The modules this file applies most are
>    [UX-02 colour](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24150017),
>    [UX-03 type and icons](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/22839299),
>    [UX-04 layout and shape](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24215553),
>    [UX-06 motion](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/22806531) and
>    [UX-12 copy and localization](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24477697).
> 3. **The [VNext Constitution Rebaseline](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/23134234)**:
>    which parts of the freeze the Constitution changes, and which it keeps.
> 4. **The freeze package** [`15-vnext-freeze-package.md`](design/vnext/15-vnext-freeze-package.md)
>    (RT-159), with the owner decisions it records, the owner-approved G-1, G-2, G-3 and G-6
>    references, and the plans that follow it (for icons, the RT-263 plan
>    [`25`](design/vnext/25-rt263-icon-registry-fluent-poc.md)). It is kept wherever the
>    Rebaseline does not amend it.
> 5. **This file.** It records the shipped tokens and applies layers 1–4 to this repository. It
>    does not override them. Where an owner decision is newer than older text, the owner
>    decision wins.
>
> Below these layers come the Visual Acceptance Pack (a visual and state reference; Constitution
> rules override its colours, type, motion, copy and component treatment), the implementation
> references (shadcn/ui, MUI / MUI X: patterns only, no dependency), and older references and
> prototypes (historical context only).
>
> - **Shipped vs target.** **Token values** in the frontmatter are the shipped light `:root`
>   values in `src/renderer/styles/tailwind.css` (the code is the source of values; if they ever
>   differ, the CSS wins and this file is stale). Where the Constitution sets a different target,
>   the text says so and names the module, for example *(target, UX-04)*. A target is not
>   shipped. It changes the code only through its own bounded Jira slice, and that slice must
>   meet the evidence gate the module names. The
>   [Constitution reconciliation](#constitution-reconciliation-rt-261) table lists every such
>   target.
> - **Approved, not yet shipped** items are tagged with the bounded slice that lands them, e.g.
>   *(VN-S2)*. Do not describe them as shipped and do not implement them outside that slice's
>   Jira issue ([`09-implementation-slices.md`](design/vnext/09-implementation-slices.md)).
> - **Still open** (do not resolve them by design): the RT-24 §C confirmations — lazy cart,
>   same-device suspend/resume, key map (D-K1 deferred by the owner on 2026-10-20: wave 1 stays keyless; direct add vs confirm-first is resolved by owner decision
>   D-C1, 2026-10-07: direct add, see `design/vnext/15-vnext-freeze-package.md` §3); OD-3's validation against real
>   Egyptian pharmacy receipts (printed receipts, Q-4). Undo of the last add or delete (D-U1) shipped in #621 and was
>   ratified by the owner on 2026-10-20.
> - Superseded: the v3.5 navy / Inter / dark-default system and `docs/design/pos-v3.5/`
>   (historical reference only).

## Constitution reconciliation (RT-261)

What the Constitution keeps, and where its target differs from what ships today. Verified against
`main` at `673a8f9`. "Shipped" is what the code does; "Target" is not shipped until its slice
lands.

| Topic | Shipped on `main` | Constitution target | Authority | How it changes |
|---|---|---|---|---|
| Brand name | The primary is called "Pharmacy Teal" | **Tower Teal**, `#0F766E` (same value) | UX-02 | Name only, in this file. The sidecar `.impeccable/design.json` still says "Pharmacy Teal" (Q-2) |
| Neutrals | The cool near-white values in the frontmatter | Low-chroma **mineral neutrals** ("Mineral Daylight") with a slight blue-green relation to Tower Teal. Exact values are not decided | UX-02 | A later token slice. It must pass UX-02's "Color Under Pressure" gate |
| Accent | No accent role | No secondary brand accent | UX-02 | No change |
| Theme | Light; the dark register is kept in CSS but not offered | Light-first; dark deferred; future themes remap semantic roles only | UX-02 | No change |
| Money typeface | The UI sans (Dubai) with **tabular lining numerals** through `--font-family-money` (`amount-hero`, `amount-total`, `money-row`); monospace only for IDs, codes and evidence | The UI sans with **tabular lining numerals**; monospace only for IDs, codes and evidence | UX-03. Owner decision 2026-10-22 on RT-262: variant B | Done in the renderer by **RT-814**. Not covered: the printed receipt and the receipt-slip preview (RT-476); the `v5-void-num` and `v5-recovery-num` classes still mix IDs with amounts and stay mono until their markup is split |
| UI font | Dubai | Dubai stays the incumbent. IBM Plex Sans Arabic is the challenger; Noto Sans Arabic UI is the readability control | UX-03 | Only after a same-screen A/B (RT-262) shows a clear gain |
| Type role names | `--type-*` aliases (RT-241), values unchanged | UX-03's role vocabulary (`money-hero`, `money-total`, `numeric-row`, `machine`, …) | UX-03 | Mapping in [Typography](#typography). Renaming waits for a later slice |
| Icons | The semantic registry with vendored Fluent Regular glyphs is shipped (`src/renderer/icons/`, IC-1 / RT-692, no npm dependency), and every POS consumer uses it (IC-2 / RT-695, #760; `V5Icon` deleted) | Every consumer on the registry: **Fluent System Icons** by semantic name (`icon.sale`, `icon.cart`, …) | UX-03; RT-263 plan [25](design/vnext/25-rt263-icon-registry-fluent-poc.md) | Done for POS. Visual fit owner-approved 2026-10-20 (D-263-1, D-263-5, D-263-8) |
| Radius | Control 10 px, panel 14 px, overlay 16 px, pill | Control **8 px**, contained object **12 px**, overlay **16 px**; work surfaces near-square; pills only for status, counts and tags | UX-04 | A staged migration in its own slice. Shipped tokens stay as they are until then |
| Density | Two profiles: compact and comfortable | Three modes: Comfortable, Operational, Compact | UX-04 | Open (Q-1) |
| Motion | 80 / 150 / 220 ms and `ease-out`; a fourth 320 ms duration token also exists | Contact 80 ms, Signal 150 ms, Continuity 220 ms, same easing; no arbitrary durations | UX-06 | No value change. New work uses only the three roles |
| Rolling money | `MoneyRoll` is gone (RT-243 F1, #583) | Money never rolls or counts up | UX-06 | Done. Do not reintroduce it |
| Money format | The renderer's UX-12 formatter (`src/renderer/ui/format/human-format.ts`) prints `1,250.00 EGP`. `shared/money` `format()` still prints ungrouped `1250.00 EGP` | Grouped, two decimals, `EGP`, LTR-isolated, minus U+2212 | UX-12 | Move the remaining human-facing surfaces to the formatter. Arithmetic stays integer minor units |
| Time | `ar-EG-u-nu-latn`, 24-hour, in the terminal's time zone | Readable Arabic date with Western digits and a 24-hour clock, in the **Store's** time zone; evidence uses exact time with an explicit zone | UX-12 | The Store time zone waits on RT-279 |
| Counts and plurals | An Arabic plural helper exists (`src/shared/formatters/arabic-plural.ts`); not every surface is verified to use it | Noun-first counters in dense metadata («الأصناف: 11 · الوحدات: 23»); full plural messages in prose | UX-12 | Per surface, in its own slice |

### Open questions

These are real conflicts that no approved decision settles yet. Each records the option this file
follows for now. It is marked **Selected — recommended option, owner may revisit**.

- **Q-1 Density modes.** UX-04 names three modes (Comfortable, Operational, Compact). POS ships two
  profiles (compact, comfortable) that follow the `v5-screen` container. No approved decision maps
  the two onto the three. **Selected — recommended option, owner may revisit:** this file keeps the
  two shipped profiles under their current names and does not assign them UX-04 mode names. The
  slice that implements UX-04 density decides the mapping.
- **Q-2 Brand name and the sidecar.** RT-261 renames the primary to «Tower Teal» but does not scope
  `.impeccable/design.json`, which still names it "Pharmacy Teal" (RT-814 corrected its money
  wording to the UI sans with tabular lining numerals). **Selected — recommended option, owner may revisit:** rename in this file only,
  and leave the sidecar unchanged. Regenerate the sidecar in a later docs pass, with the same
  "shipped vs target" split as this file.
- **Q-3 Freeze package wording.** 15 §4 still lists `--type-money-row 14 mono tnum` as the target
  and says VN-S2 is "role aliases only, no value changes". The Rebaseline amends both: mono money is
  no longer the target, and the alias rule only constrains W1-A. RT-261 does not scope 15.
  **Selected — recommended option, owner may revisit:** leave 15 unedited. This file and the
  Rebaseline carry the amendment, and the Rebaseline outranks 15.
- **Q-4 Grouped money and real receipts.** OD-3 keeps a check against real Egyptian pharmacy
  receipts open, and 15 says that check gates `shared/money` grouping. UX-12 later fixed grouped
  `1,250.00 EGP` as the on-screen target. **Selected — recommended option, owner may revisit:**
  UX-12 governs on-screen money. The receipt check stays open for printed receipts only, which UX-12
  treats as a separate contractual decision.

The owner-approved G-1, G-2, G-3 and G-6 references draw the shipped radii (10 / 14 / 16 px) and
monospace money. They stay valid layout and state references. The radius and money-type slices
update the comparison when they land, so a difference from the target is not a regression in
those references.

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

One calm teal carries every commitment; everything else is a quiet near-white neutral, with four
status roles held strictly to status surfaces. The Constitution names this direction **Mineral
Daylight + Tower Teal** (UX-02). POS and Admin-Console share one semantic colour system and differ
only in how densely they use it. The neutral values below are the shipped record. The
low-chroma mineral neutrals UX-02 asks for, with a slight blue-green relation to Tower Teal and
neither cold clinical grey nor warm beige, are not decided yet *(target, UX-02)*.

### Primary
- **Tower Teal** (primary, `#0F766E`; called Pharmacy Teal before RT-261, same value): the one next action — the commit button, the selected nav entry, the selected tender, the focus ring. White on it is 5.47:1.
- **Deep Teal** (primary-emphasis): hover and pressed state of the commit (7.95:1 on white).
- **Teal Wash** (primary-soft): selected-state fill — active nav entry, selected tender tile, listbox active option, scan-acknowledge row flash — always with Tower Teal ink (4.84:1 on the wash).

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

**The No-Accent Rule.** There is no separate accent role. Selection is `primary-soft` fill + `primary` ink + a 2px inline-start bar + `aria-current`.

**The Status-Containment Rule.** Status colours appear only on status surfaces: banner, indicator, badge, outcome panel, destructive button. Never as decoration, hover accent or brand fill.

**The Pending-Is-Not-Success Rule.** "Recorded but not yet proven downstream" (payment SETTLED while the sale is still FINALIZING; sale FINALIZED but not POSTED) uses info, not success. Success green is reserved for the proven fact the cashier is being told about.

**The UNKNOWN-Is-Not-A-Decline Rule.** An UNKNOWN card result uses the danger role with «النتيجة غير مؤكدة», never the word «مرفوض».

**The Brand-Yields-To-Truth Rule (UX-02).** Colour priority is critical truth → primary action → current context or selection → brand identity → decoration. When an operational state is present, its status colour wins over teal. Teal means intent (action, selection, focus); it is never success green.

**The No-Second-Accent Rule (UX-02).** No permanent secondary brand accent (purple, coral, orange or any other) is added. A future need must first be shown by Admin or data-visualisation work. Chart palettes belong to UX-13 and never borrow the status colours.

**The No-Gradient Rule (UX-02).** No gradients on POS surfaces, tables, forms, operational buttons or status surfaces. Most pixels stay neutral, so the scarce saturated colour keeps its meaning.

### Signatures (UX-02)
Retail Tower is recognised by how it behaves, not by ornament. Each signature appears only where it carries real structure or state:
- **Mineral Layering:** depth through canvas, surface, recessed and overlay tones (see Elevation).
- **Signal Line:** the 2px inline-start bar that marks current context or selection, in logical (RTL-correct) position.
- **Pulse Dot:** a small state dot (ready, connected, syncing, attention). It is static while healthy or ready and moves only during genuine activity, never under reduced motion (UX-06).
- **Precision Ledger:** money and operational relationships as aligned label / value rows with tabular numerals, separators and an anchored total, not one card per value.

Light is the only offered theme (UX-02: light-first; dark deferred). The dark register (`:root[data-theme='dark']`) is maintained in CSS but **not offered** in the pilot (OD-4); it returns only after a dedicated dark QA slice captures every V5 screen. Components consume semantic role tokens, so a future dark or high-contrast theme remaps roles without changing what a component means.

## Typography

**Body Font:** Dubai (with Segoe UI, Tahoma, Arial, system-ui)
**Mono Font:** ui-monospace (with Cascadia Code, JetBrains Mono, Consolas)

**Character:** one quiet Arabic-first system face for every word (Dubai ships with Windows 10/11), and the same face with tabular lining numerals for every amount and quantity (`--font-family-money`, RT-814), so digits align in dense cart rows and totals never jitter. No font is bundled (OD-2: Dubai is kept for the pilot; the bundled-font option is declined), so the `no-brand-font` guard stays green.

**Type jurisdiction (UX-03).** The UI sans owns language. Tabular numerals own prices, quantities and comparable values. Monospace owns machine-readable IDs, codes and evidence (SKU, barcodes, sale and receipt references, terminal and request IDs). Monospace is never used on ordinary UI to look technical.

- **Money typeface — shipped.** Amounts and quantities use the UI sans (Dubai) with **tabular lining numerals** through `--font-family-money` (an alias of the sans token). Monospace is kept for IDs, SKUs, codes, PIN and reference fields, key hints and evidence. The owner decided on 2026-10-22 (RT-262, variant B) after the rendered same-screen A/B; RT-814 applied it. Dubai digits are already fixed-width and lining, so no font file or feature is added. The printed receipt and the receipt-slip preview keep their own typography (RT-476).
- **Font — incumbent and challenger.** Dubai stays the incumbent and a legitimate long-term choice. IBM Plex Sans Arabic is the challenger, and Noto Sans Arabic UI is the readability control. A font change needs a rendered same-screen A/B on Retail Tower screens (RT-262) that clearly beats Dubai on readability, mixed-script behaviour, density and character *(UX-03)*.
- **Hierarchy before size.** Show importance with placement, spacing, weight, alignment and colour before raising the size. Money stays the strongest numeric hierarchy on cashier surfaces.

### Hierarchy
The frontmatter roles map onto the shipped size scale. RT-241 shipped them as `--type-*` alias tokens on `.v5-frame` (`src/renderer/v5/foundation/foundation.css`), with no value changes. Use the role token, not a raw literal. UX-03 names a target role vocabulary; the shipped aliases map onto it as follows, and renaming waits for a later slice:

| Shipped alias | UX-03 role |
|---|---|
| `--type-amount-hero` | `money-hero` |
| `--type-amount-total` | `money-total` |
| `--type-screen-title` | `screen-title` |
| `--type-section` | `section-title` |
| `--type-control-lg` | `control` |
| `--type-body` (and body strong) | `body`, `body-strong` |
| `--type-money-row` | `numeric-row` |
| `--type-meta` | `meta` |
| `--type-kbd` | `kbd` |
| *(none; IDs use the mono stack directly)* | `machine` |

UX-03's `display` role is for rare expressive Admin use and has no POS equivalent.

- **Amount hero** (700, 44px, 1.1, tabular lining; UI sans): the Checkout amount due and the completion amount. 36px at 1024.
- **Amount total** (700, 30px, 1.1, tabular lining; UI sans): the Sale grand total and ledger totals. 24px at 1024 compact.
- **Screen title** (700, 20px, 1.3): one per screen, in the titlebar.
- **Section** (700, 16px, 1.4): panel headings.
- **Control large** (700, 16px, 1.3): the primary commit button and tender tile labels.
- **Body / body strong** (400 / 600, 14px, 1.6): default cashier text; product names and button text are strong.
- **Money row** (600, 14px, 1.4, tabular lining; UI sans): line prices and ledger rows.
- **Meta** (400–600, 12px, 1.5): hints, secondary names, timestamps.
- **Kbd** (600, 11px, mono): keyboard-hint chips only — the one place below 12px is allowed.

### Numerals, money and time (UX-12)
Approved policy (OD-3, fixed by UX-12): **Western digits everywhere** in system-generated output — money, quantities, counts, times, dates, barcodes, SKUs, sale and receipt numbers, terminal ids — through the pinned `ar-EG-u-nu-latn` locale, never the device's default numbering. Inputs accept Arabic-Indic and Persian digits and normalise them to ASCII before validation (UX-08). Authored catalogue and business names keep their own digits and script.

- **Money.** One formatting policy: `1,250.00 EGP` — thousands grouping, exactly two decimals, the canonical `EGP` identifier after the figure, the whole run LTR-isolated, minus as U+2212 at the inline start of the isolated run. Formatting never changes arithmetic, which stays integer minor units.
- **Time.** Operational surfaces use readable Arabic dates with Western digits and a 24-hour clock, for example «7 أكتوبر 2026، 13:42», in the Store's time zone. Audit and support evidence uses an exact timestamp with an explicit zone or UTC. Relative time («منذ 3 دقائق») may orient on freshness surfaces, but the absolute time stays available wherever freshness affects a decision.
- **Counts and plurals.** Dense metadata uses noun-first counters such as «الأصناف: 11 · الوحدات: 23». Prose uses full Arabic plural messages (zero, one, two, few, many, other), never `{n} + " أصناف"`, and inserts values into complete sentences rather than fragments.

Shipped today: the renderer's UX-12 formatter `src/renderer/ui/format/human-format.ts` prints grouped `1,250.00 EGP`, Western digits and a 24-hour clock, but in the terminal's time zone (the Store time zone waits on RT-279). `shared/money` `format()` still prints ungrouped money, and receipts are rendered by main outside the renderer formatter. Surfaces that do not yet use the formatter migrate in their own slices. The OD-3 check against real Egyptian pharmacy receipts stays open for printed receipts (Q-4).

### Named Rules
**The Twelve-Pixel Rule.** Nothing a cashier must read is below 12px; 11px exists only for keyboard-hint chips.

**The Arabic Leading Rule.** Arabic body text keeps line-height ≥ 1.5 — ascenders, descenders and dots clip at 1.25. Long product names wrap to two lines in the cart, then ellipsis, with the full name in the row's accessible name.

**The Plain Emphasis Rule.** No italics and no all-caps; weight carries emphasis. All-caps Latin codes hurt scanning of `O/0` and `I/1`.

**The One-Locale Rule (UX-12).** One locale at a time: no control or heading repeats itself in Arabic plus parenthesised English. English stays only where source data, a standard abbreviation or a machine identifier needs it (EGP, SKU, ERPNext, exact IDs). The approved two-locale target (Arabic default, a separate English locale) is planning only ([22](design/vnext/22-rt311-locale-architecture.md)).

## Iconography

Icons reinforce; text decides (UX-03). Domain, destructive, financial and recovery actions always show their text; an icon is a supporting cue, never the only meaning, and technical concepts (ERP posting, held sales, returns, shift operations) are never icon-only puzzles.

- **Shipped, registry (IC-1 / RT-692):** `src/renderer/icons/` holds the semantic registry (`registry.ts`), the `Icon` component and vendored **Fluent System Icons** Regular path data (`fluent-paths.ts`, MIT notice alongside). It renders by meaning, owns RTL mirroring per name, and adds **no npm dependency** (D-263-2 vendored path data, D-263-3 no package). Do not add `@fluentui/*` packages.
- **Shipped, consumers (IC-2 / RT-695, #760):** every POS consumer names icons through the registry. `V5Icon` is deleted; the brand cross is the `PharmacyCross` brand component. A test forbids raw `<svg>` in `src/renderer` outside `icons/` and the brand components.
- **Target *(UX-03, RT-263)*:** every consumer names icons through the registry, so product code never names a vendor glyph or a `V5Icon` shape. Met for POS by IC-2 ([25](design/vnext/25-rt263-icon-registry-fluent-poc.md) §8). Decisions D-263-1…9 were selected by the coordinator under the owner's standing delegation; the owner approved the visual fit on 2026-10-20.
- **One icon grammar:** never mix Fluent, Lucide, Phosphor and bespoke glyphs in ordinary product UI. A custom glyph needs a proven gap: a frequent concept whose library metaphor fails even with its label (the cash drawer is a candidate, not a requirement).
- **Regular by default:** regular forms for wayfinding and actions; a filled form only for a persistent selected state when it helps recognition. Selection does not stack every signal (filled icon, strong teal, heavy fill, Signal Line and bold text) without need.
- **Colour:** icons inherit `currentColor`; interaction and status tokens decide their colour. No category palettes and no decorative coloured icon tiles unless the surface is a real launcher.
- **RTL follows meaning:** mirror directional concepts (back, forward, undo); never mirror physical objects (scanner, printer, card, store, trash) or search, print, lock, clock and check.

## Layout

**RTL composition.** `<html lang="ar" dir="rtl">` is set once at the root; components never re-declare RTL and only declare `dir="ltr"` on isolated Latin runs. Reading order is importance order: the inline start (right) holds *where you are and what you are adding*; the inline end (left) holds *money and the commit action*. Only CSS logical properties are used; a physical `left/right` needs a code comment explaining why. Money, quantities, barcodes, SKUs, sale and receipt numbers, terminal ids, times, card references and Latin product names are LTR-isolated (`unicode-bidi: isolate` or `<bdi>`) — isolate the number, never the whole Arabic sentence. Keypads stay LTR (1-2-3 on the top row). Icons mirror by meaning, through the semantic registry in [`src/renderer/icons/`](../src/renderer/icons/registry.ts), which owns each name's mirror rule; the rules are in [Iconography](#iconography) and [`25`](design/vnext/25-rt263-icon-registry-fluent-poc.md).

**Spacing.** A 4px base scale (4 to 96). Two density profiles, switchable only between transactions, never mid-sale: **compact** (8px gutter and gap, 52px cart rows, 12px panel padding, 44px titlebar) and **comfortable** (12px gutter and gap, 60px rows, 16px padding, 48px titlebar). The profile follows the width of the `v5-screen` workspace container, not the viewport width. Shipped code switches to compact at a container width of 1120px or less (`live-sale.css`). With Direction B's slim nav, that means compact in a 1024 window and comfortable in a 1280 window. It also switches to compact on a viewport under 768px high (RT-312 D12, RT-407): `frame.css` marks the container and the compact queries read the mark with `style()`, so the container stays inline-size only. Density never changes target sizes, money type, the visibility of the total and next action, or shortcut meanings. UX-04 names three context-driven density modes (Comfortable, Operational, Compact), not a user preference; how the two shipped profiles map onto them is open (Q-1).

**Frame — Direction B (OD-7).** The workspace is a size container and screens adapt with container queries, not viewport media queries. Navigation sits on the inline end (left), after the screen.

| Aspect | 1280×800 (comfortable) | 1024×768 (compact) |
|---|---|---|
| Nav, every screen (owner decision 2026-10-21; RT-242 kept the labelled panel off-sale) | slim rail, icon + short label, ≈76px | slim rail, ≈76px |
| Sale | command bar (scan target, search, suspended-sales entry *(VN-S11)*) above a full-width cart; money column ≈320px on the inline end: total at the top, «الدفع», suspend *(VN-S11)* and cancel at the bottom | same, money column ≈280px; at least 6 cart rows visible |
| Search results | drop down over the cart, 3–5 results, close on Esc or selection | same |
| Checkout | order summary ≈280px · tender panel fluid · payment ledger ≈320px (amount due and commit pinned) | tender panel fluid · payment ledger ≈296px; summary collapses to a one-line strip with «عرض الأصناف» |
| Below 1024 | `ScreenTooSmall`, Arabic copy *(VN-S2; today English)* | — |

The money column keeps the same place through the whole journey: the Sale total becomes the Checkout amount due and «الدفع» becomes «تأكيد الدفع». Column widths are reference-kit values (`design/vnext/references/`), confirmed in the real app by *(VN-S12)* (Sale layout and slim nav) and *(VN-S4)* (Checkout content); today's shipped Sale is still the Direction A V5 layout.

**The Never-Scrolled-Away Rule.** At neither width may the total, the amount due, the safe back/cancel, suspend (when applicable) or the primary action be scrolled out of view. In the 600–767px compact-height band, a Sale or Checkout state that cannot keep them in view (stacked banners with actions) is covered by the in-surface fit notice M-F3 rather than shown clipped (RT-312 D2, RT-412); the screen stays mounted and inert under it, and the banners stay usable.

**Spatial rules (UX-04).**
- **Pressure priority:** when space is short, keep critical truth, then the primary action, then current context. Remove decoration first, then whitespace, then optional context, then low-priority metadata. Reflow secondary surfaces before shrinking money, safety or workflow text.
- **One primary scroll owner:** the cart or data body scrolls; money, the commit, the command bar with its scan state, and critical truth never scroll away. No nested incidental scroll chains; an overlay such as a drawer may own its own scroll.
- **Attention budget:** concurrent banners and notices share a bounded vertical region; lower-priority states are consolidated instead of pushing the work surface down.
- **Expand comfort, not structure:** a larger window adds breathing room and optional context but never moves the workflow anchors. Dense inside, breathing between regions.
- **Surfaces:** a work surface (the cart) is flat; a section is a heading plus spacing, not a box; a panel is a task region where tone or a divider may be enough; a card is only for a genuine independent, selectable or actionable object; drawers and dialogs are the only elevated surfaces.

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

Gently rounded, consistent by role. **Shipped:** controls (buttons, fields, tiles, nav entries) 10px; panels 14px; overlays 16px; chips, badges and keyboard hints a full pill. The 2px, 4px and 8px radii exist in the token scale but are not used for controls (the V5 sign-out button at 4px is the known outlier). Panels never contain panels.

**Target *(UX-04)*, a staged migration:** controls **8px**, genuine contained objects **12px**, independent overlays **16px**. The shipped tokens (`--radius-control` 10px, `--radius-card` 14px, `--radius-pane` 16px) do not change until a bounded slice migrates them, with captures at 1024 and 1280 in light and forced colours. That slice also moves the comparison baseline for the G-1, G-2, G-3 and G-6 references, which draw the shipped radii. The UX-04 shape rules apply to new work now:
- **Round the object, not the page:** large structural and data surfaces (the cart work surface, tables) are not rounded to look modern.
- **Shape follows attachment:** an attached drawer or panel rounds only its free corners.
- **Pills are semantic:** a full pill is for a status, a compact count or tag, or a control whose meaning needs it (the keyboard hint). Ordinary buttons are never pills.

## Components

One vocabulary, one implementation each, under `src/renderer/v5/**` (the clean-room wall stays). The full state matrix is [`06-component-state-inventory.md`](design/vnext/06-component-state-inventory.md). The legacy 007 `ui/primitives/*`, `.btn`, `.v4-*`, the v3.5 tender classes and the four hand-rolled dialog mechanisms are retired vocabularies, kept alive only until their screens migrate.

### Buttons
One shared system, `.v5-btn` (`src/renderer/v5/foundation/buttons.css`, loaded once from `main.tsx`). Every V5 button, the Checkout commits and the dialog buttons carry it; a surface keeps its own class only for placement. *Shipped on `feat/pos-button-system-transitions` (no Jira id yet).* The variants set role colours through `--btn-*`, so a state never repeats a colour per variant.

- **Shape:** control radius (10px; UX-04 migrates it in its own slice); sizes medium 44px and large 56px.
- **Secondary (`.v5-btn`):** white surface, Control Edge boundary, ink text. The default, and what a bordered cancel, back or close stays.
- **Primary (`--primary`):** Tower Teal fill, white text. **Commit (`--commit`, with `--primary`):** the one next action, large and full panel width (Checkout CTA, confirm payment, the Sale «الدفع» handoff, new sale).
- **Quiet (`--quiet`):** borderless, muted ink. Only for a cancel, back or close that is borderless today.
- **Danger-quiet / danger:** danger-quiet (red ink and edge) *starts* a destructive flow (cancel sale, void, cancel payment, force-close a stuck shift); danger (red fill) *executes* it inside its confirm dialog or step.
- **Hover:** neutral or one step deeper, over the Signal role. **Press:** one step deeper and a 1px drop, over the Contact role (80ms); none under reduced motion.
- **Focus:** `outline: 2px solid` the focus ring (teal) with a 2px offset on every focusable element, never only a box-shadow, which disappears in contrast themes.
- **Unavailable (`:disabled` and `aria-disabled`):** recessed, not faded. A sunken fill, a Control Edge hairline and muted ink; no opacity. **Unavailable commit:** the same, with a 2px dashed edge, so it never looks payable. The reason sits in the same region.
- **Disabled-by-policy:** visibly present, sunken, with a reason line (the RT-103 internal-voucher tender tile is the reference case).
- **Busy:** `aria-busy="true"` shows the progress cursor.
- **Keypad keys and tender tiles** stay their own components and share the same press and the teal focus ring.
- **Forced colours:** every button keeps a 1px `ButtonText` edge; a filled primary or danger keeps a 3px one; unavailable reads `GrayText`, and an unavailable commit stays dashed.
- **Density:** the commit is 56px compact and 60px comfortable; tender tiles are 72px and 84px, following the `v5-screen` container (see Layout). The density rules sit on the Checkout ledger slot and the Sale money column, not in the button system.

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
`OrderSummary` (frozen), `TenderPicker` (tiles, including disabled-by-policy), `CashEntry` with `QuickAmounts`, `CardTerminalEntry`, `PaymentLedger` (amount due pinned at hero size), `PaymentOutcome` and `RecoveryPanel` for UNKNOWN, cancelling and reversal states. Selected tender tile: Teal Wash fill, Tower Teal ink and boundary. Money values are never animated (UX-06); `MoneyRoll` was removed by RT-243 F1 (#583) and must not return.

### Navigation
- **Slim rail** (≈76px, icon + short 12px label) on every screen, so the nav never changes shape between screens (owner decision 2026-10-21; RT-242 had a labelled 208 / 140px panel off-sale, its CSS remains as the unscoped base under `data-nav='slim'`).
- **Default:** muted ink on canvas, control radius, 44px entries.
- **Active:** Teal Wash fill, Tower Teal ink, a 2px inline-start bar and `aria-current="page"`.
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

Copy states what is true, what is safe, and what to do — in that order, in Arabic, never blaming the cashier and never "Error 500". Offline selling is a warning banner while the sale continues; a sync backlog needing attention is a danger banner that tells the cashier the sale is safe locally. The completion panel never says «تم الترحيل» — posting status lives only in the sync indicator. Verbs never claim more than the evidence (UX-12): «أُرسل الإيصال للطابعة» only when this sale's print submission is proven, «طُبع الإيصال» only for a proven print; otherwise the line is omitted or states the failure. Success copy names what succeeded («تم حفظ البيع», «تم تسجيل الدفع»), never a blanket «تمت العملية بنجاح». «حاول مرة أخرى» appears only where retrying can help; an expired sign-in says so and offers re-sign-in. Today the connection state is hard-coded online and the sync status is unmounted; the treatment above must be driven by a real signal *(VN-S6)*, never faked.

### Dialogs and manager approval
One `Dialog` mechanism: `role="dialog"`, `aria-modal`, focus on the first *safe* control (never the destructive or commit button), Esc cancels, focus returns to the invoker, scanner suspended while open. Dialogs are a last resort — note, destructive confirmation, manager approval, resume conflict, lock. (The confirm-add dialog is current-state only: owner decision D-C1, 2026-10-07, replaces it with direct add plus undo, `design/vnext/15-vnext-freeze-package.md` §3.) The **manager approval sheet** states exactly what is approved (action, amount, sale reference, cart version), requires a reason, authenticates the manager inside the sheet without replacing the cashier's session, and returns to the exact prior state on approved, denied or cancelled. Approval is bound to the cart version.

### Motion
Motion explains a change; it never owns the meaning (UX-06). POS is predominantly in the **Functional** tier, with a little **Responsive** acknowledgement; the **Expressive** tier is not used near financial, critical or recovery states. Three roles, from the shipped motion tokens (RT-241 aliases on `.v5-frame`):

| UX-06 role | Duration | Alias | Used for |
|---|---|---|---|
| Contact | 80ms | `--motion-press` | press response on a control |
| Signal | 150ms | `--motion-flash`, `--motion-notice-in` | scan-row flash, a local notice or state acknowledgement |
| Continuity | 220ms | `--motion-dialog-in` | dialogs, drawers, attached overlays |

All three use `ease-out` `cubic-bezier(0.2, 0.7, 0.25, 1)`. New state transitions use only these roles: no ad-hoc durations, and the shipped `--duration-4` (320ms) is not a motion role. The roles time state changes, not continuous activity loops: a genuine-activity spinner keeps the shipped `800ms linear infinite` rotation (`v5/foundation/messages.css`, `route-states.css`). UX-06 names no spinner token; one may be added by a later motion slice, which must not speed the loop up to a transition role. No springs, overshoot, bounce, shake or parallax.

- **Settle-ins:** one 150ms Signal settle (`v5-settle`, a 4px drop and a fade) on the foundation Notice, Banner and Toast, the inline scan notice, the Checkout tender entry panel, and the completion outcome line (its glyph and sentence only, never the amounts or the panel). Danger-toned messages, every recovery surface and an UNKNOWN payment stay static, and dialogs keep the 220ms entry with no exit. Each has a `prefers-reduced-motion: reduce` path of `animation: none`. *Shipped on `feat/pos-button-system-transitions` (no Jira id yet).*
- **Truth doesn't perform:** money, totals, tax, refunds and stock never roll, count up or morph through intermediate values; the correct value appears at once. `MoneyRoll` was removed by RT-243 F1 (#583).
- **Success settles, risk suppresses expression:** a proven result gets a restrained acknowledgement, never celebration. Payment UNKNOWN and other critical uncertainty are near-static.
- **Live does not mean animated:** connected, scanner-ready and healthy states are static. Spinners and progress move only during genuine processing, syncing or loading, stop when it stops, and stay on the control or surface that owns the action. No ambient pulsing, breathing buttons or moving gradients.
- **Motion is logical:** directional movement uses logical inline / block direction, so RTL is correct; whole-workspace route changes are not animated.
- **Reduced motion:** under `prefers-reduced-motion: reduce` every role is zero (`foundation.css`) and the state change stays visible by colour, text, border, icon and layout. Focus visibility never depends on motion. Per-surface invariance is verified by RT-260.

## Do's and Don'ts

### Do:
- **Do** keep the total (Sale) and amount due (Checkout) as the largest numerals, with tabular lining figures in the UI sans, visible without scrolling at 1024×768 and 1280×800.
- **Do** use exactly one filled-teal primary per region and reserve the large commit (56px, full width) for the one next action.
- **Do** isolate every money value, quantity and code as an LTR run with Western digits and tabular figures, and format human money through the UX-12 formatter (`1,250.00 EGP`).
- **Do** keep the money column in the same place from Sale through Checkout to completion (Direction B).
- **Do** give every state text and/or an icon in addition to colour, and verify it under forced colours.
- **Do** draw control boundaries with Control Edge (`border-strong`) and keep the hairline (`border`) for decorative dividers.
- **Do** show the scan owner, and suspend scanning visibly while a dialog is open.
- **Do** use info (Pending Blue) for recorded-but-unproven states and success only for proven facts.
- **Do** tag anything not yet shipped with its VN slice or Constitution module, and stop and raise it if a visual choice would change RT-24 behaviour.
- **Do** check the UX/UI Constitution first when this file and a Constitution module seem to disagree; the Constitution wins (see Authority).

### Don't:
- **Don't** use the superseded v3.5 system — navy `#1f4e7a`, Inter, dark default, the One-Accent Rule, the dark command rail — for new work.
- **Don't** offer the dark theme or a theme toggle on cashier surfaces in the pilot.
- **Don't** show success colour, a check icon or a success word before the underlying fact is persisted.
- **Don't** call an UNKNOWN payment a decline, or a local sale "posted".
- **Don't** auto-dismiss operational state (offline, sync attention, printer, drawer, shift closed) — those are persistent banners.
- **Don't** animate money values (no rolling or count-up), time a state transition outside the 80 / 150 / 220ms roles, or use bounce, elastic, ambient or decorative motion.
- **Don't** bind financial confirmation to bare Enter, or show a keyboard hint for a key that is not bound.
- **Don't** use shadows below the overlay level, nest panels, or put status colours on decoration.
- **Don't** add a secondary brand accent, a gradient on an operational surface, or a theme toggle (UX-02).
- **Don't** use monospace for ordinary UI text, mix icon families, or ship an icon-only control for a financial, destructive, recovery or technical action (UX-03).
- **Don't** change a shipped radius, neutral value, money typeface or font outside the bounded slice that owns that migration.
- **Don't** mix numeral systems on one screen, or write bilingual headings such as «طريقة الدفع (Payment method)».
- **Don't** use the RT-27 Tower Blue palette or the 022 handoff's Saudi/ZATCA/15% VAT/mada content; they are references, not authority, for this Egyptian product.
