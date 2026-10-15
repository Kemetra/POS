# Feature Specification: POS UI Shell

**Feature ID:** 003-pos-ui-shell
**Status:** Draft (clarified · payment-tender reservation amended 2026-05-04)
**Created:** 2026-05-04
**Last Updated:** 2026-05-04 (clarifications applied — see Clarifications; payment-tender visual reservation added — see "Payment / tender visual reservation")
**Owner:** POS-Pulse desktop team

---

## Overview

After a Windows POS terminal completes the one-time pairing ceremony (delivered by `002-terminal-pairing`), the application currently has no visible product surface beyond pairing screens. This feature defines the **post-pairing application shell**: the persistent layout, navigation, status indicators, and placeholder regions that every subsequent feature (cashier login, sales, cart, receipts, inventory, settings) will plug into. It also establishes the shared **design tokens** and **shared UI component inventory** that bind those features together visually. This is a UI-only feature — no business logic, no backend calls, no IPC, no persistence beyond what already exists. Its purpose is to give the team a stable visual chassis and a Figma-aligned design language to iterate on before any cashier-facing logic is written.

## Clarifications

The three open clarifications previously parked under "Open Questions" are resolved as follows. Resolved
items are now load-bearing requirements (see updated FRs / NFRs / SCs).

### 2026-05-04 — Density default

**Decision:** **Comfortable / touch-friendly density is the default and only density delivered in
this feature.**

- The shell ships with a single density value: **comfortable**, optimised for cashier readability and
  speed on a touchscreen monitor, not for maximum row count on an admin dashboard.
- The minimum primary touch target is **44 × 44 CSS px** (already pinned by NFR-5).
- A **`compact`** density token MAY be reserved as a future option in the design-token table, but **no
  density toggle, no settings UI, no runtime switching, and no compact layouts** are implemented in
  this feature.
- Affects: **FR-17** (density token set narrowed), **FR-20** (no runtime density switching), **NFR-5**
  (touch-target minimum is the floor), and **acceptance scenario 11** (density toggle removed).

### 2026-05-04 — Navigation-rail collapse behaviour

**Decision:** **Responsive rail with two actively-designed layouts and one "not a target" fallback.**

| Effective viewport width | Rail behaviour | In scope? |
|:--|:--|:--|
| **≥ 1280 px** | Expanded rail: icons **and** labels visible. | Yes — primary cashier layout. |
| **1024 – 1279 px** | Compact icon-only rail; labels exposed via accessible name + tooltip. | Yes — secondary supported layout. |
| **< 1024 px** | Not a target production viewport for MVP. The shell MAY render a friendly "screen too small" / minimum-width message. **No mobile hamburger drawer is implemented.** | No. |

- No mobile-first navigation, no slide-out drawer, no bottom-tab bar are implemented or designed in
  this feature.
- Affects: **FR-2 / FR-3** (rail visual treatment now responsive), **NFR-3** (viewport matrix
  amended to mention the icon-only band 1024–1279 px), and the Figma handoff (FR-24): exactly two
  rail layouts + one fallback message must be designed.

### 2026-05-04 — Reserved "syncing" connection state

**Decision:** **A fourth `syncing` state is reserved in the shell status system as a *visual-only*
placeholder. No real synchronization logic is implemented.**

The connection-status indicator (FR-7) and the global status-banner system (FR-16) are now defined
with **four** visual states: `online`, `degraded`, `offline`, `syncing`. The `syncing` state:

- MAY appear in design tokens, component states, story / dev toggles, and Figma mocks.
- MUST NOT have any real offline-sync queue behind it.
- MUST NOT trigger backend calls.
- MUST NOT touch any persistence layer (`better-sqlite3`, `SecretStore`, file system).
- MUST NOT introduce any new IPC channel.
- MUST NOT change the preload bridge surface.
- MUST NOT contain any actual network synchronization logic.
- Exists only so that future offline-sync work has a defined visual placeholder it can adopt without
  reshaping the indicator or the status banner.

Affects: **FR-7** (third → fourth visual state), **FR-16** (global status state list amended),
**FR-24** (handoff package must include all four states), and the Out-of-Scope list (real sync logic
remains explicitly out of scope).

## Payment / tender visual reservation

The Receipt / Checkout placeholder (FR-12) carries the **largest amount of future visual capacity**
of any pane in this shell, because the future feature **005-checkout-payments** will introduce six
tender kinds, five amount fields, and a printed receipt payment-breakdown surface. To keep that
future work additive (no shell reshape, no token churn, no rail-or-region changes), this feature
**visually reserves** named slot regions for it now.

