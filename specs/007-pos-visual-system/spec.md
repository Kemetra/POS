# Feature Specification: POS Visual System Recovery

**Feature ID:** 007-pos-visual-system
**Feature Branch:** `docs/007-pos-visual-system-clarify`
**Status:** Draft (clarified 2026-05-10 — plan / tasks / analyze NOT yet run)
**Created:** 2026-05-10
**Last Updated:** 2026-05-10 (clarifications applied — see Clarifications session 2026-05-10)
**Owner:** POS-Pulse desktop team
**Specify PR:** [#107 — docs(007): specify POS visual system recovery](https://github.com/ahmed-shaaban-94/POS-Pulse/pull/107) (merged)
**Input:** Product-owner directive — "POS Pulse UI feels primitive and does not match
the intended Claude Design visual direction. Before sales / cart / payments are built on
top, the visual system must be recovered to a professional, terminal-first standard."

---

## Overview

POS Pulse has shipped foundation (`001`), terminal pairing (`002`), the POS UI shell
(`003`), and the operator/session boundary (`004`). The shell has design tokens, a
shared component inventory, an `AppShell`, a navigation rail, and the operator
sign-in surfaces planned in `004` Slice 0. In product use, however, the screens still
**feel primitive and visually inconsistent**: the terminal does not yet read as a
professional, polished, terminal-first POS surface, and it does not match the
intended visual direction the team has previously referred to as "Claude Design".

This feature recovers the visual system as **product behaviour and acceptance
rules** before any further sales / cart / payments features are built on top.
It deliberately stops short of any source code, migrations, OpenAPI changes, IPC
changes, or preload changes. Its purpose is to lock in (a) what "polished" must
mean for POS Pulse, (b) the per-surface acceptance rules and screenshot evidence
required before each visual slice may merge, and (c) the security and visibility
boundaries the visual recovery MUST NOT weaken. Existing functional work in 001 /
002 / 003 / 004 remains valid; this is a **visual recovery and systemisation
feature**, not a rewrite of business logic.

This feature is also a structural application of `004` FR-033: every UI-bearing
feature that follows MUST run an early visual-direction pass between
`/speckit-plan` and the first implementation slice. 007 *is* that visual-direction
pass for the entire POS terminal — the one that 005 (sales / cart) and 006
(payments / tender) inherit before their UI slices may be implemented.

## Clarifications

The three NEEDS CLARIFICATION markers raised by the specify phase (PR #107)
are resolved here. Resolved items are now load-bearing requirements (see
updated FRs / Assumptions / Out-of-Scope / Dependencies) and the markers
have been removed from §"Open Questions" below.

### Session 2026-05-10

- **Q: Canonical visual reference set for the 007 recovery (was Q1).**
  → **A:** Canonical references are, in this priority order:
  1. **Claude Design** design-system / deck / prototype output, once
     exported by or linked to by the product owner. Until exported or
     linked, no Claude Design artifact is canonical.
  2. **Figma Make** prototype output, if and only if approved by the
     product owner. Unapproved Figma Make exploration is reference-only
     and never canonical.
  3. **Existing repo references remain binding constraints** (i.e. they
     bind even when (1) or (2) is named):
     - `specs/004-operator-session/visual-direction/README.md`
     - `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`
     - `specs/003-pos-ui-shell/contracts/`

  External design references are **visual references only, not
  production source code** — direct copy-paste of HTML / JSX from any
  external reference into production code is forbidden (FR-034 /
  FR-035). The three repo references in (3) override (1) and (2)
  whenever they disagree (Constitution Principle IX).

- **Q: 005 / 006 blocking scope (was Q2).**
  → **A:** 007 blocks **the UI implementation slices** of
  `005-sales-cart` and `006-payments-tender`, **not** their non-UI
  backend / domain planning or specification.

  - Sales / cart / payment UI MUST NOT be built on the current primitive
    foundation. UI implementation for 005 / 006 waits until at least
    **007 Slices S1, S2, and S3** are approved.
  - Planning, specification, contract design, data-model work, money-
    math wiring, audit-attribution wiring, and any other non-UI work
    for 005 / 006 MAY continue in parallel with the visual recovery.
  - The 007 slice numbering used here (S1, S2, S3) refers to the
    visual-recovery slice plan that `/speckit-plan` will produce; it is
    forward-looking and NOT determined by this specify-phase document.
    The plan phase MUST name S1 / S2 / S3 explicitly so this gate is
    auditable.

- **Q: Theme count for acceptance (was Q3).**
  → **A:** **One polished light theme only for now.** Dark mode is
  **out of scope for 007** unless explicitly approved later by the
  product owner. Typography uses **Inter as the primary font, with
  system-UI as the fallback when Inter is unavailable**; **no
  missing proprietary brand fonts** — the recovery MUST NOT
  introduce a font dependency whose absence on a paired Windows
  10 / 11 terminal causes a fallback visual regression.

  This decision narrows §"Out of Scope" §"Multi-theme runtime
  switching" from "pending Q3" to a hard exclusion until a future
  feature explicitly re-opens it, and adds Assumption A10 for the font
  policy.

## User Scenarios & Testing *(mandatory)*

<!--
  User stories are PRIORITIZED. Each story is INDEPENDENTLY TESTABLE: implementing
  only P1 yields a viable MVP slice that delivers measurable value. P2 layers
  shell-and-route polish. P3 layers the operator-session screens (PinPad,
  TakeoverPrompt) and the screenshot-acceptance gate.
-->

### User Story 1 — Visual language and design tokens are recovered (Priority: P1)

A product reviewer opens the running POS Pulse application on a paired terminal
and sees a coherent, professional visual language: a deliberate color palette
with semantic intent (surface, text, primary, danger, warning, success, focus,
neutral), a deliberate typography scale, deliberate spacing, deliberate radius,
deliberate shadow, deliberate density, and a deliberate touch-target floor.
Every screen — pairing, paired confirmation, sign-in, the dashboard placeholder,
the cart placeholder, the inventory placeholder, the settings placeholder, and
all loading / empty / error states — reads as members of the **same family**.
The reviewer can describe the visual system to a stakeholder in one sentence
("it's a calm, terminal-first, high-contrast, touch-comfortable system in two or
three accent colors") without reaching for screenshots.

**Why this priority**: Tokens and shared visual language are the precondition
for every subsequent polish slice. Without recovered tokens, polishing
individual screens produces local wins that immediately drift apart again. P1
is the smallest slice that delivers a measurable product capability — every
later screen MUST consume the recovered tokens — and is therefore the
foundation 005 / 006 inherit.

**Independent Test**: A reviewer walks through every existing route while
narrating the token map. They confirm: every interactive element honours the
44 × 44 CSS-pixel touch-target floor; no screen uses an off-palette color, an
off-scale spacing value, or an off-scale typographic step; the focus ring is
visible and consistent; the four connection-state visuals
(`online` / `degraded` / `offline` / `syncing`) are visually distinct without
relying on color alone. No business logic is exercised.

**Acceptance Scenarios**:

1. **Given** the recovered token set is documented and applied, **When** any
   two existing routes are placed side-by-side at a 1280 × 800 viewport,
   **Then** they read as members of the same visual family — no drift in
   color, spacing, typography, radius, or shadow tokens between them — and a
   reviewer can identify the system in one sentence.
2. **Given** the recovered token set is applied, **When** a reviewer
   enumerates the semantic palette, **Then** the palette covers at minimum
   surface, text, muted text, primary accent, danger, warning, success,
   neutral, and focus, and **no surface uses a hex value or RGB literal that
   does not appear in the documented palette**.
3. **Given** the recovered token set is applied, **When** any interactive
   element on any existing route is measured, **Then** its touch target meets
   the 44 × 44 CSS-pixel floor inherited from `003` NFR-5 / Constitution
   Hardware Matrix.
4. **Given** color is never the only signal, **When** a reviewer simulates
   monochrome rendering (e.g. by inspecting in greyscale), **Then** state
   changes (focus, error, success, locked, offline) remain distinguishable
   via icon, label, and shape — not only via color.
5. **Given** the focus ring is consistent, **When** a reviewer keyboards
   through every route, **Then** the focus ring is visible on every
   interactive element, uses the same focus-ring token across the application,
   and is never clipped by the surrounding container.

---

### User Story 2 — Shell, layout primitives, and route-level pages are recovered (Priority: P2)

A reviewer signs in on a paired terminal and walks the existing routes. The
**top bar**, the **navigation rail / sidebar**, and the **status / banner
region** look deliberate and consistent. The cashier identity slot (operator
badge), the connection-state visual, and the rail's expanded vs. icon-only
behaviour all read as part of the same system. Each route — the dashboard
placeholder, the cart placeholder, the inventory placeholder, the settings
placeholder, the receipt / checkout placeholder, the pairing / paired surfaces
— uses a shared **route layout primitive** (heading, subtitle slot, body slot,
side-rail slot, action-bar slot) so the cognitive cost of moving between
screens is low. Buttons, cards, forms, modals, alerts, loading states, and
empty states all use the recovered shared primitives — no ad-hoc one-off
components, no off-palette CSS in route files.

**Why this priority**: The existing primitives (`Button`, `Input`, `Card`,
`Table`, `Badge`, `Dialog`, `Toast`, `StatusBanner`) and the existing
`AppShell` / `NavRail` / `TopBar` regions already exist (delivered by `003` /
`004`); the work is **harmonising and visually upgrading** them, not creating
them. P2 is what makes the recovered tokens (P1) visible across the chrome
the cashier looks at all day, and it is the precondition for polishing the
operator surfaces (P3).

**Independent Test**: A reviewer inspects every existing route at the two
designed viewport bands (≥ 1280 px and 1024–1279 px) and confirms: the shell
chrome (top bar, rail, banner region) is visually identical across routes;
each route uses the shared layout primitive in the same way; every visible
button / card / form control / modal / alert / empty-state / loading
indicator is sourced from the shared inventory and not from a one-off
implementation; the rail's expanded vs. icon-only transition at 1280 px is
clean and not jarring; the "screen too small" fallback below 1024 px remains
the same friendly message it was in 003.

**Acceptance Scenarios**:

1. **Given** the recovered shell, **When** a reviewer compares the top bar,
   the rail, the operator badge, and the status / banner region across every
   existing route, **Then** those regions render identically across routes —
   no drift in spacing, alignment, typography, or background tone.
2. **Given** a route layout primitive is in use, **When** a reviewer opens
   any two existing route pages side-by-side, **Then** the heading position,
   subtitle treatment, body padding, and action-bar position are visually
   identical across the two routes.
3. **Given** the rail's responsive behaviour, **When** the viewport is
   resized across the **1280 px** and **1024 px** breakpoints, **Then** the
   rail transitions cleanly between expanded and icon-only and to the
   "screen too small" fallback respectively — without layout flicker, broken
   icons, or text overflow at any width.
4. **Given** the shared primitive inventory, **When** a reviewer audits every
   existing route's source for visible UI components, **Then** every button,
   input, card, table, badge, dialog, toast, status banner, loading state,
   empty state, and error state is sourced from the shared inventory — no
   ad-hoc CSS-only buttons, no inline `<input>` without the shared input
   shape, no one-off card surface.
5. **Given** the connection-state indicator from `003`, **When** the visual
   recovery is applied, **Then** the four states (`online` / `degraded` /
   `offline` / `syncing`) remain visually distinct, the `syncing` state
   remains visual-only (no real sync work), and the indicator continues to
   sit in the top bar location 003 reserved.

---

### User Story 3 — Operator-session screens are visually recovered (Priority: P3)

A reviewer walks the operator-bound surfaces specified by `004`: the cashier
sign-in screen (roster + PIN), the manager / admin sign-in screen
(password), the takeover-prompt modal, the role-indicator slot in the shell,
and the operator-bound landing surface. Each surface visually matches the
recovered system from P1 and P2 and matches the **`004` Slice 0 visual
direction contact sheet** verbatim (six surfaces, cross-cutting commitments,
no new tokens). The PinPad reads as a cashier-grade numeric pad — large
touch targets, clear key separation, calm dot row, deliberate focus-ring
treatment — not as a stock HTML number input. The TakeoverPrompt reads as a
calm, single-decision modal that respects `004` FR-013's minimum-disclosure rules.
Every state (default, roster-picked, pin-entering, submitting, three failure
variants A / B / C, takeover-prompt prompted / confirming / error) is
covered by a screenshot in a contact sheet attached to the implementing PR,
and a reviewer signs off the contact sheet before the implementation slice
merges.

**Why this priority**: 004's plan (v1.1) explicitly gates Slices 1 / 3 / 4 /
5 behind §A1–§A4 approval and behind a Slice-0 visual review. The
operator-session screens are where the visual recovery is most product-
critical — the cashier looks at the sign-in surface every shift, and the
takeover modal is a load-bearing minimum-disclosure surface. P3 lands the
visual polish on top of P1 + P2 and binds the screenshot / contact-sheet
acceptance rule (`004` FR-035) into the merge gate for those slices.

**Independent Test**: A reviewer compares the implemented operator surfaces
against the `004` Slice 0 contact sheet's six surfaces, ten screenshot files
named in `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`
§7, and the PR's contact sheet. They confirm: every surface matches the
contact sheet within the §7 pixel-diff thresholds; every forbidden-string
assertion (terminal-A label, prior-session timestamp, other operator's name
or role, "View details" affordance) holds in the rendered DOM under
`[data-testid="takeover-prompt"]`; no new design tokens were introduced; no
new connection state was introduced; the `comfortable` density, the
44 × 44 px touch floor, and the **single light theme rule** (per
Clarifications session 2026-05-10 / FR-052) all hold.

**Acceptance Scenarios**:

1. **Given** the recovered visual system, **When** a reviewer opens the
   cashier sign-in surface in default state on a 1280 × 800 viewport,
   **Then** the layout matches the `004` Slice 0 contact-sheet sketch for
   Surface 1 (roster grid + PIN pad + "Sign in as manager" link, no
   navigation rail) within the documented pixel-diff thresholds.
2. **Given** the takeover prompt is shown, **When** a reviewer inspects the
   rendered DOM, **Then** none of the `004` FR-013 forbidden strings (terminal-A
   label, prior-session start time, prior-session duration, other
   operator's name, other operator's role, "View details" / "Why am I
   seeing this" / "Show details") appear in the modal subtree, and the
   modal copy matches verbatim the strings recorded in the `004` planning
   document §7.
3. **Given** the role indicator slot is active, **When** an operator is
   signed in, **Then** the slot shows the operator's display name and role
   business label only (no email, no phone, no Clerk user id), updates
   immediately on sign-out, and consumes the same shell-region treatment as
   the rest of the recovered chrome.
4. **Given** the implementing PR for any operator-session visual slice,
   **When** the PR is opened, **Then** it carries a contact sheet of
   screenshots covering each state in the `004` planning document §7
   table (default, roster-picked, pin-entering, submitting, failure
   variants A / B / C, takeover prompt prompted / confirming / error), at
   both 1280 × 800 and at least one 1024 × 768 sample, and a reviewer signs
   off the sheet before merge.
5. **Given** the implementing PR for any operator-session visual slice,
   **When** the diff is inspected, **Then** no file under the bridge,
   preload, main-process, migrations, OpenAPI snapshot, or CI workflow
   forbidden-allowlist (`003` plan §"Hard Non-Implementation Boundaries")
   has been touched.

---

### Edge Cases

- **No "Claude Design" mocks exist in the repository working tree**: this
  feature acknowledges that the references to "Claude Design" inside `003`
  and `004` planning artifacts point to (a) Figma / external visual mocks
  that live outside the repository, and (b) the Slice 0 contact sheet
  embedded in `specs/004-operator-session/visual-direction/README.md`. The
  question of "which Claude Design files are canonical" is therefore an
  open clarification (see Open Questions Q1) rather than a question with
  a discoverable answer in the repo.
- **Existing routes contain no real data**: the recovery acceptance is
  performed against placeholder data (per `003`'s placeholder-only
  posture). No real sales, cart contents, inventory rows, or receipts are
  required to evaluate this feature; the visual recovery is testable on
  the existing placeholder surfaces.
- **Below 1024 px effective viewport**: the visual recovery preserves
  `003`'s "screen too small" fallback verbatim. No mobile drawer, no
  hamburger menu, no bottom-tab bar is introduced at any viewport width.
- **High-DPI / Windows scaling 100 / 125 / 150 %**: the recovered visuals
  MUST remain crisp and legible at all three Windows display-scale
  values across the two designed viewport bands, with no clipped
  characters, missing focus rings, or off-grid pixel rounding on
  borders. 150 % is qualified by NFR-012 (amended 2026-10-15,
  RT-312 D8/D15): not supported for the pilot, and otherwise only
  where the effective CSS viewport is at least 1024 × 600.
- **Reduced-motion users**: any motion introduced by the recovery (e.g.
  spinner rotation, modal fade-in, rail expand transition) MUST honour
  the user's `prefers-reduced-motion` preference. A reduced-motion
  reviewer sees no hostile animation; transitions degrade to immediate
  state swaps with no spinner rotation.
- **Right-to-left locale (future-aware)**: layout uses logical CSS
  properties (`inline-start` / `inline-end`) only, so a future RTL flip
  is non-breaking. Localisation strings themselves are out of scope.
- **Dark-mode preference of the OS**: this feature commits to **one
  polished light theme only** (Clarifications session 2026-05-10 /
  FR-052). The recovered surfaces MUST NOT respond to a dark-mode OS
  preference — the application renders the same light theme regardless
  of the user's `prefers-color-scheme` setting. Dark-mode delivery is
  deferred to a later, explicitly-approved feature.
- **Cashier-forbidden information in screenshots**: any screenshot
  attached to a 007 implementing PR for a manager-or-admin surface MUST
  NOT leak cashier-forbidden information when reviewed by a cashier;
  reviewers attaching screenshots redact / mock financial values before
  attaching when the screenshot includes a cashier-forbidden surface
  (`004` FR-015 cashier-forbidden information catalogue).
- **Takeover prompt visual review**: the contact sheet for the takeover
  prompt MUST NOT display a real other-operator's identity, terminal
  label, or session timestamp — even in screenshots — to preserve the
  `004` FR-013 minimum-disclosure rule across review artifacts.

## Requirements *(mandatory)*

### Functional Requirements

Each requirement is testable, unambiguous, and uses MUST / SHOULD / MAY.

#### FR-Visual language

- **FR-001**: This feature MUST recover and document a coherent **visual
  language** for POS Pulse covering: color (semantic palette), spacing,
  typography (family, weight, size, line-height), radius, shadow / elevation,
  and density. The language MUST be expressible in a single sentence by a
  reviewer ("calm, terminal-first, high-contrast, touch-comfortable in two
  or three accents") without resorting to screenshots.
- **FR-002**: The visual language MUST be applied consistently across every
  existing route delivered by 001 / 002 / 003 / 004 — pairing, paired
  confirmation, sign-in (cashier and manager / admin paths), dashboard,
  sales placeholder, cart placeholder, receipt / checkout placeholder
  (with `005-checkout-payments`'s reserved slots intact), inventory
  placeholder, settings / help placeholder. No route may use an
  off-palette color, an off-scale spacing value, or an off-scale
  typographic step.
- **FR-003**: The visual language MUST reuse `003`'s existing token surface
  as the substrate. New tokens introduced by 007 MUST be additive,
  documented in the recovered token table, and scoped semantically (no
  raw color names, no raw size literals as token names). 007 MUST NOT
  silently rename, repurpose, or remove an existing `003` token; any such
  change requires an explicit amendment to this spec.
- **FR-004**: Color MUST never be the *only* signal of state. Every state
  change (focus, error, success, locked, offline, syncing) MUST carry a
  non-color cue — icon, label, shape, weight, or position — in addition
  to its color treatment.

#### FR-Design tokens

- **FR-005**: The recovered token set MUST cover, at minimum: a semantic
  color palette (surface / surface-muted / text-primary / text-muted /
  primary accent / danger / warning / success / neutral / focus), a
  spacing scale, a typography scale (family, weight set, size ramp,
  line-height set), a radius scale, a shadow / elevation scale, a single
  applied density value, and a touch-target floor. The exact values are
  determined by the visual-direction work in plan / Slice 0; this spec
  fixes only the *shape* of the table, not the values.
- **FR-006**: The recovered touch-target floor MUST remain at minimum
  44 × 44 CSS px on every interactive element, inherited from `003`
  NFR-5 / Constitution Hardware Matrix.
- **FR-007**: The recovered density MUST remain `comfortable` (touch-
  friendly), inherited from `003`'s clarifications. The reserved
  `compact` density token MAY remain as a future-only token; 007 MUST
  NOT introduce a runtime density toggle, a settings UI for density, or
  any compact layout in this feature.
- **FR-008**: 007 MUST NOT introduce a new connection-state value. The
  four-state model (`online` / `degraded` / `offline` / `syncing`) from
  `003` FR-7 / FR-16 is preserved verbatim, with `syncing` remaining
  visual-only (no real sync work, no backend call, no IPC, no
  preload-bridge change).

#### FR-Shell / sidebar / topbar

- **FR-009**: The recovered shell chrome (top bar, navigation rail /
  sidebar, status / banner region) MUST render identically across every
  existing route. The cashier identity slot, the connection-state
  indicator, the tenant / branch / terminal label, and the rail's
  active-entry treatment MUST not drift between routes.
- **FR-010**: The navigation rail's responsive behaviour from `003` FR-2
  MUST be preserved: at ≥ 1280 px the rail renders icons + labels; at
  1024–1279 px the rail renders icons only with accessible names and
  tooltips; below 1024 px the shell renders the "screen too small"
  fallback. 007 MUST NOT introduce a mobile hamburger drawer at any
  viewport width.
- **FR-011**: The shell's top bar MUST visually distinguish the
  connection-state indicator, the operator slot, and the
  tenant / branch / terminal label from each other; no two of those
  three regions may visually merge into a single ambiguous block.

#### FR-Route layout foundation

- **FR-012**: 007 MUST define a **route layout primitive** consumed by
  every existing route page. The primitive MUST expose, at minimum: a
  heading slot, a subtitle / breadcrumb slot, a body slot, an optional
  side-rail slot, and an optional action-bar slot. The primitive's
  slots MUST be visually identical across routes — heading position,
  subtitle treatment, body padding, action-bar position MUST not
  drift between routes.
- **FR-013**: Every existing route page MUST consume the route layout
  primitive defined in FR-012. No route may render its heading,
  subtitle, body, or action-bar with ad-hoc CSS that bypasses the
  primitive.

#### FR-Buttons / cards / forms / modals / alerts / loading / empty states

- **FR-014**: Every visible button across every existing route MUST be
  sourced from the shared primitive inventory (the existing 003
  `Button` primitive plus its variants). No button may be implemented
  inline in a route file as a styled `<button>` outside the primitive.
- **FR-015**: Every visible input across every existing route MUST be
  sourced from the existing `Input` primitive. No input may be
  rendered inline as a bare `<input>` outside the primitive.
- **FR-016**: Every visible card surface across every existing route
  MUST be sourced from the existing `Card` primitive.
- **FR-017**: Every modal across every existing route MUST be sourced
  from the existing `Dialog` primitive. The takeover prompt
  (`TakeoverPrompt` from 004) MUST consume `Dialog` rather than a
  one-off modal implementation. The modal scrim treatment, focus
  trap, and Escape-to-cancel behaviour MUST be identical across all
  modals.
- **FR-018**: Every visible alert across every existing route MUST be
  sourced from the existing `StatusBanner` primitive (or its inline
  alert variant). The four connection-state intents (online,
  degraded, offline, syncing) MUST render distinct icon + label
  treatments via the `StatusBanner` family.
- **FR-019**: Every visible loading state across every existing route
  MUST be sourced from the existing `LoadingState` primitive. Spinner
  motion MUST honour `prefers-reduced-motion`.
- **FR-020**: Every visible empty state across every existing route
  MUST be sourced from the existing `EmptyState` primitive. Empty
  states MUST be friendly, non-alarming, and offer at most one
  suggested next action (which itself remains a placeholder per
  `003`).
- **FR-021**: Every visible error state across every existing route
  MUST be sourced from the existing `ErrorState` primitive. Error
  copy MUST be generic and minimum-disclosure where the error is
  about authentication, session, or any sensitive boundary
  (NFR-003 / 004 PR-1 / PR-2 / PR-3).

#### FR-Pairing and operator-session visual recovery

- **FR-022**: The pairing surface (`002`) MUST be visually recovered to
  the recovered system without changing pairing copy, pairing flow, or
  pairing security (002's pairing-bypass contract remains load-
  bearing). The recovery is **visual only**.
- **FR-023**: The paired-confirmation surface (`002` `/paired`) MUST be
  visually recovered to the recovered system. The "Continue to
  dashboard →" affordance from `003` O2 fallback MUST be preserved.
- **FR-024**: The cashier sign-in surface (`004` Surface 1) MUST be
  visually recovered to match the `004` Slice 0 contact sheet
  verbatim — roster grid, PinPad, "Sign in as manager" link, no
  navigation rail during sign-in.
- **FR-025**: The manager / admin sign-in surface (`004` Surface 2)
  MUST be visually recovered to match the `004` Slice 0 contact
  sheet verbatim — password field with the three generic failure
  variants A / B / C.
- **FR-026**: The takeover-prompt modal (`004` Surface 3) MUST be
  visually recovered to match the `004` Slice 0 contact sheet
  verbatim — three-button layout (Continue here / Cancel / generic
  close), dimmed scrim, modal-only error region, `004` FR-013 minimum-
  disclosure rules preserved (no terminal-A label, no
  prior-session timestamp, no other-operator name / role,
  no "View details" affordance).
- **FR-027**: The role-indicator slot in the shell (`OperatorBadge`)
  MUST be visually recovered. It MUST display the operator's display
  name and role business label only — never email, phone, or any
  other PII attribute — and MUST update immediately on sign-in,
  sign-out, and takeover.

#### FR-PinPad and TakeoverPrompt visual recovery

- **FR-028**: The PinPad component (introduced by 004 S4 / issue 86)
  MUST be visually recovered to match the `004` Slice 0 contact
  sheet's Surface 1 PinPad sketch and the planning document
  §"Component plan" specification: 3 × 4 grid (`1 2 3 / 4 5 6 / 7 8 9
  / ⌫ 0 ↵`), `text-2xl` weight 600 digits, dot-row above grid, focus
  ring on every key, hardware-keyboard parity (`0`–`9`, `Backspace`,
  `Enter`), `Enter` `aria-disabled` below 4 digits.
- **FR-029**: The TakeoverPrompt component (introduced by 004 S4 /
  issue 86) MUST be visually recovered to match the `004` Slice 0
  contact sheet's Surface 3 sketch and the planning document
  §"Component plan": three-button layout, focus trap inside the
  dialog, click-on-scrim ignored, Escape closes via Cancel,
  `data-state` attribute for `prompted` / `confirming` / `error`.

#### FR-Screenshot / contact-sheet acceptance

- **FR-030**: Every implementing PR for any visual recovery slice
  produced by this feature's downstream `/speckit-plan` MUST attach a
  **screenshot contact sheet** covering each state of each surface
  the slice touches. The contact sheet MUST cover, at minimum, the
  default state and any state variants (loading, empty, error,
  failure variants A / B / C, takeover prompted / confirming /
  error) at the 1280 × 800 viewport and at least one sample at the
  1024 × 768 viewport.
- **FR-031**: The screenshot contact sheet MUST be reviewed by a
  designated reviewer before merge. The reviewer's sign-off MUST be
  recorded in the PR description.
- **FR-032**: Visual changes MUST be sliced into small, independently
  reviewable PRs. No single PR may bundle a broad redesign with
  unrelated behavioural changes; constitutional Principle P13 (small,
  scoped implementation PRs) is load-bearing for this feature.
- **FR-033**: A screenshot attached to any 007 implementing PR MUST
  NOT contain (a) any cashier-forbidden information (`004` FR-015
  catalogue) when it depicts a cashier-reachable surface; (b) any
  `004` FR-013 forbidden strings (terminal-A label, prior-session
  timestamp, other-operator identity, "View details") inside any
  takeover-prompt screenshot; (c) any real customer / patient PII;
  (d) any real cardholder data; (e) any session token, device
  token, or credential fragment.

#### FR-Design-source rule

- **FR-034**: External design references — Figma files, Figma Make
  prototypes, "Claude Design" mocks, screenshots from product or
  design tools — are **references only**. They MUST NOT be copy-
  pasted as HTML or JSX into production code. The repo and approved
  Spec Kit artifacts are the source of truth; if the reference and
  the repo disagree, the repo wins (Constitution Principle IX —
  Reference, Not Inheritance).
- **FR-035**: External design references MUST be translated into
  repo-native artifacts: token table entries, layout primitives in
  `src/renderer/ui/`, primitive components, and CSS that consumes
  the recovered tokens. Direct DOM-level lifting from a reference
  file is forbidden, even when the visual outcome would be
  identical.

#### FR-Security and visibility preservation

- **FR-036**: The visual recovery MUST NOT cause the renderer to
  receive a Clerk JWT, nor any backend session token. (`004` PR-7 —
  *secrets never reach renderer or logs*. Constitution P7 / P8.)
- **FR-037**: The visual recovery MUST NOT cause the renderer to
  receive a `device_token`. The pairing token surface from `002`
  remains main-process-only.
- **FR-038**: The visual recovery MUST NOT cause sensitive payloads
  (credentials, session tokens, raw cardholder data, full PII) to
  appear in the rendered DOM, in logs, or in any screenshot
  attached to an implementing PR.
- **FR-039**: The cashier visibility boundary from `004` FR-015 /
  `004` FR-016 / `004` FR-017 / `004` FR-018 / `004` FR-019 /
  `004` NFR-004 / `004` NFR-009 MUST NOT be weakened by any
  visual change. A surface that was cashier-forbidden online
  MUST remain cashier-forbidden after the recovery.
- **FR-040**: Generic minimum-disclosure error messaging from `004`
  NFR-003 (and the planning document §6 generic copy variants A /
  B / C) MUST be preserved. The visual recovery MUST NOT introduce
  more granular error variants that disclose which authentication
  failure mode applied.

#### FR-Hard non-implementation boundaries

- **FR-041**: This feature MUST NOT introduce any sales / cart
  business logic.
- **FR-042**: This feature MUST NOT introduce any payment / tender
  logic, any money math, any `Money` type, or any value-bearing
  prop on the `005-checkout-payments` reserved slots from `003`.
- **FR-043**: This feature MUST NOT introduce any receipt printing
  logic, no print queue, no driver communication.
- **FR-044**: This feature MUST NOT introduce any inventory
  mutation (read or write).
- **FR-045**: This feature MUST NOT introduce any reports, KPIs,
  dashboards, or analytics surface.
- **FR-046**: This feature MUST NOT introduce any backend API call,
  any new endpoint, any OpenAPI change, or any change to the
  pinned OpenAPI snapshot.
- **FR-047**: This feature MUST NOT introduce any database
  migration, any schema change, or any `better-sqlite3` schema
  alteration.
- **FR-048**: This feature MUST NOT introduce any change to the
  `_reference/Data-Pulse/` directory. That directory is read-only
  legacy reference per Constitution Principle IX (Reference, Not
  Inheritance) and is gitignored.
- **FR-048a**: This feature MUST NOT introduce any change to the
  Data-Pulse-2 SaaS / dashboard repository. Data-Pulse-2 lives
  outside POS-Pulse and is owned by a separate codebase; 007 is a
  POS-Pulse-internal docs-and-renderer feature and is mechanically
  unable to modify Data-Pulse-2 from this branch.
- **FR-049**: This feature MUST NOT introduce any change to Clerk
  authentication behaviour, any change to operator-session
  semantics, any change to terminal-pairing semantics, or any
  change to the role catalogue from `004` FR-002 / FR-002a.
- **FR-050**: This feature MUST NOT introduce any new IPC channel,
  any new preload-bridge surface, or any change to the existing
  preload bridge — *unless* a later approved task explicitly
  scopes one. The default posture is **renderer-only visual
  recovery**.

#### FR-Canonical references and theme policy *(added by
Clarifications session 2026-05-10)*

- **FR-051 (canonical reference set)**: The canonical visual
  reference set for the 007 recovery is the priority-ordered list
  resolved in §"Clarifications session 2026-05-10":
  1. Claude Design design-system / deck / prototype output, **once
     exported by or linked to by the product owner**. Until then,
     no Claude Design artifact is canonical.
  2. Figma Make prototype output, **only when approved by the
     product owner**. Unapproved Figma Make exploration is
     reference-only.
  3. The three repo references — `specs/004-operator-session/visual-direction/README.md`,
     `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`,
     and `specs/003-pos-ui-shell/contracts/` — remain **binding
     constraints** that override (1) and (2) whenever they
     disagree (Constitution Principle IX). External references
     are visual references only, never production source code.
- **FR-052 (single polished light theme + Inter / system-UI font
  policy)**: The 007 recovery delivers **exactly one polished
  light theme**. The recovered surfaces MUST render the same
  light theme regardless of the user's OS-level
  `prefers-color-scheme` setting. Typography MUST use **Inter
  as the primary font family**, with **system-UI as the fallback
  when Inter is unavailable** on the target Windows 10 / 11
  terminal. The mechanism by which Inter reaches the terminal
  (bundled webfont, ship-with-installer, OS pre-install, or any
  other path) is a delivery decision for `/speckit-plan` and is
  not pinned by this spec; the *behavioural* commitment is that
  the recovered visual outcome MUST hold whether Inter is
  available or the system-UI fallback is in effect — neither
  state may produce a fallback visual regression. No proprietary
  brand font is permitted. Dark-mode delivery is out of scope
  for 007 (see Out of Scope §"Multi-theme runtime switching")
  until a future feature explicitly re-opens it.

### Non-Functional Requirements

- **NFR-001 (security boundary preservation)**: This feature MUST
  NOT weaken any security boundary established by `001`
  (`contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, no upward-of-bridge IPC, money-as-integer
  module). Any future implementation slice for 007 MUST preserve
  these.
- **NFR-002 (no PII / credentials / cards in artifacts)**: No log
  line, support bundle, crash report, screenshot, contact sheet,
  or any artifact that may leave the device MUST contain operator
  credentials, session tokens, full PII, raw cardholder data, or
  any credential fragment.
- **NFR-003 (minimum-disclosure error preservation)**: The visual
  recovery MUST preserve the generic error variants A / B / C
  from `004` NFR-003 verbatim. No new variant may distinguish
  among "account does not exist", "wrong credential",
  "tenant / branch mismatch", "account disabled", or
  "rate-limited".
- **NFR-004 (deterministic visual outcome)**: Given a recovered
  token set and a recovered primitive, the rendered visual
  outcome MUST be deterministic and not influenced by client-side
  state (single-light-theme rule per FR-052, viewport, feature
  flag, dev toggle) beyond the documented variants.
- **NFR-005 (touch-target floor)**: The 44 × 44 CSS-pixel touch-
  target floor inherited from `003` NFR-5 / Constitution Hardware
  Matrix MUST hold on every interactive element across every
  existing route after the recovery.
- **NFR-006 (focus-ring visibility)**: Every interactive element
  MUST display a visible focus ring when focused via keyboard.
  The focus ring MUST be drawn by the recovered focus-ring token
  and MUST not be clipped by the surrounding container.
- **NFR-007 (reduced-motion compliance)**: Any motion introduced
  by the recovery (spinner rotation, modal fade-in, rail expand
  transition, tooltip appearance) MUST honour
  `prefers-reduced-motion`. Reduced-motion users MUST observe
  immediate state swaps with no spinner rotation, no fade, no
  rail-expand animation.
- **NFR-008 (a11y baseline)**: The recovered surfaces MUST pass
  the existing axe-rule baseline from `003` NFR-8 with zero
  `serious` or `critical` violations on default / loading /
  empty / error variants of every recovered surface. The
  baseline rule set is inherited unchanged.
- **NFR-009 (visual consistency across reload paths)**: The
  recovered visual outcome MUST hold identically across initial
  paint, hard refresh, route restoration, deep-link navigation,
  and tab restoration. No reload path may produce a transient
  off-palette flash, an unstyled flash of content, or a layout
  shift greater than the documented FOUC budget.
- **NFR-010 (locale-direction safety)**: All recovered layout
  MUST use logical CSS properties (`inline-start` / `inline-end`)
  only. No new layout introduced by 007 may hard-code `left` /
  `right` axes.
- **NFR-011 (no business-logic regression)**: This feature MUST
  NOT modify the existing pairing flow, the existing operator-
  session lifecycle, the OpenAPI snapshot, the local SQLite
  schema, the IPC bridge, the preload surface, the SecretStore,
  or the Sentry / logging configuration. The static no-touch
  source-scope guard inherited from `003` (forbidden allowlist)
  MUST hold.
- **NFR-012 (Windows display scaling)**: The recovered visuals
  MUST render correctly at Windows display scaling 100 % and
  125 % across the two designed viewport bands (≥ 1280 px and
  1024–1279 px). 150 % is **not supported for the pilot**
  (RT-312 D8); beyond the pilot it MAY be supported **only where
  the effective CSS viewport is at least 1024 × 600**, and at
  heights 600–767 only once that compact band is verified on
  pilot hardware. Below 1024 wide or 600 high the width or
  height notice applies instead. No clipped
  characters, no missing focus rings, no off-grid border
  rounding. *Amended 2026-10-15 (Jira RT-312 D15, owner-approved
  2026-10-12): a 1920 × 1080 panel at 150 % yields about
  1280 × 623 CSS px, so "150 % must work" could not hold
  unconditionally. The display/scaling policy is recorded in
  constitution v1.7.0 § Hardware (Display row) and the
  Confluence page "POS display and scaling support policy
  (RT-312)".*
- **NFR-013 (test-first preservation)**: The visual recovery MUST
  preserve the `003` ≥ 90 % coverage gate on `src/renderer/ui/`
  and `src/renderer/shell/`. Any primitive amended by the
  recovery MUST keep its existing test suite green and add
  tests for any new variant introduced.
- **NFR-014 (deferral discipline)**: This feature is the visual
  layer for 005-sales-cart and 006-payments-tender to inherit
  before their UI implementation slices begin. Per Clarifications
  session 2026-05-10, **the UI implementation slices of 005 and
  006 are held until at least 007 Slices S1, S2, and S3 are
  approved**. Non-UI work for 005 / 006 (planning, specification,
  data model, contracts, money-math wiring, audit-attribution
  wiring) MAY proceed in parallel. The 007 slice numbering is
  forward-looking and `/speckit-plan` MUST name S1 / S2 / S3
  explicitly so this gate is auditable.

### Key Entities *(behavioural; not implementation)*

- **Recovered Visual Language** — a single coherent design system
  expressible in one sentence. Carries: semantic palette, spacing
  scale, typography ramp, radius scale, shadow / elevation scale,
  density value, touch-target floor. Replaces the perception of
  "primitive UI" with a deliberate, terminal-first system.
- **Token Table (recovered)** — the canonical mapping of CSS-
  variable names ↔ TypeScript export names ↔ semantic intent. Lives
  under `src/renderer/ui/tokens/` (already exists from `003`); 007
  amends values and may add additive semantic entries.
- **Route Layout Primitive** — a reusable scaffold consumed by
  every route page. Slots: heading, subtitle, body, side-rail,
  action-bar.
- **Recovered Primitive Inventory** — the existing 003 / 004
  primitives (`Button`, `Input`, `Card`, `Table`, `Badge`,
  `Dialog`, `Toast`, `StatusBanner`, `LoadingState`, `EmptyState`,
  `ErrorState`, `OperatorBadge`, `RosterList`, `PinPad`,
  `TakeoverPrompt`) visually upgraded to the recovered language
  *without* changing their public prop signatures.
- **Recovered Shell Chrome** — the existing `AppShell`, `TopBar`,
  `NavRail`, `IdentityStrip`, `ConnectionIndicator`,
  `OperatorSlot`, status / banner region, visually upgraded.
- **Contact Sheet** — the screenshot collection a 007 implementing
  PR attaches as evidence. Carries: per-surface, per-state
  screenshots at the documented viewport bands, plus a reviewer
  sign-off note in the PR description.

## Success Criteria *(mandatory)*

### Measurable Outcomes

Measurable, technology-agnostic outcomes. The feature is "done" when these are
demonstrably true.

- **SC-001 (one-sentence visual language)**: A reviewer can describe the
  recovered visual language in one sentence ("calm, terminal-first, high-
  contrast, touch-comfortable in two or three accents") and a second
  reviewer arrives at substantially the same description without
  prompting. Confirmed in a structured review of all existing routes.
- **SC-002 (cross-route consistency)**: In a structured walkthrough of
  every existing route at the 1280 × 800 viewport, zero routes drift in
  color, spacing, typography, radius, or shadow tokens from any other
  route.
- **SC-003 (touch-target compliance)**: Every interactive element across
  every existing route meets the 44 × 44 CSS-pixel floor; no element
  fails the rect measurement inherited from `003` NFR-5.
- **SC-004 (focus-ring visibility)**: A reviewer keyboards through every
  existing route and observes a visible, consistent focus ring on every
  interactive element, with zero clipped or missing rings.
- **SC-005 (shared-primitive consumption)**: A spot audit of every
  existing route's source confirms that every visible button, input,
  card, modal, alert, loading state, empty state, and error state is
  sourced from the shared inventory; zero one-off CSS-only buttons,
  inline `<input>`s, or one-off card surfaces remain.
- **SC-006 (Slice 0 contact-sheet match)**: The recovered cashier sign-
  in surface, manager / admin sign-in surface, and takeover-prompt
  modal match the `004` Slice 0 contact sheet within the §7 pixel-
  diff thresholds (≤ 0.5 % for layout-stable surfaces, ≤ 1.5 % for
  surfaces containing animated regions).
- **SC-007 (forbidden-string assertions hold)**: A render-time DOM
  assertion confirms that the takeover prompt's subtree contains
  zero occurrences of the `004` FR-013 forbidden strings (terminal-A
  label, prior-session timestamp, other-operator name / role,
  "View details" / "Why am I seeing this" / "Show details").
- **SC-008 (no new tokens / no new states leaked into runtime)**:
  A diff scan of the implementing PR(s) shows zero new
  connection-state values, zero new density values applied at
  runtime, and any new design tokens are additive and documented
  in the recovered token table.
- **SC-009 (no security regression)**: A static no-touch source-
  scope guard scan of the implementing PR(s) shows zero diff
  lines under the forbidden allowlist (`src/preload/**`,
  `src/main/ipc/**`, `src/main/pairing/**`, `src/main/secrets/**`,
  `src/shared/bridge-api.ts`, `src/shared/api-types.ts`,
  `migrations/**`, `scripts/codegen-api.ts`,
  `scripts/openapi-snapshot.json`, `.github/workflows/**`,
  `_reference/**`).
- **SC-010 (cashier-visibility preservation)**: In a structured
  walkthrough as a cashier, every Cashier-Forbidden Information
  catalogue item from `004` FR-015 remains absent from every
  cashier-reachable route after the recovery. Zero items leak.
- **SC-011 (small-PR discipline)**: Every visual-recovery
  implementing PR carries a single recovery slice scope; no PR
  merges that bundles broad redesign with unrelated behavioural
  changes. Tracked across at least three consecutive recovery
  slices.
- **SC-012 (contact-sheet adoption)**: Every visual-recovery
  implementing PR attaches a screenshot contact sheet and
  records a reviewer sign-off note in the PR description.
  Tracked across at least three consecutive recovery slices.
- **SC-013 (no implementation drift in this spec)**: Acceptance
  review of the 007 spec confirms that this feature contributes
  zero source files, zero migrations, zero OpenAPI changes,
  zero IPC channels, and zero new packages. The spec's sole
  artifacts are `specs/007-pos-visual-system/spec.md` and its
  checklist.

## Out of Scope *(this feature)*

The following are explicitly out of scope for **007-pos-visual-system**
and MUST NOT be introduced by this feature's spec, plan, tasks, or
implementation slices. They are deferred to later features.

- Implementation of any kind by *this spec*. Source files, IPC,
  preload changes, main-process changes are produced by 007's later
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement` cycle, not
  by this specification phase.
- Sales, cart, line-item, or basket business logic. Owned by `005`.
- Payment, tender, or money-math logic of any kind. Owned by `006-payments-tender`.
- Receipt printing, receipt rendering, or receipt content rules.
- Inventory mutation, stock movement, batch / lot or FEFO logic.
- Reports, KPIs, dashboards, analytics surfaces.
- Backend / API implementation, OpenAPI changes, OpenAPI snapshot
  changes.
- Database migrations, schema changes, `better-sqlite3` schema
  alterations.
- Clerk authentication behaviour changes; operator-session lifecycle
  changes.
- Terminal-pairing flow / copy / banner / error-state changes
  (visual upgrade is in scope per FR-022, but flow / copy / banner
  semantics are owned by `002`).
- Direct copy-paste of Claude Design / Figma / Figma Make mock
  HTML / JSX into production code (FR-034 / FR-035).
- New IPC channels, new preload-bridge surfaces, new `SecretStore`
  keys, new `safeStorage` callers.
- Auto-update wiring, packaging, distribution.
- `_reference/Data-Pulse/` ("Data-Pulse-2") changes of any kind.
- Mobile-first navigation / hamburger drawer / bottom-tab bar at
  any viewport width.
- Runtime density toggle / settings UI for density.
- New connection-state values; the four-state model from `003`
  remains the entire surface.
- Localisation (string catalogue, RTL build) — layout direction-
  safety is preserved (NFR-010), but no RTL build is delivered
  here.
- Multi-theme runtime switching — **explicitly excluded** by
  Clarifications session 2026-05-10 / FR-052. 007 delivers a
  single polished light theme; the recovered surfaces MUST NOT
  respond to OS-level `prefers-color-scheme` preferences, and
  no light / dark theme toggle, no system-theme follower, and
  no per-tenant theme is exposed in the running app. Dark-mode
  delivery is deferred to a later, explicitly-approved feature.
- Proprietary brand fonts whose absence on the target Windows
  hardware would cause a fallback visual regression — forbidden
  by FR-052. Inter (where installable) and system-UI fallback
  are the only typography families permitted by 007.

## Assumptions

- **A1 (existing primitives are upgraded, not replaced)**: 003 / 004
  shipped a full primitive inventory (`Button`, `Input`, `Card`,
  `Table`, `Badge`, `Dialog`, `Toast`, `StatusBanner`,
  `LoadingState`, `EmptyState`, `ErrorState`, `OperatorBadge`,
  `RosterList`, `PinPad`, `TakeoverPrompt`). 007 visually upgrades
  these primitives in place rather than introducing a parallel
  inventory; their public prop signatures remain stable.
- **A2 (route inventory is the existing inventory)**: the routes
  in scope for the recovery are exactly the routes shipped by
  001 / 002 / 003 / 004: pairing, paired confirmation, sign-in
  (cashier and manager / admin), dashboard, sales placeholder,
  cart placeholder, receipt / checkout placeholder (with `005`
  reserved slots intact), inventory placeholder, settings / help
  placeholder. 007 does not introduce new routes.
- **A3 (canonical reference set — resolved 2026-05-10)**: A
  search of the repository working tree at specify-phase time
  found zero files matching `*claude-design*`, `*claudedesign*`,
  `*figma-mock*`, or `*prototype*` outside the gitignored
  `_reference/` and outside the planning artifacts in
  `specs/003-pos-ui-shell/` and
  `specs/004-operator-session/visual-direction/`. The Clarifications
  session of 2026-05-10 then resolved the canonical reference
  set as the priority-ordered list captured in FR-051:
  (1) Claude Design output once exported / linked by the product
  owner; (2) Figma Make output when product-owner-approved; and
  (3) the three repo references —
  `specs/004-operator-session/visual-direction/README.md`,
  `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`,
  and `specs/003-pos-ui-shell/contracts/` — which remain binding
  constraints overriding (1) and (2) on disagreement. External
  references are visual references only; FR-034 / FR-035 forbid
  copy-paste of mock HTML / JSX into production code.
- **A4 (highest-priority screens are the operator surfaces and
  shell chrome)**: in the absence of explicit product
  prioritisation, this spec assumes the operator-session
  screens (cashier sign-in, manager / admin sign-in,
  takeover-prompt) and the shell chrome (top bar, rail,
  operator badge, status / banner region) are the highest-
  priority surfaces for visual recovery, because they are
  the surfaces the cashier looks at every shift and the
  surfaces 005 / 006 inherit before their own UI work. Final
  priority order is set during `/speckit-clarify` (and by
  the visual-direction reviewer during the 007 plan phase).
- **A5 (mandatory acceptance widths)**: this spec assumes the
  mandatory acceptance widths for the recovery are the two
  designed viewport bands inherited from `003`: ≥ 1280 px
  (primary) and 1024 × 768 (icon-only sample), at Windows
  display scaling 100 / 125 / 150 % (150 % only as NFR-012
  allows). Below 1024 px the
  "screen too small" fallback from `003` is preserved
  unchanged. Final width matrix is confirmed during
  `/speckit-clarify`.
- **A6 (existing 003 token values are the starting point)**:
  this spec assumes `003`'s already-shipped color, spacing,
  typography, radius, shadow, density, and touch-target
  values are the starting point for the recovery. The
  recovery may amend specific values (lifting contrast,
  refining a palette accent, retuning a shadow elevation),
  but the spec does NOT assume a wholesale token replacement.
  The exact set of value changes is the visual-direction
  reviewer's call during the 007 plan phase, constrained by
  FR-003 (no silent rename / repurpose / removal of an
  existing 003 token).
- **A7 (workflow lesson inherited)**: per `004` FR-033 / FR-034 /
  FR-035, every UI-bearing feature schedules an early-visual-
  direction milestone between `/speckit-plan` and the first
  implementation slice, and every UI implementation slice
  attaches a screenshot contact sheet. 007 inherits both
  rules and applies them to itself: 007's plan phase produces
  a contact sheet of its own (the canonical 007 visual
  direction), and every 007 implementation slice attaches a
  screenshot contact sheet for the surfaces it touches.
- **A8 (test toolchain inheritance)**: Vitest, Testing Library,
  axe-core via `expectNoAxeViolations` are inherited from
  `001` / `003`; 007 does not introduce a new test framework.
- **A9 (Constitution alignment)**: 007 is constrained by
  Constitution Principles I (offline-first), III (process-
  boundary discipline), V (type safety), VI (test-first), VII
  (observability), VIII (terminal identity ≠ user identity),
  IX (reference, not inheritance — load-bearing here), and
  the Hardware Matrix (touchscreen 44 × 44 px floor). 007 does
  NOT alter these.
- **A10 (font policy — resolved 2026-05-10)**: Typography uses
  Inter as the primary font family, with system-UI as the
  fallback when Inter is unavailable on the target Windows 10 /
  11 terminal. No proprietary brand font is introduced. The
  font-family token in the recovered token table MUST resolve
  to a chain whose first entry is Inter and whose final
  fallback is `system-ui` / `sans-serif`. The Inter delivery
  mechanism (bundled webfont, ship-with-installer, OS
  pre-install, or other) is a `/speckit-plan` decision; the
  spec only fixes the behavioural commitment that the recovered
  visual outcome MUST hold under either Inter or the system-UI
  fallback. Confirmed by Clarifications session 2026-05-10;
  codified in FR-052.

## Dependencies

- **001-foundation** — Electron substrate, Vitest, ESLint /
  Prettier, the local SQLite migration runner, the secrets
  module, and the Money type. 007 consumes them unchanged.
- **002-terminal-pairing** — pairing screens (in scope for
  visual upgrade per FR-022), pairing flow / copy / security
  (out of scope per Out-of-Scope §"Terminal-pairing flow /
  copy / banner / error-state changes").
- **003-pos-ui-shell** — design tokens (`src/renderer/ui/tokens/`),
  shared primitive inventory (`src/renderer/ui/primitives/`),
  shell chrome (`src/renderer/shell/`), responsive viewport
  matrix, the four connection-state values, the route
  placeholders. 007 inherits all of these and visually
  upgrades them in place.
- **004-operator-session** — operator-session boundary,
  cashier-forbidden information catalogue, generic minimum-
  disclosure error variants A / B / C, `OperatorBadge`,
  `RosterList`, `ManagerAdminSignInForm`, `PinPad`,
  `TakeoverPrompt`, FR-033 / FR-034 / FR-035 workflow lesson.
  007 inherits all of these and visually upgrades them in
  place.
- **`_reference/Data-Pulse/`** (gitignored, read-only) —
  Constitution Principle IX explicitly forbids inheritance
  from this directory. 007 MUST NOT copy-paste from it
  (FR-048).
- **External design references (priority-ordered, per
  Clarifications session 2026-05-10 / FR-051)** — (1) Claude
  Design output once exported / linked by the product owner;
  (2) Figma Make output when approved by the product owner;
  (3) the three repo references —
  `specs/004-operator-session/visual-direction/README.md`,
  `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`,
  `specs/003-pos-ui-shell/contracts/` — which remain binding
  constraints overriding (1) and (2) on disagreement
  (Constitution Principle IX). External references are visual
  references only; FR-034 / FR-035 forbid copy-paste of mock
  HTML / JSX into production code.
- **Forward dependency: 005-sales-cart** (already specified
  per `specs/005-sales-cart/`) — **its UI implementation
  slices wait until at least 007 Slices S1, S2, and S3 are
  approved** (Clarifications session 2026-05-10). Non-UI work
  for 005 (cart data model, line-item / sale entity contracts,
  backend / IPC integration, money-math wiring) MAY proceed in
  parallel.
- **Forward dependency: 006-payments-tender** (already
  specified per `specs/006-payments-tender/`) — **its UI
  implementation slices wait until at least 007 Slices S1, S2,
  and S3 are approved** (Clarifications session 2026-05-10).
  Non-UI work for 006 (payment / tender data model, `Money`
  type wiring, audit-attribution wiring, card-terminal contract
  if any) MAY proceed in parallel.

## Open Questions / NEEDS CLARIFICATION

All three NEEDS CLARIFICATION markers raised by the specify phase were
resolved on 2026-05-10 (see §"Clarifications session 2026-05-10"). They
are recorded here as resolved decisions for traceability.

1. ✅ **Resolved 2026-05-10** — Canonical visual reference set: Claude
   Design output once exported / linked by the product owner (priority
   1); Figma Make output when product-owner-approved (priority 2); the
   three repo references at `specs/004-operator-session/visual-direction/README.md`,
   `specs/004-operator-session/planning/ui-pinpad-takeover-visual-direction.md`,
   and `specs/003-pos-ui-shell/contracts/` are binding constraints that
   override (1) and (2) on disagreement. External references are visual
   references only — never production source. Codified in FR-051; see
   Clarifications session 2026-05-10 and Dependencies §"External design
   references".

2. ✅ **Resolved 2026-05-10** — 005 / 006 blocking scope: 007 blocks
   **the UI implementation slices** of `005-sales-cart` and
   `006-payments-tender`. UI implementation waits until at least
   **007 Slices S1, S2, and S3** are approved. Non-UI planning,
   specification, contract design, data-model work, money-math
   wiring, and audit-attribution wiring for 005 / 006 MAY continue in
   parallel. See Clarifications session 2026-05-10, Dependencies
   §"Forward dependency: 005-sales-cart" and §"Forward dependency:
   006-payments-tender", and NFR-014.

3. ✅ **Resolved 2026-05-10** — Theme count and font policy: one
   polished light theme only for now; dark mode is out of scope for
   007 unless explicitly approved later. Typography uses Inter as
   the primary font family, with system-UI as the fallback when
   Inter is unavailable on the target Windows 10 / 11 terminal; no
   proprietary brand fonts. Codified in FR-052 and Assumption A10;
   see Clarifications session 2026-05-10, Out-of-Scope §"Multi-theme
   runtime switching", and Edge Case §"Dark-mode preference of the
   OS".

(The original brief also listed three further questions —
"highest-priority screens", "mandatory acceptance widths", and
"existing 003 colours acceptable or replaced" — resolved as
assumptions A4, A5, A6 respectively. They did not consume NEEDS
CLARIFICATION slots and may be revisited during a future
`/speckit-clarify` without amending this spec.)

**All three NEEDS CLARIFICATION markers are now resolved.** This spec
is ready for `/speckit-plan`.

## Constitutional Alignment

Each principle below either constrains 007 directly or is preserved by
007's behaviour. Informational for `/speckit-plan` and the Constitution
Check.

- **P3 (process-boundary discipline)** — NFR-001 / NFR-011 / FR-050
  (renderer-only by default; static no-touch source-scope guard
  inherited from `003`).
- **P4 (auditability)** — preserved unchanged; 007 introduces no new
  audit surface.
- **P6 (no raw cardholder data by default)** — NFR-002.
- **P7 (secrets never reach renderer or logs)** — FR-036 / FR-037 /
  FR-038 / NFR-002.
- **P8 (Electron security boundary)** — NFR-001 / FR-050.
- **P10 (operator accountability)** — preserved unchanged; the
  visual recovery does NOT alter operator-session attribution.
- **P11 (supportability without secret leakage)** — FR-038 / NFR-002.
- **P12 (Spec Kit artifacts are source of truth)** — FR-034 /
  FR-035 (external references are reference-only; the repo and
  approved Spec Kit artifacts win disagreements).
- **P13 (small, scoped implementation PRs)** — FR-032 / SC-011.
- **P14 (accessibility & cashier ergonomics)** — FR-006 / NFR-005 /
  NFR-006 / NFR-007 / NFR-008.
- **P16 (feature scope discipline)** — Out-of-Scope section is
  the explicit scope bound for 007.
- **P17 (privacy and tenant isolation)** — FR-039.
- **Principle IX (Reference, Not Inheritance)** — load-bearing
  for this feature: external design references are translated
  into repo-native artifacts (FR-034 / FR-035), and direct copy-
  paste of mock HTML / JSX is forbidden.

---

**End of specification.** Clarify phase complete (session 2026-05-10).
Next phase: `/speckit-plan`. The plan phase MUST schedule an
early-visual-direction milestone per `004` FR-033; because 007 *is* a
visual-direction feature, that milestone IS the plan-phase contact
sheet itself. The plan MUST also name Slices S1, S2, and S3 explicitly
so the 005 / 006 UI-implementation gate from Clarifications session
2026-05-10 / NFR-014 / Dependencies is auditable.
