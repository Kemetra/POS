# Feature Specification: POS UI v4.0 — Rescue / Visual Convergence

**Feature ID:** 022-pos-ui-v4-rescue
**Status:** Draft
**Created:** 2026-09-18
**Last Updated:** 2026-09-18
**Owner:** Product owner (Ahmed Shaaban)

---

## Overview

POS-Pulse's cashier surfaces were built feature-by-feature (003 → 011) and most recently converged
onto the POS v3.5 prototype. The result is functionally sound but visually inconsistent: the
sale-success surface is English-only on an Arabic-first product, Arabic text renders through
uncontrolled OS font fallback, and the visual language differs between sign-in, cart, tender and
completion. This feature specifies **POS UI v4.0** — a deliberate visual convergence onto a light,
clinical, pharmacy-teal design direction approved by the owner — so the terminal reads as one
coherent, high-throughput cashier tool.

This is a **visual and UX** feature. It exposes existing behaviour more clearly; it does not add,
remove, or alter any business capability — with one narrow, explicitly-scoped exception: the
role-aware `/app` landing correction recorded in FR-44 (see *Clarifications*, Decision 1).

---

## Clarifications

### Session 2026-09-18

> **Provenance:** both decisions below were **supplied by the owner with the clarify request** as
> already-resolved determinations; they were not agent-generated clarification questions. The
> single Open Question carried from SPECIFY (cashier landing route) is closed by Decision 1. The
> SPECIFY-phase decisions A–F (light-first default, pharmacy-teal primary, v4.0 supersedes v3.5
> visually, screenshot acceptance, no mandatory automated harness, references do not authorise
> functionality, Egypt/product truth over mock imagery) are **not reopened**.

- Q: A signed-in `cashier` landing on `/app` is redirected to `dashboard`, where `DashboardRoute`
  rejects the `cashier` role with "Section unavailable" — an error state as the first screen of a
  shift. Is a routing correction in scope, given the behaviour-preservation requirement?
  → A: **Yes — a narrow, explicit exception is granted.** The `/app` index target becomes
  role-aware: `cashier` → `/app/cart`; `manager` / `admin` continue to `/app/dashboard`. This is a
  UX/navigation correction only. It MUST NOT change feature-flag defaults, activate any gated
  capability, alter cashier authorization, bypass `OperatorRouteGuard`, change payment/cart
  business logic, or create a new cashier capability. Recorded as **FR-44**, with **FR-40** amended
  to name the exception so the blanket preservation rule does not contradict it. The change is
  scoped to the `/app` **index route** (`src/renderer/router.tsx:175`) — **not** to
  `DashboardRoute`'s role check (`src/renderer/routes/app/DashboardRoute.tsx:16-24`), which
  remains exactly as-is. Assigned to slice **U1**.
- Q: The five approved v4.0 reference images live outside the repository. Should they become
  traceable in-repo artifacts? → A: **Yes.** They are vendored under
  `specs/022-pos-ui-v4-rescue/visual-references/` under stable descriptive names, re-encoded
  losslessly (PNG, `optimize=True`, no resize, no mode change, pixel-identity verified) so their
  visual meaning is unchanged. They are visual authority only — hierarchy, colour direction,
  layout, spacing, typography direction, component treatment, visual density — and remain
  **non-authoritative for product capability** (see *Non-Capability Inventory*). Recorded in
  *Visual-Reference Authority*; Assumption **A1** updated accordingly.

---

## Visual-Reference Authority

The five owner-approved reference images (supplied 2026-09-18) are vendored in this feature
directory as the **approved v4.0 reference set**, under
[`visual-references/`](./visual-references/):

| # | File | Reference | Establishes |
|:--|:--|:--|:--|
| 1 | [`01-visual-system.png`](./visual-references/01-visual-system.png) | Design-system sheet | Palette, typography scale, status chips, button hierarchy, component styling |
| 2 | [`02-sign-in.png`](./visual-references/02-sign-in.png) | Sign-in / shift-start | Sign-in composition, roster + PIN pad layout, terminal-identity presentation |
| 3 | [`03-sale-workspace.png`](./visual-references/03-sale-workspace.png) | Sale workspace / cart | Two-region sale layout, cart table density, totals block, primary-action placement |
| 4 | [`04-checkout-tender.png`](./visual-references/04-checkout-tender.png) | Checkout / tender | Tender-selection grid, amount entry, due/received/remaining hierarchy |
| 5 | [`05-sale-success.png`](./visual-references/05-sale-success.png) | Sale-success / receipt | Completion state, receipt presentation, next-action affordances |