**This is a layout-capacity decision, not a behaviour decision.** Every item below is a
*labelled rectangle* in the placeholder pane and the reviewed Figma file — no values, no parsers,
no money types, no validation, no IPC, no fetches.

### Reserved tender kinds (layout slots only)

The receipt placeholder reserves a vertically-stacked **tender-row list** with one slot per
kind. Each slot renders a "Reserved for 005-checkout-payments" placeholder body — no input
controls, no amounts, no glyphs that imply functionality.

| Tender kind | Slot id | Notes (visual only) |
|:--|:--|:--|
| Cash | `tender.cash` | Reserved for cash payment row. |
| Card | `tender.card` | Reserved for card payment row. **No card-terminal integration.** |
| Bank transfer | `tender.bank-transfer` | Reserved for bank-transfer row. **No bank API integration.** |
| Gift voucher | `tender.voucher` | Reserved for voucher redemption row. **No voucher validation.** |
| Insurance-covered sale | `tender.insurance` | Reserved for insurance-covered portion row. **No insurance validation.** |
| Split / mixed tender | `tender.split` | Reserved for split-tender container row (groups 2+ tenders for one sale). |

### Reserved amount fields (layout slots only)

A separate **totals strip slot** sits below the tender-row list. It reserves five rectangles, in
this fixed display order, each rendering a "Reserved for 005-checkout-payments" placeholder
label:

1. **Amount due** — slot id `totals.amount-due`.
2. **Amount paid** — slot id `totals.amount-paid`.
3. **Remaining balance** — slot id `totals.remaining`.
4. **Change due** — slot id `totals.change-due`.
5. **Receipt payment-breakdown row** — slot id `receipt.breakdown` (separate row in the totals
   strip, reserved for the printed receipt's tender summary; this is a *visual* placeholder for
   the future printed-receipt surface, **not** a printing or render hook).

### Hard exclusions for the reservation

The reservation is **purely visual capacity**. In this feature it MUST NOT:

- implement payment logic of any kind (no totals math, no change calculation, no balance
  arithmetic);
- introduce or call any payment API, payment provider, payment gateway, or payment SDK;
- introduce or call any card-terminal integration, including device discovery, pairing, or
  message exchange with EMV / contactless / chip-and-PIN hardware;
- introduce or call any insurance validation (eligibility check, claim submission, prior-auth);
- introduce or call any voucher / gift-card validation (balance lookup, redemption, lock,
  refund);
- introduce or call any printing logic (no print queue, no driver communication, no receipt
  rendering pipeline);
- introduce or persist any sales / cart / line-item / order business logic;
- add a `Money` type, a currency formatter, an exchange-rate hook, or any value-bearing prop on
  the slot components — all values are deferred to 005;
- introduce a new IPC channel, a new preload-bridge surface, or a new SecretStore key;
- emit any new log line, Sentry breadcrumb, or telemetry tag tied to a tender or amount.

### Why reserve now instead of later

If the tender list and totals strip are not reserved at the shell level, 005 will arrive and
discover that the receipt pane is too tight to host six tender rows + a five-field totals strip
without rearranging the AppShell's column proportions, the rail's expanded width, or the per-pane
maximum content width. Reserving the rectangles now means 005 fills them in without touching the
shell.

This mirrors the same logic as Clarifications §3 (the reserved `syncing` connection state):
*name the slot, forbid the logic*.

### Affected requirements and downstream artifacts

The reservation amends:

- **FR-12** — receipt placeholder now lists the three reserved slot regions (tender-row list,
  totals strip, receipt-breakdown).
- **FR-24** — Figma handoff must include the reserved slots (eleven labelled rectangles total:
  six tender rows + five totals fields).
- **Out of Scope** — three new lines pin the negation: no payment logic, no card-terminal
  integration, no insurance / voucher validation, no receipts printing.
- **Dependencies** — adds a forward dependency on **005-checkout-payments** (which does not yet
  exist as a spec); see "Future feature — 005-checkout-payments" below.

## Future feature — 005-checkout-payments (deferred)

A future feature, **005-checkout-payments**, will own all payment / tender logic, including:

- the typed `Money` value (integer minor units per Constitution Principle II) and currency
  contract;
- the six tender kinds' real components, validation, and persistence;
- amount-due / amount-paid / remaining-balance / change-due math;
- card-terminal integration (per the constitution's MVP hardware matrix);
- insurance eligibility / claim flow;
- voucher / gift-card redemption flow;
- printed receipt's payment-breakdown surface (paired with the future receipts-printing
  feature).

005-checkout-payments is **not specified** in this round. When it is specified, it will:

1. consume the eleven slot ids declared above (`tender.{cash|card|bank-transfer|voucher|insurance|split}`,
   `totals.{amount-due|amount-paid|remaining|change-due}`, `receipt.breakdown`) without renaming
   them;
2. inherit the shell's design tokens, shared component inventory, comfortable density, four
   connection-state visuals, and accessibility floor unchanged;
3. respect Constitution Principle II (integer minor units only — no floats for money);
4. respect Constitution Principle VIII (terminal identity ≠ user identity — payment is performed
   by the terminal, audited by the operator session that a separate future feature delivers).

Until 005-checkout-payments lands, the receipt placeholder renders only the labelled "Reserved
for 005-checkout-payments" rectangles described above.

## User Scenarios & Testing

### Primary User Story

A cashier turns on a paired POS-Pulse terminal at the start of a shift. The application opens past the pairing screen (because the terminal is already paired) and lands in the POS shell. The cashier sees a clean desktop layout sized for a typical 14"–22" cashier monitor: a top bar with the tenant name, branch name, terminal label, and a clear connection-status indicator; a side rail with navigation entries for Dashboard, Sales, Cart, Receipts/Checkout, Inventory, and Settings/Help; and a main content area that currently shows a Dashboard placeholder. An operator placeholder area on the top bar shows "No operator signed in" — login itself is not part of this feature. The cashier can move through the navigation entries with mouse, touch, or keyboard, see clearly distinguished loading / empty / error / offline states for each placeholder screen, and confirm that the visual language (colors, spacing, typography, density, focus rings) is consistent across every region. Nothing the cashier clicks performs business logic — every action either navigates between placeholder routes or reveals a visibly-marked placeholder.

### Acceptance Scenarios

Each scenario uses Given / When / Then phrasing. Each MUST be testable without naming an implementation.

1. **Shell appears after pairing**
   - **Given** the terminal is already paired and the application starts
   - **When** post-pairing initialization completes
   - **Then** the user is presented with the POS shell — top bar, navigation rail, and a default Dashboard placeholder pane — and not the pairing screen.

2. **Top-bar identity strip is visible and accurate**
   - **Given** the shell is visible
   - **When** the user looks at the top bar
   - **Then** the tenant name, branch name, terminal label, and a connection-status indicator are all visible at a glance; the operator slot displays a clearly labelled "no operator" placeholder.

3. **Navigation between placeholder areas**
   - **Given** the shell is visible with the Dashboard placeholder shown
   - **When** the user activates each navigation entry (Dashboard, Sales, Cart, Receipts/Checkout, Inventory, Settings/Help) via mouse, touch, or keyboard
   - **Then** the main content region swaps to the corresponding placeholder, the active navigation entry is visually marked, and no business action is performed.

4. **Loading state is recognisable**
   - **Given** any placeholder pane is configured to render in its loading state (driven by a story / dev toggle, not real data)
   - **When** the loading state is rendered
   - **Then** the user sees a non-flashing, non-jumpy loading indicator that matches the design tokens and that announces itself to assistive tech.

5. **Empty state is recognisable**
   - **Given** a placeholder pane is rendered in its empty state
   - **When** the user views the pane
   - **Then** the user sees a friendly, non-alarming empty illustration / message and at most one suggested next action (which itself is a no-op placeholder in this feature).

6. **Error state is recognisable and recoverable**
   - **Given** a placeholder pane is rendered in its error state
   - **When** the user views the pane
   - **Then** the user sees a clear error message, a non-technical description, and a visibly-labelled "retry" or "go back" affordance (which is a no-op placeholder in this feature).

7. **Connection-state visuals (online / degraded / offline / syncing)**
   - **Given** the shell is visible and the application is cycled through each of its four connection-state values via a dev / story toggle (`online`, `degraded`, `offline`, `syncing`)
   - **When** each state is selected
   - **Then** the top-bar connection indicator changes colour and label distinctly per state, a non-`online` state surfaces an unobtrusive status banner explaining the mode, no destructive action is offered, and the `syncing` state performs no real sync work (no backend call, no persistence write, no IPC).

8. **Keyboard-first navigation works**
   - **Given** the shell is visible and the user has not touched the mouse
   - **When** the user presses Tab / Shift-Tab / Enter / arrow keys
   - **Then** focus moves through every interactive element in a predictable order, the focus ring is always visible, and every navigation entry is reachable without the mouse.