Each file is a lossless PNG re-encode of the owner-supplied original — identical pixels, dimensions
(1448 × 1086) and colour mode, verified after encoding — so comparison against them is faithful.

**Authority is visual only.** These images govern hierarchy, density, colour, typography, spacing,
shell/navigation direction, cart layout, payment layout, completion presentation, component styling
and status treatment. They do **not** authorise product capability.

> ⚠️ **Reading these files:** every image contains capabilities POS-Pulse does not have — most
> visibly a 15% VAT line, Saudi Riyal amounts, loyalty points, a registered customer, and unsupported
> tender types. Before treating anything in an image as a requirement, check it against the
> **Non-Capability Inventory** below. The images are the visual direction, never the feature list.

### Supplementary design handoff (vendored 2026-09-20)

The owner-approved **Claude Design handoff bundle** is vendored at
[`design-handoff/`](./design-handoff/). It is **richer packaging of this same approved design** —
the HTML mockup the five reference images were captured from, plus the designer's written
per-screen spec and token list.

Its five reference PNGs are **pixel-identical** to `visual-references/` above, so they are
deliberately **not** duplicated. ⚠️ The handoff's own filenames are **shuffled**; the
`visual-references/` filenames here are authoritative and MUST NOT be renamed to match it. The
verified mapping is recorded in
[`design-handoff/RECONCILIATION.md`](./design-handoff/RECONCILIATION.md) §D.

**Authority is visual only — the same rule as the reference images.** The bundle is authored for a
Saudi pharmacy and contains ZATCA fiscal behaviour, 15% VAT, Saudi Riyal, the mada network and
three unsupported tenders. None of it is authorised. Read
[`RECONCILIATION.md`](./design-handoff/RECONCILIATION.md) before using anything in that directory:
§A authority split · §B non-capabilities · §C accessibility/token rule · §D reference mapping ·
§E responsive rule.

The Returns and Shift-Close screens are vendored as **forward visual references for `specs/014` and
`specs/015` only**. Neither is in 022 scope.

### Relationship to historical POS v3.5