9. **Touch input works on a touchscreen monitor**
   - **Given** the shell is visible on a touchscreen cashier monitor
   - **When** the user taps any navigation entry, button, or status indicator
   - **Then** the tap target meets the minimum touch-target size and the same outcome occurs as for a mouse click.

10. **Shared component visuals are consistent**
    - **Given** any two placeholder panes are rendered side by side
    - **When** the user compares buttons, inputs, cards, tables, badges, dialogs, toasts, and status banners
    - **Then** the components use the same colour, spacing, typography, radius, and density tokens, and no two regions visually disagree.

11. **Responsive rail layout (≥ 1280 px vs 1024–1279 px vs < 1024 px)**
    - **Given** the shell is visible
    - **When** the effective viewport width is set to **≥ 1280 px**, then to a value in the **1024–1279 px** band, then to a value **< 1024 px** (via a dev / story control or window resize)
    - **Then** at ≥ 1280 px the rail shows icons **and** labels; at 1024–1279 px the rail shows icons only with each entry retaining an accessible name and tooltip; below 1024 px the shell renders a friendly "screen too small" message rather than a broken layout, and **no** mobile hamburger drawer is rendered at any width.

12. **Receipt placeholder reserves payment-tender visual capacity**
    - **Given** the shell is visible and the user navigates to the Receipt / Checkout placeholder
    - **When** the placeholder renders in its `default` state
    - **Then** the page shows three labelled visual regions — a **tender-row list slot** with one
      reserved row per tender kind (cash, card, bank transfer, gift voucher, insurance-covered
      sale, split / mixed), a **totals strip slot** with five reserved rows in fixed order
      (amount due, amount paid, remaining balance, change due, receipt payment-breakdown), and
      each rendered slot displays a clearly-labelled "Reserved for 005-checkout-payments"
      placeholder; **no** payment values, formatters, inputs, or interactive controls are
      present, and **no** fetch / IPC / persistence call is made when the pane mounts or when
      any reserved slot is hovered, focused, or activated.

### Edge Cases

- **Unpaired terminal launches the shell.** Should not happen — `002-terminal-pairing` gates the shell — but if the bridge reports the terminal as unpaired, the shell MUST NOT render any post-pairing region; it MUST defer to the pairing screen.
- **Tenant / branch / terminal label is missing.** The top-bar identity strip MUST render a clearly-labelled placeholder ("Branch: —") rather than a blank space or a crash.
- **Operator placeholder is shown.** Until cashier login is delivered in a later feature, every operator-bound action MUST be visibly disabled with a tooltip or inline note ("Sign in to use this") — never a silent no-op.
- **Window resized below the minimum cashier-monitor target size.** The shell MUST remain usable across the two designed rail layouts (≥ 1280 px expanded, 1024–1279 px icon-only — see NFR-3 and FR-2). Below 1024 px effective width it MAY show a friendly "screen too small" message rather than a broken layout, and MUST NOT render a mobile hamburger drawer.
- **High-DPI / scaled Windows display.** At Windows display scaling 100 % / 125 % / 150 %, the shell MUST not clip text, navigation icons, or focus rings. *(150 % is qualified by constitution v1.7.0 § Hardware, Display row: not supported for the pilot, and otherwise only where the effective viewport is ≥ 1024 × 600; amended 2026-10-15, RT-312 D8/D15.)*
- **Slow / cancelled placeholder load.** If a placeholder's loading state never resolves (because there is no real fetch yet), it MUST NOT spin forever silently — a dev-only timeout / story control is acceptable.
- **Missing or partially-loaded design tokens.** If a token is undefined, the shell MUST fall back to a documented default (not an unstyled element) and emit a build-time warning, not a runtime crash.
- **Right-to-left / Arabic locale (future-aware).** The shell layout MUST not hard-code "left rail / right content"; layout direction MUST be driven by a logical-property approach so a future locale swap doesn't break it. (Localization itself is out of scope for this feature.)

## Requirements

### Functional Requirements

Each requirement is testable, unambiguous, and uses MUST/SHOULD/MAY.

#### Layout & navigation

- **FR-1.** The application MUST render a persistent **AppShell** layout for any route reached after successful terminal pairing. The shell MUST consist of: a top bar, a primary navigation rail (or sidebar), a main content region, and a status / banner region.
- **FR-2.** The shell MUST expose primary navigation entries for: **Dashboard**, **Sales**, **Cart**, **Receipts / Checkout**, **Inventory**, and **Settings / Help**. Each entry MUST be a placeholder route in this feature. The rail MUST be **responsive**: at effective viewport width **≥ 1280 px** the rail renders **icons + labels**; at **1024–1279 px** the rail renders **icons only** with labels exposed via accessible name and tooltip; **below 1024 px** is not a target production viewport and the shell MAY render a friendly "screen too small" message instead. No mobile hamburger drawer is implemented.
- **FR-3.** The active navigation entry MUST be visually distinguished (selected state) and MUST be programmatically identifiable to assistive technologies. In the icon-only rail (1024–1279 px) the active state MUST remain distinguishable without relying on label text.
- **FR-4.** The navigation rail MUST be reachable and operable by keyboard alone (Tab, arrow keys, Enter / Space).
- **FR-5.** The shell MUST NOT render unless the bridge confirms that the terminal is paired (the gate itself was implemented in `002-terminal-pairing`; this feature only consumes that gate).

#### Top bar / identity strip

- **FR-6.** The top bar MUST display the **tenant name**, **branch name**, and **terminal label** sourced from the existing paired-terminal state (no new IPC). Each MUST gracefully render a placeholder when the value is unavailable.
- **FR-7.** The top bar MUST display a **connection-status indicator** with **four** visual states: **online**, **degraded / slow**, **offline**, and **syncing** (reserved). State changes are driven, in this feature, by a developer / story toggle only — no real network probing, no real sync queue, no backend calls, no persistence, no IPC, and no preload-bridge changes are in scope. The `syncing` state exists purely as a visual placeholder for future offline-sync work.
- **FR-8.** The top bar MUST display an **operator placeholder area** showing a clearly labelled "no operator signed in" state and a visibly-disabled affordance for "sign in" (no-op in this feature).

#### Placeholder content regions

- **FR-9.** A **Dashboard placeholder** MUST be rendered as the default post-pairing landing pane.
- **FR-10.** A **Sales-screen layout placeholder** MUST be defined and reachable from the navigation rail.
- **FR-11.** A **Cart layout placeholder** MUST be defined and reachable from the navigation rail.
- **FR-12.** A **Receipt / checkout placeholder** MUST be defined and reachable from the navigation rail. The placeholder MUST visually reserve named slot regions for the future payment / tender surface owned by **005-checkout-payments** (see "Payment / tender visual reservation" below): a **tender-row list slot** (one row per tender kind: cash, card, bank transfer, gift voucher, insurance-covered sale, split / mixed tender), a **totals strip slot** (amount due, amount paid, remaining balance, change due), and a **receipt payment-breakdown slot**. Each slot is **layout-only** — no values, no formatters, no payment logic, no IPC, no API calls — and renders a clearly-labelled "Reserved for 005-checkout-payments" placeholder.
- **FR-13.** An **Inventory placeholder** MUST be reachable from the navigation rail. It MUST display a "navigation only" message — no inventory data, no inventory mutation.
- **FR-14.** A **Settings / Help placeholder** MUST be reachable from the navigation rail.

#### State variants (each placeholder pane)

- **FR-15.** Every placeholder pane MUST define a **loading state**, an **empty state**, and an **error state** as distinct visual variants. Variants MAY be selected by a dev / story toggle.
- **FR-16.** The shell MUST define a global **connection / network visual state** with the same four values as FR-7 (`online`, `degraded`, `offline`, `syncing`) that affects the top-bar indicator and, for the non-`online` values, surfaces a non-blocking status banner. The `syncing` value is visual-only — it MUST NOT trigger any sync queue, backend call, persistence write, IPC message, or preload-bridge change.

#### Design tokens

- **FR-17.** The feature MUST define a **design-token set** covering: **colors** (semantic palette: surface, text, primary, danger, warning, success, neutral, focus), **spacing** (a discrete scale, e.g. 4 / 8 / 12 / 16 / 24 / 32 px), **typography** (font family, weight scale, size scale, line-height scale), **radius** (corner-radius scale), **shadows** (elevation scale), and **density**. The shell ships with a single applied density value: **comfortable** (touch-friendly, optimised for cashier readability — minimum 44 × 44 px touch targets per NFR-5). A **`compact`** density value MAY be reserved as a future token for downstream features; **no density toggle, no settings UI, no runtime density switching, and no compact layouts are implemented in this feature**.
- **FR-18.** All shared components MUST consume tokens — no hard-coded colours, sizes, or shadows in component code.

#### Shared UI component inventory

- **FR-19.** The feature MUST define a shared component inventory containing at minimum: **Button**, **Input**, **Card**, **Table**, **Badge**, **Dialog**, **Toast**, and **StatusBanner**. Each MUST have documented variants (e.g. button: primary / secondary / ghost / destructive; input: default / disabled / error) and documented states (default, hover, focus, active, disabled).
- **FR-20.** Every shared component MUST be usable from any placeholder pane and MUST honour the shell's single **comfortable** density value and the locale-direction setting. (Components MUST NOT depend on a runtime density switcher, since none is delivered in this feature.)