POS v3.5 (`docs/design/pos-v3.5/**`, shipped via PRs #422–#438) is **real, recent, working
implementation context** — not abandoned code. It remains the authority for *structure, component
inventory, copy patterns and honesty behaviour* that v4.0 does not explicitly supersede.

v4.0 supersedes v3.5 on exactly three visual axes:

| Axis | v3.5 (superseded) | v4.0 (governing) | Evidence of the v3.5 position |
|:--|:--|:--|:--|
| Theme default | Dark default, light toggle | **Light default** | `docs/design/pos-v3.5/README.md:64`; `docs/design/pos-v3.5/CLAUDE.md`; `index.html` `data-theme="dark"` |
| Primary colour | Navy `#1f4e7a` primary | **Pharmacy green-teal primary** | `README.md:202` token table |
| Accent rule | "teal … never a fill" (One-Accent Rule) | **Teal may fill large primary actions** | `README.md:59` |

Navy is retained for primary text, structure, high-contrast information and secondary hierarchy.

**Hue note (material):** the existing `--color-accent` `#2e7da3` is a *blue-cyan*; the v4.0 primary
is a *green pharmacy teal*. These are different hue families — v4.0 is not a re-use of the existing
accent token value.

**Documentation-authority reconciliation is required follow-up, NOT part of this feature.**
`docs/design/pos-v3.5/CLAUDE.md` is a directory-scoped agent-instruction file asserting
"dark theme is the default" and the One-Accent Rule; once v4.0 governs, it misinstructs any agent
working in that directory. Per owner Decision A, historical v3.5 documents MUST NOT be mass-edited
during SPECIFY. Reconciling them is scheduled work for a later phase of this feature.

**No ADR document exists to supersede.** "ADR-0004" appears only in source comments and a test name
(`src/renderer/styles/__tests__/theme-contract.test.ts`); a repository-wide search for ADR files
returned none.

### Non-Capability Inventory

Everything below appears in a reference image and is classified
**VISUAL REFERENCE ONLY — NOT CURRENT PRODUCT CAPABILITY**. None may be implemented by this feature.

| Shown in reference | Product truth |
|:--|:--|
| 15% VAT line | VAT deferred to spec 012; 008 hardcodes tax 0. Cart already renders an honest `—` / `tax-pending` placeholder (`CartPane.tsx:611-620`; register D-007) |
| Saudi Riyal, Riyadh, fictional pharmacies | Product is Egyptian; v3.5 names 14% VAT and tenant "Rahma Qanater" |
| mada / credit / insurance / digital wallet / gift-card tenders | Only `cash`, `external_card_terminal`, `internal_voucher` exist (`TenderSelection.tsx:26`). Prototype insurance/credit were explicitly rejected (register D-009) |
| ~~Split / multi-tender payment rows~~ | **CORRECTED 2026-09-18 — this IS a current capability and is NOT a Non-Capability item.** 006 T154 ships split tender: `PaymentSurface.handleLineApplied` returns the cashier to tender selection while the applied-line sum is below the subtotal (`src/renderer/ui/payments/PaymentSurface.tsx:282-313`). It MUST be preserved (FR-40), not rejected. The reference images' *unsupported* tender **types** (mada, insurance, credit, wallet, gift card) remain non-capability — see the row above |
| Loyalty points, customer CRM, registered-customer records | Not current capabilities |
| Prescription (Rx) workflow | Display-only badge; enforcement out of scope (register D-005) |
| SMS / WhatsApp / email receipt dispatch | No receipt delivery channel exists |
| Today's-KPI tiles (sales count / totals / averages) | Dashboard is an honest skeleton; demo data is dev-only (register D-010). Fabricating these violates P2/P9 |
| Confetti / celebration treatment on success | Decorative; conflicts with the terminal-not-showcase goal |
| Shift-start summary and "start shift" action | Open-shift removed from Slice 1 → Slice 12 (register D-003); not current capability |
| Discount codes / unsupported discounts | Not a current capability |
| "Retail Tower POS" branding, marketing hero imagery, taglines | Not POS-Pulse identity; marketing chrome is prohibited in the working terminal |

---

## User Scenarios & Testing

### Primary User Story

A pharmacy cashier begins a shift on a Windows desktop terminal. They sign in, and the terminal
presents a light, calm, Arabic-first workspace whose primary action is unmistakable at a glance.
They scan or search a product, confirm it into the cart, and read the running total without
hunting for it. They move to payment, choose a supported tender, and settle it. The terminal shows
a clear, Arabic-first completion state that tells them truthfully that the sale is recorded, shows
the receipt information the system actually holds, and offers one obvious way to begin the next
sale. Across every one of those surfaces the typography, spacing, colour and control styling are
the same system — nothing reads as a different product, and nothing on screen claims more than the
system knows.

### Acceptance Scenarios

1. **Coherent journey**
   - **Given** a cashier signed in on a terminal with the cashier journey reachable
   - **When** they traverse sign-in → sale workspace → cart → checkout → tender → completion
   - **Then** every surface renders from the shared v4.0 token set, and each surface presents
     exactly one primary-action treatment

2. **Light-first default**
   - **Given** a terminal started with no stored theme preference
   - **When** the application first paints
   - **Then** the light v4.0 theme is active, and no surface requires dark presentation to be legible

3. **Arabic-first completion (U4a)**
   - **Given** a payment that the system has confirmed as settled
   - **When** the completion surface renders
   - **Then** its operator-facing strings lead with Arabic, the settled amount is presented with the
     strongest numeric weight on the surface, and the receipt information the system holds is shown

4. **Truthful success**
   - **Given** a payment whose settlement has not been confirmed by the main process
   - **When** the completion surface is reached
   - **Then** no element asserts that the sale is complete

5. **Honest gated surface**
   - **Given** a cashier surface whose feature flag is off
   - **When** the cashier navigates to it
   - **Then** the surface states plainly that the capability is unavailable, styled in the v4.0
     system, and does not present a disabled lookalike of the working surface

6. **Keyboard-only transaction**
   - **Given** a cashier using only the keyboard
   - **When** they traverse the cashier journey
   - **Then** every interactive control is reachable in a logical RTL order with a visible focus
     indicator, and no step requires a pointer

7. **Money and identifier direction**
   - **Given** any surface showing money, barcodes, SKUs or sale numbers
   - **When** it renders inside the RTL composition
   - **Then** those values read left-to-right without reordering, while surrounding Arabic text
     remains right-to-left

8. **Destructive separation**
   - **Given** a surface offering a destructive action (void, clear, remove line)
   - **When** it renders
   - **Then** that action is visually separated from the primary action and does not carry the
     primary-action treatment

9. **Cashier lands on the till, not an error**
   - **Given** an operator signed in with the `cashier` role
   - **When** they arrive at `/app` after sign-in
   - **Then** the first surface rendered is the sale/cart surface — or, where the cart feature is
     gated off, that surface's honest gated state — and never a role-rejection error

10. **Role rejection still applies on direct navigation**
    - **Given** a signed-in `cashier`
    - **When** they navigate directly to `/app/dashboard`
    - **Then** the existing role-rejection state is still shown, unchanged by FR-44

### Edge Cases

- **Empty cart** — the sale surface states the cart is empty in Arabic and keeps the scan/search
  affordance prominent; the payment action is unavailable and visibly so.
- **Backend unreachable / offline** — connection state is a persistent banner (never a toast) and
  the cashier is not blocked from surfaces that work offline.
- **Payment refusal** — the refusal is presented as text plus non-colour indicator, states what the
  cashier can do next, and does not clear entered amounts without telling the cashier.
- **Receipt/print failure** — the existing failure banner remains visible and persistent; completion
  does not claim the receipt printed.
- **Catalogue empty or unavailable** — the surface distinguishes "no catalogue data yet" from "search
  found nothing", per existing 009/010 states.
- **Validation error on amount entry** — the invalid field is identified by text, not colour alone,
  and focus moves to it.
- **Screen below the supported width** — the existing too-small surface renders in the v4.0 system.
- **Cashier reaches a role-restricted surface** — an honest "unavailable for your role" state, not a
  blank or broken screen.

---

## Requirements

### Functional Requirements

**Visual foundation (U0)**

- **FR-1.** The terminal MUST default to the light v4.0 theme when no stored theme preference exists.
- **FR-2.** A dark presentation MAY remain available; no v4.0 surface may depend on dark presentation
  to meet its contrast or hierarchy requirements.
- **FR-3.** The v4.0 primary operational colour MUST be a green pharmacy teal, distinct in hue from
  the existing blue-cyan accent value.
- **FR-4.** Large primary transaction actions MUST be permitted to use a filled pharmacy-teal
  treatment, superseding the v3.5 rule that teal is never a fill.
- **FR-5.** Navy MUST remain the treatment for primary text, structural elements and high-contrast
  information.
- **FR-6.** Orange MUST be reserved for warning states and red for destructive or error states; neither
  may be used decoratively.
- **FR-7.** Blue MAY be used for informational and selection states only.
- **FR-8.** Every colour, spacing, radius, typographic and elevation value used by a cashier surface
  MUST resolve through the shared token layer; no surface may hardcode a raw value.
- **FR-9.** Surface separation MUST be achieved primarily with borders and spacing rather than shadow
  stacking or elevation effects.

**Typography**

- **FR-10.** Arabic operator text MUST render through an intentionally selected typeface rather than
  undeclared OS fallback. (Package selection is deliberately deferred past SPECIFY.)
- **FR-11.** A single typographic scale MUST serve labels, dense transactional tables, and large
  totals across all cashier surfaces.
- **FR-12.** Money values MUST render in a tabular/monospaced numeric treatment so digits align
  vertically in cart and payment tables.
- **FR-13.** Mixed Arabic/Latin strings MUST render without visual reordering of the Latin segment.

**Hierarchy and density**

- **FR-14.** Each cashier surface MUST present exactly one primary-action treatment.
- **FR-15.** The cart's line items and the running total MUST be the visually dominant elements of the
  sale workspace.
- **FR-16.** The amount due MUST be the strongest numeric element on the checkout surface, and the
  settled amount the strongest on the completion surface.
- **FR-17.** Destructive actions MUST be visually separated from the primary action and MUST NOT carry
  the primary treatment.
- **FR-18.** Secondary and metadata text MUST be quieter than transactional content while still meeting
  the contrast requirement in NFR-3.

**RTL / Arabic-first**

- **FR-19.** Every operator-facing string on the cashier journey MUST lead with Arabic.
- **FR-20.** Cashier surfaces MUST compose right-to-left, including table column order and the reading
  order of paired label/value rows.
- **FR-21.** Money values, barcodes, SKUs, sale numbers and payment references MUST be
  direction-isolated left-to-right within the RTL composition.
- **FR-22.** Directional icons MUST point consistently with RTL reading direction.
- **FR-23.** Keyboard focus traversal order MUST follow the RTL visual order.

**States (U5)**

- **FR-24.** Empty, loading, error, offline and gated states MUST each render in the v4.0 system and
  MUST state what is true rather than presenting an inert copy of the working surface.
- **FR-25.** Operational connection state MUST be presented as a persistent banner, never a toast.
- **FR-26.** No critical state may be communicated by colour alone; each MUST carry text or a
  non-colour indicator.
- **FR-27.** A gated (flag-off) surface MUST be distinguishable by the cashier from a failed surface.

**Completion (U4 / U4a)**

- **FR-28.** The sale-completion surface MUST present its operator-facing content Arabic-first.
- **FR-29.** The completion surface MUST present the receipt information the system already holds for
  the completed sale.
- **FR-30.** The completion surface MUST retain the existing "new sale" behaviour as its primary
  next action.
- **FR-31.** The completion surface MUST NOT assert success unless the underlying settlement has been
  confirmed by the main process (see NFR-6).
- **FR-32.** The completion surface MUST NOT offer any receipt delivery channel that the system does
  not implement.

**Anti-patterns (prohibitions)**

- **FR-33.** Cashier surfaces MUST NOT nest a card inside a card without operational value.
- **FR-34.** Cashier surfaces MUST NOT present decorative gradients, glow effects, or shadow stacking.
- **FR-35.** Cashier surfaces MUST NOT present marketing hero imagery, taglines, or brand-promotional
  content.
- **FR-36.** Cashier surfaces MUST NOT present decorative icon tiles that carry no operational meaning.
- **FR-37.** No surface may display a numeric business value that is not sourced from a
  system-computed field; placeholder or illustrative figures are prohibited.
- **FR-38.** Cashier surfaces MUST NOT present more than one competing primary button.
- **FR-39.** Animation MUST be limited to state-change feedback and MUST honour reduced-motion
  preferences.

**Preservation**

- **FR-40.** This feature MUST NOT alter payment FSM behaviour, tender rules, money math,
  sale-finalization semantics, durability, sync semantics, operator-auth authority, pairing authority,
  backend contracts, migrations, or fiscal rules. **Sole exception:** the role-aware `/app` landing
  correction specified in FR-44, which is a navigation change only and alters none of the above.
- **FR-41.** This feature MUST NOT change production feature-flag defaults.
- **FR-42.** This feature MUST NOT introduce a capability listed in the Non-Capability Inventory.
- **FR-43.** Where a surface is gated, this feature MUST restyle it without ungating it.

**Cashier landing route (U1 — narrow exception to FR-40)**

- **FR-44.** The `/app` index route MUST resolve its redirect target by operator role: a signed-in
  `cashier` MUST land on the sale/cart surface (`/app/cart`); `manager` and `admin` MUST continue to
  land on `/app/dashboard`. No signed-in role may land on a surface that rejects that role.
- **FR-45.** FR-44 MUST be implemented at the `/app` index redirect
  (`src/renderer/router.tsx:175`). It MUST NOT modify `DashboardRoute`'s role check
  (`src/renderer/routes/app/DashboardRoute.tsx:16-24`): a cashier who *navigates* to
  `/app/dashboard` MUST still receive the existing role-rejection state. Only the **default landing
  target** changes.
- **FR-46.** FR-44 MUST NOT change feature-flag defaults, activate or ungate any capability, alter
  cashier authorization, bypass or weaken `OperatorRouteGuard`, change cart or payment business
  logic, or create a new cashier capability. Where the cart feature is gated off, landing on
  `/app/cart` MUST present the existing honest gated state — which is the intended outcome, not a
  defect.
- **FR-47.** FR-44 MUST be satisfiable using renderer-side operator-session state already available
  to the route layer; it MUST NOT introduce a bridge channel or main-process change (preserves
  SC-17).

### Non-Functional Requirements

- **NFR-1.** Every interactive control on a cashier-critical path MUST meet the ≥ 44 × 44 CSS-pixel
  floor (extends constitution P14).
- **NFR-2.** Every cashier-critical path MUST be completable by keyboard alone, with a visible focus
  indicator at every step (extends P14).
- **NFR-3.** Text and interactive elements MUST meet WCAG 2.1 AA contrast (≥ 4.5:1 body, ≥ 3:1 large
  text and UI boundaries) in the light default theme.
- **NFR-4.** Default state variants of each restyled surface MUST pass an axe-rule smoke check
  (extends P14).
- **NFR-5.** Restyling MUST NOT regress first-paint performance beyond the existing shell budget.
- **NFR-6.** A completion surface may assert success only when backed by a main-process-confirmed
  settlement result — the confirmed `settled_at` and the correspondingly finalized sale record
  (constitution P2).
- **NFR-7.** The target presentation is Windows desktop at the supported terminal resolution; this
  feature is not a mobile or responsive-web redesign.

---

## Scope Structure (U0–U6)

Scope groups, not implementation tasks. Sequencing is a `/speckit-plan` concern.

| Slice | Scope | Depends on |
|:--|:--|:--|
| **U0** | Visual foundation — token values, light default, pharmacy-teal primary, typography incl. Arabic face, spacing/density rules, button and surface hierarchy | — |
| **U1** | Sign-in / shift-start presentation (shift-start = presentation of existing behaviour only; open-shift is not current capability, register D-003) **+ the role-aware `/app` landing correction, FR-44–FR-47** | U0 |
| **U2** | Sale workspace — catalogue, search/scan, product confirm, cart table, totals block | U0 |
| **U3** | Checkout / tender — tender selection (3 supported tenders), amount entry, due/received/remaining hierarchy | U0 |
| **U4** | Sale success / receipt presentation | U0 |
| **U4a** | *(candidate first slice — see below)* Sale-success honesty | U0 (minimal subset) |
| **U5** | Empty / loading / error / offline / gated state presentation | U0 |
| **U6** | Keyboard, accessibility, focus and final visual polish across U1–U5 | U1–U5 |

### U4a — Sale-success honesty (candidate first independently valuable slice)

**Code evidence supports this as the highest-leverage first slice:**
`PaymentSurface.tsx:392-431` renders the settled state as English-only text
("Payment settled." / "Sale {n}" / "New sale") on an Arabic-first product, and `ReceiptPreview`
is never mounted on the completion path — a grep of `src/renderer` shows its only consumer is
`FindSaleReceipt.tsx`. A cashier therefore completes a sale and sees no receipt.

U4a delivers: Arabic-first completion copy; presentation of the receipt information the system
already holds; a strengthened settled-amount hierarchy; the existing "new sale" behaviour unchanged.

U4a explicitly does NOT: alter the payment FSM, money math, or audit behaviour; invent a receipt
delivery channel; add celebration/confetti treatment; add KPI tiles.

U4a is independently valuable because it repairs a violation of an **already-ratified** Arabic-first
rule and is expressible entirely in semantic tokens, so it survives whatever U0 settles.

---

## Screenshot Acceptance

Source review and unit tests alone are **insufficient** evidence of visual completion. Every future
implementation slice MUST be accepted against:

1. the application actually launched;
2. the target surface reached honestly (no code edited to manufacture the view);
3. a "before" screenshot where the surface pre-exists;
4. an "after" screenshot;
5. comparison against the approved v4.0 reference direction;
6. existing behavioural tests remaining green;
7. keyboard and accessibility acceptance appropriate to the slice.

**Manual capture from the running Electron application is acceptable.** An automated screenshot
harness is NOT a prerequisite for starting this feature, and Playwright/Puppeteer or equivalent MUST
NOT be added to satisfy this requirement without separate approval.

> ### ⏸️ Outstanding captures
>
> **Scope of this list: U2 only.** It is not a complete audit of every merged slice — it records the
> one deferral that has been formally tracked. Other slices also carry outstanding captures
> (`tasks.md` leaves **T0A2**, **T0B2**, **T0C1** and **T0C2** unchecked although U4a, U0 and U1
> merged in `f417ea7`) and were **not** audited here. `tasks.md` is the authority for their status —
> `screenshots/README.md` currently holds slice sections for **u4a and u2 only**, so there is no U0
> or U1 record to consult. Absence from this list is therefore **not** evidence a slice is visually
> accepted.
>
> | Slice | Task | Status | Tracking |
> |:--|:--|:--|:--|
> | U2 — sale workspace | T0D1 | ⏸️ **Deferred 2026-09-20.** Merged via PR #447 (`2b4b8be`) with **FR-15 visually unverified** | [#448](https://github.com/Kemetra/POS/issues/448) |
>
> **Two constraints learned while attempting U2's capture, applicable to every future slice:**
>
> 1. **An empty cart cannot evidence FR-15.** No dev fixture seeds cart lines —
>    `POS_PULSE_DEV_SEED_CATALOGUE` populates the *catalogue* only, and the boot cart is
>    `state: "empty"`. Any capture claiming line-item or running-total dominance requires a product
>    searched and confirm-added by hand first.
> 2. **Gate (a) is read from the rotating log FILE, not the terminal.** The main logger never writes
>    to stdout, so checking the console yields a false STOP. See `screenshots/README.md`.
>
> Because capture is deliberately manual here, a slice can pass every automated gate and still be
> visually unaccepted. A green CI run is **not** evidence under this clause.

---

## Key Entities

No new persisted entities. This feature introduces no schema, no migration, and no new bridge
channel.

- **Design token** — a named visual value (colour, spacing, radius, type, elevation) resolved at
  render; the unit U0 governs.

---

## Assumptions

- **A1.** The five supplied images are the approved v4.0 visual direction (owner Decision A) and are
  vendored in-repo at `specs/022-pos-ui-v4-rescue/visual-references/` (clarify Decision 2), losslessly
  re-encoded and pixel-verified against the originals. They are visual authority only.
- **A9.** FR-44's role-aware landing is a navigation correction, not a capability change. On a build
  where the `cart` flag is off, the cashier lands on the cart route's honest gated state rather than
  a role-rejection error — an improvement in truthfulness, not an activation. That gated state is
  today English-only (`CartWorkspace.tsx`), so FR-19 (Arabic-first) is **not** satisfied by FR-44
  alone; U2/U5 complete it.
- **A2.** Light-first supersedes the v3.5 dark default (Decision B). Known impact:
  `src/renderer/styles/__tests__/theme-contract.test.ts:56` asserts `index.html` carries
  `data-theme="dark"`; that test encodes the superseded default and will need owner-sanctioned
  revision during implementation.
- **A3.** Pharmacy teal becomes the primary operational colour and may fill primary actions
  (Decision C), superseding the One-Accent Rule for v4.0.
- **A4.** Token tests assert token *names and structure*, not literal hex values
  (`src/renderer/ui/tokens/__tests__/`, `styles/__tests__/`), so a palette revision is a
  values-level change.
- **A5.** Existing foundations are sound and are extended rather than replaced: CSS-variable token
  layer, the 44 px touch floor, systematic `:focus-visible`, RTL composition, and LTR money isolation.
- **A6.** Per constitution P15, UI-only features are exempt from the production-readiness gate. U4a
  sits adjacent to the receipt path, so the plan phase may still elect a readiness note.
- **A7.** Reaching gated surfaces for visual acceptance uses existing verified dev mechanisms, which
  are compiled out of packaged builds (`isPackaged` guard); production defaults stay unchanged.
- **A8.** "Shift-start" in U1 means presenting existing sign-in/session behaviour, not implementing
  open-shift (register D-003).

---

## Out of Scope

- Backend, Data-Pulse-2, ERPNext Connector, ERPNext, and Admin Console changes.
- **Per constitution P8, this UI-only feature MUST NOT touch:** `src/preload/`, `src/main/`,
  `src/shared/bridge-api.ts`, `migrations/`.
- Every item in the Non-Capability Inventory.
- VAT/fiscal implementation (spec 012); returns/refunds (014); inventory (013); shift/cash management
  (015); credit and third-party tender (020); insurance co-pay.
- Dashboard metric contracts and any KPI data source.
- Changing production feature-flag defaults, or ungating any cashier surface.
- Adding an automated visual-test harness.
- Framework migration, dependency changes, or a broad renderer architecture rewrite.
- Rewriting historical v3.5 documents (reconciliation is named follow-up work, not SPECIFY work).
- Admin-console functionality and any expansion beyond the cashier journey.

---

## Dependencies

- **003-pos-ui-shell** — shell regions, nav rail, reserved slots, token layer.
- **005 / 006 / 008 / 009 / 010 / 011** — the cashier surfaces being restyled; their behaviour is
  authoritative and unchanged.
- **POS v3.5** (`docs/design/pos-v3.5/**`) — structural, copy and honesty context; visually superseded
  on the three axes named above.
- **012-vat-fiscal-receipt** — owns tax presentation; this feature must not pre-empt it.
- An Arabic typeface decision (FR-10) is required before U0 can complete; selection is a plan-phase
  concern and must respect the no-dependency-changes-during-SPECIFY constraint.

---

## Success Criteria

Each criterion is inspectable against the running application, the rendered DOM, or a repository-wide
check. No criterion is satisfied by subjective judgement.

- **SC-1.** Every cashier-journey surface resolves its colour, spacing, radius, type and elevation
  values through the shared token layer; a repository check finds zero hardcoded raw visual values on
  those surfaces.
- **SC-2.** A terminal started with no stored theme preference paints the light theme.
- **SC-3.** Each cashier-journey surface carries exactly one element with the primary-action
  treatment — countable per surface.
- **SC-4.** Every operator-facing string on the cashier journey has Arabic primary text; a check of the
  cashier-journey surfaces finds zero English-only operator strings.
- **SC-5.** On the completion surface, the settled amount is the largest-weighted numeric element; on
  the checkout surface, the amount due is.
- **SC-6.** Every money value, barcode, SKU, sale number and payment reference on the cashier journey
  is direction-isolated LTR.
- **SC-7.** Every interactive control on a cashier-critical path measures ≥ 44 × 44 CSS px.
- **SC-8.** Each cashier-critical path is completable end-to-end using only the keyboard, with a
  visible focus indicator at every step.
- **SC-9.** Default state variants of every restyled surface pass an axe-rule smoke check with zero
  violations.
- **SC-10.** All text and UI boundaries on the light default theme meet WCAG 2.1 AA contrast.
- **SC-11.** No cashier surface displays a numeric business value that is not sourced from a
  system-computed field.
- **SC-12.** Every state in {empty, loading, error, offline, gated} has a distinct rendered
  presentation, and a gated surface is distinguishable from a failed one.
- **SC-13.** Completing a supported sale produces a completion surface that is Arabic-first, presents
  the held receipt information, and states success only when the main-process-confirmed settlement
  exists.
- **SC-14.** Every merged implementation slice carries before/after screenshots from the running
  application plus a comparison note against the v4.0 reference direction.
- **SC-15.** The existing behavioural test suite (baseline at specification time: 468 files / 5538
  passing / 3 skipped) remains green, with any test change limited to those encoding a superseded
  visual default and explicitly owner-sanctioned.
- **SC-16.** No capability from the Non-Capability Inventory appears in any shipped surface.
- **SC-17.** No production feature-flag default changed, and no file under `src/preload/`,
  `src/main/`, `src/shared/bridge-api.ts` or `migrations/` was modified by this feature.
- **SC-18.** POS v3.5 documents remain present and traceable in the repository, and v4.0's three
  superseding axes are recorded with their v3.5 counterparts cited.
- **SC-19.** A signed-in `cashier` arriving at `/app` renders the sale/cart surface or its honest
  gated state as the first surface, never a role-rejection error; a signed-in `manager` or `admin`
  still renders the dashboard; and a `cashier` navigating directly to `/app/dashboard` still
  receives the existing role-rejection state.
- **SC-20.** The five approved v4.0 reference images are present in
  `specs/022-pos-ui-v4-rescue/visual-references/` under their stable names, and each is
  pixel-identical to the owner-supplied original.

---

## Open Questions

- (none)

**Resolved in clarify (Session 2026-09-18):** the cashier landing route question carried from
SPECIFY is closed by Decision 1 — a narrow role-aware `/app` landing correction is granted as an
explicit exception to FR-40, recorded as FR-44–FR-47 and assigned to slice U1.

---

*Constitution alignment:* This spec MUST satisfy `.specify/memory/constitution.md` **v1.5.1**,
notably P1 (financial correctness over polish), P2 (no fake success states — see NFR-6),
P8 (Electron security boundary — see Out of Scope), P13 (small scoped PRs — see U0–U6),
P14 (accessibility and cashier ergonomics — extended by NFR-1/2/4) and P16 (feature scope discipline
— see the Non-Capability Inventory). The plan and tasks artifacts will perform the explicit
Constitution Check.