#### Accessibility

- **FR-21.** The shell MUST meet at minimum **WCAG 2.1 AA** for colour contrast, focus visibility, and semantic structure (landmark roles for top bar, navigation, main, status).
- **FR-22.** Every interactive element MUST have an accessible name, an accessible role, and a visible focus ring.
- **FR-23.** Live updates (toasts, status banner changes, connection-status changes) MUST be announced to assistive tech via the appropriate live-region semantics.

#### Visual handoff

- **FR-24.** The feature MUST produce a **handoff package** sufficient for a Figma Make prototype and a later Figma MCP implementation pass: token table (incl. the reserved `compact` density token even though it is not applied), component inventory list, navigation map covering the **two** active rail layouts (expanded ≥ 1280 px and icon-only 1024–1279 px) plus the **"screen too small"** fallback below 1024 px, the **four** connection-state visuals (`online` / `degraded` / `offline` / `syncing`), the per-pane state-variant matrix (default / loading / empty / error), and screen-region annotations. (The Figma file itself lives outside the repo; this feature only produces the textual handoff content under `specs/003-pos-ui-shell/`.)

### Non-Functional Requirements

- **NFR-1. (Test-first.)** Every new shared component MUST ship with a Vitest suite that covers its documented variants and states. Coverage on the shared-component module MUST be ≥ 90 % lines / branches.
- **NFR-2. (Type safety.)** All component props, token contracts, and navigation contracts MUST be typed in TypeScript strict mode. No `any`, no `as` casts in component public surfaces.
- **NFR-3. (Target viewport.)** The shell MUST render correctly across two designed rail layouts: **expanded rail at effective width ≥ 1280 px** (primary cashier layout, validated up to 1920 × 1080) and **icon-only rail at 1024–1279 px** (secondary supported layout). Both MUST work at Windows display scaling 100 % and 125 %, and at 150 % only as constitution v1.7.0 § Hardware (Display row) allows: not for the pilot, and otherwise only where the effective viewport is ≥ 1024 × 600 (amended 2026-10-15, RT-312 D8/D15). Below **1024 px** effective width the shell MAY render a "screen too small" message; that band is **not** a target production viewport for MVP and **no mobile hamburger drawer** is implemented.
- **NFR-4. (Performance.)** First post-pairing paint of the shell MUST occur within **500 ms** on the reference cashier hardware (measured from the moment the pairing-gate state resolves). Navigation between placeholder routes MUST feel instant — no spinner on simple route changes.
- **NFR-5. (Touch targets.)** All interactive elements reachable from the shell MUST meet a **minimum touch-target size of 44 × 44 CSS px** (matching common touchscreen-cashier guidance).
- **NFR-6. (Keyboard ergonomics for POS.)** The shell MUST support arrow-key navigation in the navigation rail and Enter/Space activation. Modal dialogs MUST trap focus and restore focus on dismiss.
- **NFR-7. (No business-logic regression.)** The feature MUST NOT modify the existing pairing flow, IPC bridge, preload surface, SecretStore, OpenAPI snapshot, database, or Sentry / logging configuration.
- **NFR-8. (Accessibility automation.)** A baseline accessibility check (e.g. `axe`-style automated rule pass on each placeholder pane in default / loading / empty / error states) MUST be wired into the test suite for the shell module.
- **NFR-9. (Locale-direction safe.)** Layout MUST use logical CSS properties (inline-start / inline-end) — not hard-coded left/right — so a later RTL locale flip is non-breaking.
- **NFR-10. (Stability.)** No flaky tests; the shell test suite MUST pass deterministically on `windows-latest` CI.

## Success Criteria

Measurable, technology-agnostic outcomes. The feature is "done" when these are demonstrably true.

- **SC-1.** A team member can open the application on a paired terminal and visit every navigation entry (Dashboard, Sales, Cart, Receipts/Checkout, Inventory, Settings/Help) using the mouse, the keyboard alone, and a touch screen, in under 60 seconds, without seeing any visual glitch or unstyled element.
- **SC-2.** A designer can open the published handoff package (`specs/003-pos-ui-shell/`) and reproduce every screen region, every state variant, and every shared component in Figma Make without asking the engineering team a single layout-clarification question.
- **SC-3.** Every placeholder pane has a documented and testable loading / empty / error variant; the connection-state indicator has a documented and testable variant for each of `online`, `degraded`, `offline`, and `syncing` (the last one purely visual).
- **SC-4.** The shell renders cleanly at the **comfortable** density default with all interactive elements meeting the 44 × 44 px touch-target floor; no density toggle is exposed in the running app.
- **SC-5.** Automated accessibility checks pass for the default / loading / empty / error variants of every placeholder pane.
- **SC-6.** The shell test suite achieves ≥ 90 % coverage on the shared-component module and runs deterministically in CI on `windows-latest`.
- **SC-7.** No file under `src/main/`, `src/preload/`, or `src/shared/bridge-api.ts` is modified by this feature.
- **SC-8.** The navigation rail correctly switches between the **expanded layout** (≥ 1280 px) and the **icon-only layout** (1024–1279 px) without layout breakage; below 1024 px a "screen too small" message is shown and **no** mobile hamburger drawer is rendered at any width.
- **SC-9.** The Receipt / Checkout placeholder renders the eleven reserved payment-tender visual slots (six tender rows + four amount fields + receipt-breakdown row) in fixed order with a clearly-labelled "Reserved for 005-checkout-payments" body in each, and a guard test asserts that mounting / hovering / focusing / clicking any reserved slot triggers **zero** fetch, IPC, persistence, or printing call.

## Key Entities

This is a UI-only feature; there are no domain entities. The conceptual artifacts produced are visual contracts only:

- **DesignToken** — a named, semantic value (colour / spacing / typography / radius / shadow / density) consumed by the shared component inventory.
- **SharedComponent** — a typed, themed UI primitive (Button, Input, Card, Table, Badge, Dialog, Toast, StatusBanner) usable from any placeholder pane.
- **ShellRegion** — a named layout slot in the AppShell (TopBar, NavRail, MainContent, StatusBanner, OperatorSlot, ConnectionIndicator).
- **PlaceholderPane** — a routed content region (Dashboard, Sales, Cart, Receipt, Inventory, Settings) with documented default / loading / empty / error variants.

## Assumptions

- The terminal is already paired before this feature is reached; pairing is delivered by `002-terminal-pairing` and is unchanged here.
- The cashier monitor is a Windows desktop / touchscreen of at least 1280 × 800 effective resolution, scaled per the constitution's hardware matrix (v1.7.0 Display row: 100 % for the pilot standard, 125 % only with the menu bar removed, 150 % not supported for the pilot).
- Cashier login (operator identity) is **explicitly deferred** to a later feature. This feature only renders an operator placeholder.
- The shared-component inventory listed (Button / Input / Card / Table / Badge / Dialog / Toast / StatusBanner) is sufficient for the post-pairing placeholder regions; additional primitives MAY be introduced later without amending this spec.
- Vitest, ESLint / Prettier, and the existing `npm run typecheck` / `npm run lint` / `npm test` gates are the only test infrastructure used. No new test framework is introduced.
- All real network calls, real inventory data, real cart logic, real receipts, and real auto-update plumbing remain handled by future features and are mocked / placeheld here via dev / story toggles.
- Localization (string catalogues, RTL flip) is **out of scope**, but layout MUST be locale-direction-safe (NFR-9).

## Out of Scope

Explicitly NOT delivered by this feature. Items here block scope creep and inform the next feature's planning.

- **Cashier login implementation** — no operator session, no auth, no identity beyond a placeholder.
- **Sales / cart / receipt / checkout business logic** — only layout placeholders.
- **Payments** of any kind.
- **Receipt printing** of any kind.
- **Inventory mutation** of any kind (read or write).
- **Offline sync, queueing, or replay** — only a *visual* offline / degraded indicator.
- **Backend API calls** — no fetches, no real loading data, no real error data.
- **New IPC channels** — preload bridge surface unchanged.
- **Preload bridge changes** of any kind.
- **`SecretStore` changes** of any kind.
- **Terminal-pairing changes** — pairing flow, copy, banners, error states unchanged.
- **Admin-side pairing UI** — separate product surface.
- **Self-service unpair** — already removed in `002-terminal-pairing` (T078); MUST NOT be re-introduced here.
- **Auto-update implementation** — UI affordance for "an update is available" MAY be a placeholder later, but is not part of this feature.
- **Database migrations** — no schema, no `better-sqlite3` changes.
- **OpenAPI / generated-types changes** — no new endpoints, no codegen runs.
- **Sentry / logging changes** — no new breadcrumbs, no new redaction rules.
- **Localization (string catalogue, RTL)** — layout is direction-safe, but no RTL build delivered here.
- **Mobile-first navigation / hamburger drawer / bottom-tab bar** — not implemented at any viewport width; sub-1024 px is handled by a static "screen too small" message.
- **Runtime density toggle / settings UI for density** — only the comfortable density value is applied; `compact` MAY be reserved as a token but is not switchable in this feature.
- **Real offline-sync queue, replay, persistence, or backend calls behind the `syncing` state** — `syncing` is a visual placeholder only; the implementing logic ships in a future feature.
- **All payment / tender logic** — totals math, change calculation, balance arithmetic, currency formatting, `Money` typing, payment-state machine. Reserved for **005-checkout-payments**.
- **Card-terminal integration** of any kind — device discovery, pairing, EMV / contactless / chip-and-PIN message exchange. Reserved for **005-checkout-payments**.
- **Insurance validation** of any kind — eligibility, prior-auth, claim submission, response handling. Reserved for **005-checkout-payments**.
- **Voucher / gift-card validation** of any kind — balance lookup, redemption, lock, refund. Reserved for **005-checkout-payments**.
- **Receipts printing** of any kind — print queue, driver communication, receipt rendering pipeline. Reserved for **005-checkout-payments** (paired with a future receipts-printing feature).
- **Sales / cart / line-item / order business logic** — placeholder layouts only; reserved tender / totals slots carry no values and no behaviour.
- **Payment APIs / SDKs / gateways** — no new dependencies, no new hosts, no new endpoints, no new IPC channels for payment.

## Dependencies

- **`001-foundation`** — Electron / React / Vite / TypeScript / Vitest / ESLint / Prettier / CI pipeline are already in place. This feature consumes them unchanged.
- **`002-terminal-pairing`** — provides the paired-terminal state, the pairing gate, the tenant / branch / terminal-label values surfaced in the top bar, and the bridge contracts. This feature consumes them read-only.
- **Constitution `v1.3.0`** — Principle III (Electron process-boundary discipline), Principle V (type safety), Principle VI (test-first, coverage-gated), Principle VIII (terminal identity ≠ user identity), and Principle IX (reference, not inheritance) all apply directly.
- **Figma Make / Figma MCP** — *external visual tools* used by the design workflow described below; this repo never depends on Figma at build time. Figma is treated as a visual reference, not a source of code.
- **Forward dependency: 005-checkout-payments (deferred, not yet specified)** — will own all payment / tender logic and consume the eleven reserved slot ids declared in this spec (`tender.{cash|card|bank-transfer|voucher|insurance|split}`, `totals.{amount-due|amount-paid|remaining|change-due}`, `receipt.breakdown`). 003 ships only the labelled rectangles; **005 owns the values, the math, the validation, the integrations, and the persistence**.

## Design workflow decision

This feature is the first POS-Pulse feature whose output is primarily *visual*, so the team has agreed an explicit tooling workflow that keeps the repo as the single source of truth for code.

- **Figma Make is used only for prototype exploration.** It is allowed to generate, throw away, and iterate on visual mockups quickly. No Figma Make output is treated as a contract.
- **A reviewed Figma file becomes the visual source.** Once the team agrees on a prototype, it is captured in a stable Figma file (separate from Figma Make's exploration space). That file is the visual reference for component style, spacing, typography, and state variants.
- **Figma MCP + Claude Code is used later for repo implementation.** When implementation begins (in this or a follow-up feature), Figma MCP is the bridge that lets Claude Code read the reviewed Figma file. The implementation pass must still produce typed, tested code that satisfies this spec.
- **Repo code remains the final source of truth.** If the Figma file and the repo disagree, the repo wins. The Figma file is updated to match — never the other way around without a spec amendment.
- **No generated design code is accepted directly without review and tests.** Any code suggested by Figma MCP (or any other design-to-code tool) MUST go through the standard review pipeline: typecheck, lint, tests, code review, CI gates. No bypass.
- **Constitution alignment.** This workflow is consistent with Principle IX (Reference, Not Inheritance): Figma is a *reference*, not a parent the repo inherits from.

## Open Questions

(Use sparingly. Maximum 3. Resolved questions move into the **Clarifications** section above.)

- (none — all three previous questions resolved 2026-05-04; see **Clarifications**.)

---

*Constitution alignment:* This spec MUST satisfy the principles of `.specify/memory/constitution.md`
(version pinned at the time of writing, `v1.3.0`). The plan and tasks artifacts will perform the
explicit "Constitution Check." Principle VIII in particular is load-bearing here: this feature
renders an operator placeholder but MUST NOT implement user identity, login, or session.
