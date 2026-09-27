# Implementation Plan: Sales Cart

> 🔁 **RT-28 amendment (2026-09-27):** manual discounts are **manager-only** — the Q2 threshold and every "below/above threshold" rule in this file are SUPERSEDED. Canonical text: [`spec.md`](spec.md) Amendment + FR-023 (revised). New audit category `cart.discount.manager_authorized`; `cart.discount.above_threshold` is historical only. Threshold references below are kept for audit trail.


**Feature ID:** 005-sales-cart
**Spec:** [./spec.md](./spec.md)
**Plan Version:** 1.0
**Created:** 2026-05-09
**Last Updated:** 2026-05-14 (`/speckit-plan` run; Q1–Q5 reconciled; Phase 0 + 1 artifacts authored)
**Constitution version pinned:** v1.5.1
**Branch:** `005-sales-cart`

> ✅ **APPROVED for `/speckit-tasks`.** §A0 cleared 2026-05-14 (004 S4 merged PR #124 on 2026-05-11; 004 S5 visibility boundaries merged 2026-05-14, main SHA `d247e8a`). `/speckit-clarify` ran 2026-05-14 and locked Q1–Q5 (item-note ≤ 200 chars; discount-attribution threshold is percentage of `line_subtotal_minor` per-line with tenant-configurable numeric value; cart-stale-while-signed-out = discard immediately option (a); duplicate-add merges by `item_ref` as default; offline-cart discard emits separate audit event `cart.discarded_on_session_end`). R1 (line-merge) and R3 (cart-stale) are reconciled to Q4 and Q3 respectively. Phase 0 research, Phase 1 data model, contracts, and quickstart are co-resident in this PR. **`/speckit-tasks` is the next Spec Kit step.** Implementation slices S0–S5 remain held behind their per-slice gates (§A1–§A5) as enumerated under Approval Gates.

---

## Summary

Feature 005 introduces the **sales-cart layer** that sits between 004's operator/
session/visibility infrastructure and the future payments feature. It owns the
cart's behavioural rules — lifecycle (draft → cancelled / handed_off_to_payment),
line-item CRUD with idempotency, item notes, discount placeholders, cashier /
manager attribution, offline-safe drafts that survive restart while the operator
remains signed in, void / cancellation, and the **payment-intent envelope**
handoff point — and stops short of all money-finalising mechanics. Tax math,
tender, change, receipt rendering, inventory mutation, and shift financial
calculations are *not* in 005; they belong to later, named features.

The cart layer cannot exist without 004 because:

1. **Every cart action attributes to an active operator session** — the entity
   that decides "who is the cashier acting on this cart right now" is owned
   by 004 (P10).
2. **Cart sensitive actions (void, discount-above-threshold, post-handoff line
   removal attempt)** emit audit events into the existing `audit_events` table
   and emitter that 004 lands. 005 does *not* introduce a parallel audit
   substrate.
3. **Role-gated cart surfaces** (manager-attributed void after handoff,
   discount-above-threshold prompt) ride 004's role-visibility matrix and the
   bridge-side `requireOperatorSession` gate (004 AD-1). The cashier-forbidden-
   information catalogue finalised in **004 S5** directly constrains which cart
   surfaces a cashier may see and which require manager attribution.

Because of these dependencies, this plan is intentionally restrained. **No
source files are written, no migrations are authored, no OpenAPI is mutated,
no packages are installed by `/speckit-plan`.** Phase 0 research and Phase 1
contract artifacts ([`research.md`](./research.md), [`data-model.md`](./data-model.md),
[`contracts/bridge-api.md`](./contracts/bridge-api.md),
[`contracts/handoff-envelope.md`](./contracts/handoff-envelope.md),
[`contracts/role-visibility-matrix-cart.md`](./contracts/role-visibility-matrix-cart.md),
[`quickstart.md`](./quickstart.md)) are co-resident with this plan as of 2026-05-14.
SQL migrations, source files, OpenAPI changes, and visual-direction (S0) artifacts
remain gated on §A1–§A5 and Slice 0 review respectively.

## Technical Context

005 is a renderer + main-process feature spanning the existing Electron
foundation laid by 001/002/003/004. Like 004, it expands the preload bridge
under explicit security review — this time under the `cart.*` namespace — and
introduces three new SQLite tables. It does **not** introduce new connection-
state visuals, new hardware surfaces, new identity primitives, or any
money-finalising arithmetic. The only money math 005 owns is **per-line
subtotal in integer minor units** (AD-4); aggregate tax / discount / change /
tender arithmetic is owned by the future payments feature.

| Area | Choice | Source |
|:--|:--|:--|
| Runtime / packaging | Electron `^40.9` Windows 10/11 x64 (inherited) | constitution v1.5.1 / plan 001 |
| Renderer | React `^19.2` + Vite `^8.0` + TypeScript `^5.9` strict (inherited) | plan 001 |
| Styling | Tailwind `^4.2` (CSS-first); design tokens from 003 (`src/renderer/ui/tokens/`) — cart pane fills the **already-reserved cart slot** in 003's shell layout | 003 plan §Technical Context |
| Routing | Existing `react-router-dom@7`. The cart pane is **embedded inside 003's `/app/*` shell** at the cart slot; no new top-level route. Cart-bound actions guarded by 004's `<OperatorRouteGuard role="cashier|manager|admin">` (renderer-side, **secondary** UX defence — bridge gate is primary per AD-1). | 003 + 004 |
| Renderer state (cart draft, line items, idempotency outbox mirror, handoff state) | Existing `zustand@4`. New slice `cartStore`: 5-state finite-state machine (`empty` / `editing` / `discount_pending_attribution` / `handing_off` / `frozen_handed_off`). Mirrors *only* what the bridge confirms — never authoritative on its own. | research §3 (future) |
| Server-state hooks | Existing `@tanstack/react-query@5` for the future item-catalogue lookup *seam* (`bridge.cart.resolveItemRef`); no live server-state in 005's own scope. | AD-5 |
| Component primitives | Reuse 003's `src/renderer/ui/` inventory (Button, Input, Card, Dialog, Toast, StatusBanner). New under `src/renderer/ui/cart/`: `CartPane`, `LineItemRow`, `QuantityStepper` (≥ 44 × 44 CSS px), `LineNotePopover`, `VoidConfirmation`, `DiscountPlaceholderRow`, `ManagerAttributionPrompt`, `HandoffSummary`. **Layout-only / Slice 0** until §A0 lifts. | spec FR-033 (cascaded) |
| Density / touch targets | Inherit `comfortable` density and the 44 × 44 CSS px floor from 003. Quantity stepper, void-confirm, manager-attribution prompt MUST honour the floor. | 003 NFR-5 / 004 NFR-005 |
| Connection-state model | Inherit 003's four states (`online`, `degraded`, `offline`, `syncing`). 005 introduces no new connection states. Cart drafts persist locally (P18) regardless of connection state; the **handoff envelope** crossing into the future payments feature MAY be online-only (decided by the future payments feature, not here). | 003 + AD-2 |
| Identity / role model | Inherit verbatim from 004. No 005-specific identity primitives. Cart attribution = `currentSession.actor` (Clerk-backed identity). | 004 AD-2 / Principle VIII |
| Bridge surface (NEW, gated) | `src/shared/bridge-api.ts` extended with the `cart.*` namespace. Bridge enforces FR-019 (information-layer role boundary) — see AD-1. Bridge expansion is gated on §A0 (parent gate); the namespace surface itself is described conceptually in this plan and authored in `contracts/bridge-api.md` only after §A0 lifts. | research §6 (future) / contracts/bridge-api.md (FUTURE) |
| Local persistence | NEW SQLite tables: `carts` (header / lifecycle), `cart_lines` (per-line state + last-action idempotency reference), `cart_action_outbox` (P5 idempotency-keyed cart-action records). **Migration files NOT authored by `/speckit-plan`.** All migration work is gated on §A0 (overall) and §A2 (per-table migration approval). | data-model.md (FUTURE) |
| Audit substrate | **Reuses 004's existing `audit_events` table and emitter** — no new audit table (AD-3). Cart action categories (`cart.void`, `cart.discount_applied_above_threshold`, `cart.line.removed_after_handoff_attempted`) are **Phase-0 placeholders**; the canonical list is finalised during `/speckit-tasks` once §A3 (audit-catalogue extension) clears, coordinated with the 004 S5 close-out PR. | AD-3 |
| Money | **Integer minor units only.** Per-line subtotal (`quantity * unit_price_minor`) computed via `BigInt` or `Number.isSafeInteger`-guarded arithmetic. Cart subtotal (in the handoff envelope) is also integer minor units. **No tax, no rounding, no change, no tender math at the cart layer.** | constitution P1 / AD-4 |
| Tests | Vitest only. Coverage gates: ≥ 95 % on bridge-side cart-action gate; ≥ 90 % on `cartStore`; ≥ 95 % on the per-line subtotal arithmetic module (load-bearing money rule); cross-process redaction smoke extends 002's to cover `cart.*` payload allowlist refusals. Per-surface axe rule pass on default / loading / error variants. | constitution VI / Test Strategy |
| CI | No workflow changes; the existing `codegen:verify → typecheck → lint → test → package:dir` pipeline gates this feature. | research §6 (future) |

**`NEEDS CLARIFICATION` items at the spec layer:** the parallel `spec.md` is
being drafted by a sibling agent; this plan does not enumerate spec-layer
clarifications. If the parallel spec lands with open clarifications, **§A0 does
not lift until those clarifications close** (in addition to the 004 S4 + S5
gating).

### Hard Non-Implementation Boundaries

005 inherits 004's "Hard Non-Implementation Boundaries" pattern. Within this
plan, the following remain explicitly out of scope and any task that drifts
into them MUST be filed as a separate feature, not folded into 005:

- **No payments / tender / money-finalising math.** Tender selection, change
  calculation, tax math, rounding rules, split tender, cash-drawer kicks,
  printed-receipt payment-breakdown surface — *all* belong to the future
  payments feature. The cart layer hands off a `payment-intent envelope` and
  freezes; everything downstream is owned elsewhere.
- **No receipt / receipt rendering.** Including no thermal-printer driver,
  no receipt template, no per-line receipt formatter, no totals block on a
  receipt. The Receipt / Checkout placeholder pane reserved by 003 FR-12
  remains a 003-owned slot; 005 fills the **cart slot only**.
- **No inventory mutation, no stock movement, no FEFO logic.** Adding a line
  item does NOT decrement stock; the cart resolves `item_ref` to display
  fields only. Stock validation, reservation, expiry-aware allocation, and
  cart-vs-on-hand reconciliation are owned by a future inventory feature.
- **No reports / KPIs / dashboards / analytics surfaces.** Cart counts,
  conversion rates, abandoned-cart metrics, etc. — out of scope.
- **No shift financial calculations.** Cart action timestamps may correlate
  with shift windows for audit purposes (via 004's existing audit categories),
  but no drawer-math, expected-total, variance, or reconciliation lives in 005.
- **No backend / API implementation.** No new OpenAPI endpoints are designed
  or pinned by `/speckit-plan`. The cart is local-first; the only backend
  touch-point a cart action *might* require is item-catalogue resolution,
  which is owned by a future feature (AD-5).
- **No migrations authored.** `carts`, `cart_lines`, `cart_action_outbox` are
  *described* conceptually; SQL is gated on §A2.
- **No codegen run.** `npm run codegen:api` is not invoked by `/speckit-plan`.
- **No UI implementation.** All component names listed under "Component
  primitives" are placeholders for Slice 0's contact sheet, not authored code.
- **No Data-Pulse-2 changes.** 005 does not touch the SmartDataPulse backend
  repo at all. The constitution's Principle IX (Reference, Not Inheritance)
  applies: no copy-paste from `_reference/Data-Pulse/`; cart rules are
  re-derived from the constitution + 001/002/003/004 plans + the (parallel)
  005 spec.
- **No card-terminal integration / payment-provider SDK.** Belongs to the
  future payments feature.
- **No printed-receipt rendering.** As above.
- **No discount math / tax math.** Discount placeholders (cart-level OR
  line-level — research §R6 picks the slot) are *opaque tokens* that the
  future payments feature interprets; 005 does not compute discounted totals.
- **No cashier-self-service price overrides.** Cashier-attributed price edits
  on a line are forbidden. Manager-attributable line-level price overrides
  *may* land as a future feature; 005 does not introduce them.
- **No new IPC channel beyond the `cart.*` namespace** that will be defined
  in `contracts/bridge-api.md` once §A0 lifts. Other channels remain frozen.
- **No weakening of 001/002/003/004 security boundaries.**
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no
  upward-of-bridge IPC, integer-minor-units money, Sentry/log redaction,
  PIN-record secrecy (004 PR-1), bridge-side role enforcement (004 AD-1) —
  all preserved. S2's security-review gate (below) enforces this affirmatively.

## Architectural Decisions

These are the load-bearing choices this plan commits to. Each cites the
requirement that forces it and the alternatives rejected.

### AD-1. Cart-mutation gating at the **bridge-API surface** (primary), with renderer state stores as **secondary UX defence** only

**Choice.** Every bridge-API function exposed by the new `cart.*` namespace
self-gates against the **main-process-held** `currentSession.role` and the
**existing-session invariant** (an operator session must be active *and* the
cart's `owning_operator_id` must equal `currentSession.operator_id`, except for
manager-attributable post-handoff actions per 004's role-visibility matrix
extended in `role-visibility-matrix-cart.md`).

The first executable instruction of every cart bridge handler is:

```
requireOperatorSession({ role?: 'cashier' | 'manager' | 'admin', cart_id?: string })
  → returns the current operator session OR refuses generically (FR-019 / 004 PR-2 wording).
```

This helper is **not** a renderer concept — it lives in `src/main/cart/` and
calls into 004's `src/main/operator/role-enforcement.ts`. The renderer
`cartStore` does **not** mutate cart state authoritatively; it mirrors
**only what the bridge confirms**. A renderer-side optimistic transition
that the bridge later refuses MUST roll back to the bridge-confirmed state
(P2: No Fake Success States).

**Why.** Mirrors 004 AD-1. FR-019 (information-layer role boundary) is
inherited verbatim from 004 — the renderer is untrusted by construction
(Constitution Principle III); a route guard or a renderer-store check in
untrusted code cannot satisfy a trust boundary. The main process *is* the
trust boundary. Putting the gate at the bridge — the seam between trusted
and untrusted — is the architecturally honest answer.

**Alternative rejected: Renderer-store-only gating.** A `cartStore` action
that checks `currentSession.role` before dispatching and refuses locally
would be simple but trivially bypassed by direct preload-bridge calls from
DevTools or any future renderer integration. Rejected per Principle III.

**Alternative rejected: Query-builder enforcement (SQLite read helpers
inject role-aware `WHERE` filters and refuse generically on mismatch).**
Defensible but pushes the gate one layer further from the trust boundary,
and several cart rules (refuse a manager-attribution prompt for a cashier;
freeze a cart on handoff; emit a sensitive-action audit event) are not
query-shaped. Same shape as 004 AD-1's rejection; consistent here.

**Implication for `/speckit-tasks`.** Every cart bridge handler task MUST
call `requireOperatorSession` as its first executable instruction; the test
plan MUST cover the no-session, wrong-role, wrong-owning-operator, and
post-handoff-frozen refusal paths.

### AD-2. Cart drafts are local-first; the **payment-intent envelope** is the ONLY thing the future payments feature consumes from cart

**Choice.** Cart drafts persist in local SQLite (`carts` + `cart_lines`)
and survive application restart while the originating operator session
remains valid. Every cart-mutating action records an entry in
`cart_action_outbox` with a **client-generated UUID v4 idempotency key**
(P5) established at the moment of intent. The outbox is the durable,
append-only record of cart action history; `cart_lines` holds the current
materialised state (mutable for in-progress edits) and references the
last-applied action by id.

**Cross-feature contract surface — the payment-intent envelope.** When the
cashier hands the cart off to payment, the cart layer constructs an
**immutable** envelope containing:

- `cart_id`, `tenant_id`, `branch_id`, `terminal_id`
- `owning_operator_id` (the cashier; Clerk-backed identity)
- frozen `lines[]`: each entry { `item_ref`, `display_name`, `quantity`,
  `unit_price_minor`, `line_subtotal_minor`, `note`, `version`,
  `last_action_id` }
- frozen `discount_placeholders[]`: opaque tokens (research §R6 picks
  cart-level vs line-level; 005 does not compute math against them)
- `cart_subtotal_minor` (sum of `line_subtotal_minor`; integer minor units)
- `frozen_at` timestamp
- `handoff_action_id` (UUID v4; the same id that audited the handoff event)

Once the envelope is constructed, the cart transitions to
`frozen_handed_off`. **No further mutation is permitted** through the
`cart.*` namespace — only manager-attributable void (post-handoff void is
in 004's role-visibility matrix extension, see
`role-visibility-matrix-cart.md`). Any cashier-initiated post-handoff
mutation attempt is generically refused AND emits a
`cart.line.removed_after_handoff_attempted` audit event (or the
finalised-name equivalent post-§A3).

**The envelope is the single cross-feature contract surface.** The future
payments feature consumes exactly this shape — *not* the live `carts` or
`cart_lines` rows, *not* the bridge-side cart store. The shape itself is
ratified with the future payments feature owner before S4 of 005 merges
(§A4).

**Why.** Constitution P18 (Local Durability Before Offline Promises): a
cart draft visible to the cashier MUST survive restart; otherwise the
"cart is open" indicator becomes a fake state (P2). Constitution P5
(Idempotency for Retried Operations): every retried cart action has the
same UUID, so a "decrement quantity" issued twice does not double-
decrement. The envelope is immutable to enforce the contract that the
future payments feature does not race the cashier's edits — once the
envelope crosses, the cart freezes.

**Alternative rejected: cart drafts are in-memory only.** A power loss or
restart loses the cart. Rejected per P18.

**Alternative rejected: future payments feature consumes the live cart
table directly.** Forces 005 and the payments feature into a shared schema
that mutates from both sides. Rejected because (a) cart freezes on handoff
under 005's rules but the payments feature might want to record its own
state alongside; (b) couples two features tightly; (c) makes the boundary
non-honest.

### AD-3. Cart-level sensitive actions emit audit events into 004's existing `audit_events` table — no new audit substrate

**Choice.** Cart sensitive actions reuse 004's existing `audit_events`
table and the `src/main/audit/audit-emitter.ts` emitter. **No new audit
table is introduced by 005.** The canonical action categories are
(Q5-locked 2026-05-14; final wiring deferred to S3 under §A3):

- `cart.handoff_to_payment` — the cashier hands off a non-empty cart;
  the bridge constructs and freezes the `PaymentIntentEnvelope`. The
  cashier is `acting_operator`; no manager attribution required for the
  handoff itself. (Spec FR-026, US3-AS6.)
- `cart.cancel.post_handoff` — manager-attributed void of a cart already
  in `frozen_handed_off`. Both cashier (requester) and manager (approver)
  identities are recorded per 004 FR-025(f). (Spec FR-026, FR-033.)
- `cart.discount.above_threshold` — the cashier applied a
  discount-placeholder whose magnitude exceeds the Q2-locked tenant-
  configured percentage-of-`line_subtotal_minor` threshold; manager
  attribution is recorded as the `acting_operator`. The cashier remains
  the cart's `owning_operator`; the manager is the *attribution* of the
  sensitive action only. (Spec FR-023, FR-026.)
- `cart.discarded_on_session_end` — emitted when Q3 policy (a) discards a
  draft on operator-session end (sign-out, inactivity timeout per 004
  FR-009, takeover supersession per 004 FR-013). The cashier whose session
  ended is the `acting_operator`. Queued in the local outbox when offline
  (Q5 LOCKED 2026-05-14 — fourth addition to 004's §A3 catalogue alongside
  the three above). (Spec FR-007, FR-026, SC-005.)

These four names are the canonical wording adopted from spec FR-026 + Q5.
Earlier working titles (`cart.void`, `cart.discount_applied_above_threshold`,
`cart.line.removed_after_handoff_attempted`) used during plan-draft are
**superseded** by this list. The §A3 coordination still gates 004's
authoritative action-category enum landing the four names; 005 S3 will not
begin until that enum extension is in `main` (coordination-only — no shape
change).

**Constraints inherited from 004 AD-3.** Append-only at schema and rule
levels. Every audit event carries a client-generated UUID v4 (P5). The
`acting_operator` is the stable Clerk-backed identity (never the local
PIN record). Audit emission is the same emitter; cart events are not a
parallel trail.

**Why.** Constitution P10 (Operator Accountability for Sensitive
Actions) names "void", "discount above threshold", and "post-finalisation
mutation attempt" as audit-eligible by category. Reusing 004's substrate
honours P12 (Spec Kit Artifacts Are Source of Truth) and P16 (Feature
Scope Discipline) — 005 does not re-invent what 004 already owns.

**Phase-0 catalogue placeholder.** The three category names above are
working titles; the canonical names are decided in `/speckit-tasks`
under §A3 in coordination with the 004 S5 PR.

### AD-4. Money is integer minor units at the cart layer too

**Choice.** Per-line subtotal arithmetic uses **integer minor units only**.
Computed as `quantity * unit_price_minor` via either `BigInt` or, where
inputs are guaranteed safe-integer, plain integer arithmetic guarded by
`Number.isSafeInteger` on the result. The arithmetic lives in a single
small module (`src/main/cart/line-subtotal.ts` post-§A0) with ≥ 95 %
coverage; rejection branches (overflow, non-integer input, negative
quantity, non-integer price) MUST refuse the action with a generic error
(no factor-distinguishing variants per 004 NFR-003 / PR-2 inherited).

**Aggregate cart subtotal** (the `cart_subtotal_minor` field of the
handoff envelope) is `Σ line_subtotal_minor`, also integer minor units.
This is the *only* aggregate 005 owns.

**Forbidden at the cart layer.** Tax calculation, discount magnitude
computation, rounding (other than the trivial truncation that integer
arithmetic implies), tender / change / split-tender math, currency
conversion, percentage-based price modifications. **All of these are
owned by the future payments feature.** A cart-level discount placeholder
(per AD-2) is an *opaque token* — its magnitude is interpreted later, not
applied to the cart subtotal in 005.

**Why.** Constitution P1 (Financial Correctness First — Money is integer
minor units; floats forbidden) is load-bearing. Even though 005 owns only
*partial* money math, that partial math is in the same trust line as a
sales total — wrong subtotals propagate into wrong payments. ≥ 95 %
coverage matches 004's load-bearing trust-boundary modules and 001's
`Money` module.

**Alternative rejected: float arithmetic for "just" subtotals.** Forbidden
by P1; not a fallback.

**Alternative rejected: defer all money math to the payments feature
(including per-line subtotal).** Tempting (cleaner boundary) but the cart
UI must show per-line subtotals to the cashier in real time, and a
zero-arithmetic cart layer would have to call into the payments feature
for every keystroke — couples the features, defeats local-first. Rejected.

### AD-5. Item-catalogue resolution is **out of scope** for 005 — propose a stub seam

**Choice.** When a cashier adds a line item, the cart needs `display_name`
and `unit_price_minor` for that `item_ref`. **005 does NOT design the
item-catalogue feature.** Instead, the cart layer assumes a future
item-catalogue feature (or a 005-companion feature) provides a stub
**bridge seam**:

```
bridge.cart.resolveItemRef(item_ref: string)
  → { display_name: string, unit_price_minor: number, version: string }
    | { kind: 'refused', reason: 'unknown_item' | 'disabled' | 'no_connection' | 'generic' }
```

For Phase 0 research (R7 may be added), a working title for the seam is
proposed; the actual implementation lives in a separate feature. **Until
that feature exists**, 005 may stub the seam with a **fixture-only**
resolver during S1 + S2 testing — but **no production code path consults
a real catalogue from within 005**. The stub fixture has zero entries by
default; tests inject a known SKU set.

**Why.** Constitution P16 (Feature Scope Discipline) — the item-catalogue
feature has its own scope, schema, sync semantics (it is server-of-truth
for prices), and audit rules (price changes are a sensitive event in
their own right). Folding even a partial catalogue resolver into 005
would either (a) duplicate work the future feature must redo or (b)
under-design the catalogue rules and pollute 005's surface with
catalogue-specific concerns.

**Implication for the spec.** The parallel `spec.md` MUST treat
`resolveItemRef` as an *external* dependency; spec FR rows about "what
happens when an unknown SKU is added" route to "the seam refuses
generically; the cashier sees a generic error". The spec MUST NOT
prescribe catalogue rules.

**Alternative rejected: 005 ships a minimal SKU table.** Rejected per
P16 — a "minimal" catalogue grows by feature creep into a
not-actually-minimal catalogue.

**Alternative rejected: hard-code the seam as a Vitest fixture in
production code.** Rejected — production code paths MUST NOT depend on
test fixtures.

## Constitution Check (Initial)

Walked across both Roman-numeral Core Principles (I–IX) and Cross-Feature
POS Principles (P1–P18) per constitution v1.5.1 governance.

### Core Principles (I–IX)

| Principle | Status | Notes |
|:--|:--:|:--|
| I. Offline-First (NON-NEGOTIABLE) | **PASS-with-deferral** | Cart drafts are local-first (AD-2); add / remove / update / void all work offline. The handoff envelope crossing into the future payments feature MAY be online-only — but that decision is the **payments feature's** to make, not 005's. 005's offline guarantee is: cart drafts persist locally, survive restart, may be cancelled/voided offline, and may *attempt* handoff offline (the payments feature decides the offline policy from there). |
| II. Financial Precision — No Floats | **PASS-load-bearing** | AD-4 covers per-line subtotal and the cart subtotal (in the handoff envelope) as integer minor units. No floats anywhere. ≥ 95 % coverage on the arithmetic module. |
| III. Process-Boundary Discipline (NON-NEGOTIABLE) | **PASS** | Bridge expansion is `cart.*` only (described conceptually here, contract authored under §A0). All new IPC channels enumerable, named, documented (post-§A0). Renderer never imports Node modules directly. SQLite access (`carts`, `cart_lines`, `cart_action_outbox`) lives in the main process. |
| IV. Hardware Loud, Not Silent | **N/A** | No new hardware surface. |
| V. Type Safety End-to-End | **PASS** | All `cart.*` bridge calls typed in `src/shared/bridge-api.ts` (post-§A0). Both ends share the interface. No `any`. The `PaymentIntentEnvelope` type is a load-bearing cross-feature shape; it lives in `src/shared/cart/handoff-envelope.ts` (post-§A0). |
| VI. Test-First, Coverage-Gated | **PASS** | Each slice ships failing tests first. Coverage targets per Test Strategy: ≥ 95 % bridge-side cart-action gate, ≥ 95 % per-line subtotal arithmetic, ≥ 90 % `cartStore`. CI ratchets upward only. |
| VII. Observability — Local Logs + Remote Crash Reports | **PASS-with-extension** | New `pino` log sites for: cart-action outcome category, cart void, discount-placeholder application, handoff-envelope construction, post-handoff mutation refusal, audit-event emission. **All sites pair with redaction list updates** — `note` field (PII redaction; capped length to bound diagnostic-bundle size), discount-placeholder magnitude tokens (treat as sensitive until the payments feature defines otherwise). Sentry scrubber updated symmetrically. P11 enforcement. |
| VIII. Terminal Identity ≠ User (NON-NEGOTIABLE) | **PASS-inherited** | 005 introduces no new identity primitives. All cart attribution uses the Clerk-backed identity carried by the active operator session. The local PIN factor (004 AD-2) plays NO role in 005. |
| IX. Reference, Not Inheritance | **PASS** | No legacy POS cart code is consulted. All decisions re-derived from the constitution + 001/002/003/004 + the (parallel) 005 spec. No copy-paste from `_reference/Data-Pulse/`. |

### Cross-Feature POS Principles (P1–P18)

| Principle | Status | Notes |
|:--|:--:|:--|
| P1. Financial Correctness First | **PASS-load-bearing** | AD-4 codifies. Per-line subtotal arithmetic is the load-bearing module; ≥ 95 % coverage; integer minor units only. Aggregate cart subtotal (in the envelope) is also integer minor units. Tax / discount / change / tender math is **forbidden** at the cart layer (boundary preserved). |
| P2. No Fake Success States | **PASS** | Every cart-mutating action is bridge-confirmed before the renderer reflects it as committed. Optimistic transitions roll back on bridge refusal. Handoff envelope construction is bridge-side; the renderer does NOT show "handed off" before the bridge confirms. |
| P3. No Silent Data Loss | **PASS-load-bearing** | Cart actions use the local outbox + idempotency-key pattern (`cart_action_outbox`). Failed actions queue locally (when applicable); a retry uses the same UUID. No silent drop on crash, restart, or network failure. Cart drafts themselves survive restart (P18). |
| P4. Auditability and Non-Destructive Financial Correction | **PASS-inherited** | Cart sensitive actions emit into 004's append-only `audit_events` (AD-3). Corrections (e.g., a cashier changes their mind about a quantity) are new outbox entries, not mutations of prior outbox entries — `cart_action_outbox` is append-only at the schema level (UPDATE / DELETE denied by trigger; reuses 004's append-only pattern). |
| P5. Idempotency for Retried Operations | **PASS-load-bearing** | Every cart action carries a client-generated UUID v4 established at the moment of intent. The same UUID is the idempotency key in `cart_action_outbox`. The handoff envelope's `handoff_action_id` is the same UUID as the audit event for the handoff. |
| P6. No Raw Cardholder Data by Default | **N/A** | No card data at the cart layer. The future payments feature owns this. |
| P7. Secrets Never Reach Renderer or Logs | **PASS** | No secrets in cart payloads. The `note` field is PII-redacted in logs (length-capped + redaction list). The discount-placeholder token is treated as sensitive in logs until the payments feature defines otherwise. |
| P8. Electron Security Boundary | **PASS-with-justified-expansion** | 005 expands `src/preload/`, `src/shared/bridge-api.ts`, `src/main/`, and (under approval) the migration runner. P8 forbids "smuggled" expansion; 005 *owns* these expansions explicitly. Slice S2's security-review gate (mirroring 004 S2) walks the bridge-surface diff line by line. |
| P9. Truthful Offline / Degraded / Sync States | **PASS** | 005 introduces no new connection-state visuals. Cart pane respects 003's four-state indicator; an offline cashier sees an offline banner but can still edit drafts. |
| P10. Operator Accountability for Sensitive Actions | **PASS-load-bearing** | Every cart sensitive action (void, discount-above-threshold, post-handoff mutation attempt) emits an audit event with `acting_operator` set to the Clerk-backed identity. AD-3 codifies. |
| P11. Supportability Without Secret Leakage | **PASS** | New log sites pair with redaction list updates. Support-bundle export tooling runs the same redaction pipeline. The `note` field is length-capped + redacted; the discount-placeholder token is redacted to an opaque reference. |
| P12. Spec Kit Artifacts Are Source of Truth | **PASS** | This plan + the parallel `spec.md` + the future `tasks.md` are the source of truth. No conversation-only decisions. |
| P13. Small, Scoped Implementation PRs | **PASS** | Slice strategy below produces small PRs. Slice S0 is non-code. Slices S1–S5 each ≤ ~600 LOC diff target. No `git add -A`. Final-polish slice MUST be small. |
| P14. Accessibility and Cashier Ergonomics | **PASS** | Cart pane fully keyboard operable. Quantity stepper targets ≥ 44 × 44 CSS px. Per-surface axe rule pass on default / loading / error variants. Manager-attribution prompt MUST be reachable by keyboard alone. |
| P15. Production Readiness Gates | **PASS-with-deferral** | 005 is production-affecting (cart is in P15's named domain alongside cashier login). Production Readiness subsection (below) names the test plan, rollback strategy, support-runbook entry, failure-mode catalogue. **The production-rollout PR for 005 cannot land until the future payments feature also reaches its production-readiness gate** — otherwise carts can be opened but not paid. §A5 codifies. |
| P16. Feature Scope Discipline | **PASS** | Hard Non-Implementation Boundaries restate the spec's Out-of-Scope list. AD-5 specifically prevents item-catalogue creep. |
| P17. Privacy and Tenant Isolation | **PASS** | Every new SQLite table carries `tenant_id` and `branch_id`. The `carts` table additionally carries `terminal_id` for support-bundle scoping. The `note` field is PII-redacted in logs. |
| P18. Local Durability Before Offline Promises | **PASS-load-bearing** | AD-2 codifies. Cart drafts survive application restart while the operator remains signed in. The handoff envelope's offline policy is deferred to the payments feature; 005 promises only that the cart layer cleanly hands off whatever the payments feature is willing to accept. |

**Gate result: PASS-with-deferral.** Implementation slices may not begin until
**§A0** clears (the load-bearing 005 blocking gate — 004 S4 closeout AND 004 S5
visibility boundaries reviewed and approved). The offline-first promise is
PASS-with-deferral because the handoff envelope's offline policy is owned by
the future payments feature; 005's local cart-draft promise stands without
deferral. Implementation slices S1–S5 are also held on §A1 (item-catalogue
seam — see Approval Gates), §A2 (migrations), §A3 (audit-catalogue extension
in 004 S5 close-out PR), and §A4 (handoff-envelope shape ratified with the
future payments feature owner).

## Phase 0 — Research

Phase 0 output is captured in [`research.md`](./research.md). The summary
below restates the chosen approach for each research item; rationale and
rejected alternatives live in `research.md`.

- **R1. Line-merge-by-`item_ref` vs separate-line policy — RESOLVED by Q4
  (LOCKED 2026-05-14): merge by `item_ref` is the default.** When the cashier
  adds the same `item_ref` to a cart that already contains a line for that
  `item_ref`, the existing line's `quantity` is incremented by the add's
  quantity and `version` advances. The idempotency-key on the merging action
  pins the merge as a single replayable operation. The earlier plan-draft
  leaning ("append separate line") is reversed by Q4. A "force separate line"
  affordance is deferred to a future catalogue/UI feature (spec FR-014,
  US1-AS6, §Edge Cases). Per-line notes and per-line discount placeholders
  attach to the surviving merged line; downstream features that need true
  per-add isolation must wait for the deferred affordance.

- **R2. Optimistic-concurrency token format for `cart_lines.version` —
  RESOLVED: monotonic integer scoped per `(cart_id, line_id)`.** Incremented
  on each successful mutation of that line (quantity change, note edit,
  merge increment per R1). Simpler than a content hash, deterministic to
  reason about, and matches the optimistic-concurrency idiom most cashier-
  facing surfaces will read (compare-and-swap by integer rather than
  rehashing on every read).

- **R3. Cart-stale policy on operator-session end — RESOLVED by Q3 (LOCKED
  2026-05-14): option (a) discard immediately on session end.** When the
  operator session ends (explicit sign-out, inactivity timeout per 004
  FR-009, takeover supersession per 004 FR-013), the draft cart is
  discarded immediately. The cart transitions to `cancelled` with
  `cancellation_reason = 'session_ended'`. A `cart.discarded_on_session_end`
  audit event is emitted (Q5; queued in the local outbox when offline).
  The cart is never observable by a subsequent cashier on the same terminal.
  The earlier plan-draft leaning ("preserved + re-opens for the same
  operator") is reversed by Q3 (spec FR-007, §Edge Cases, A9).

- **R4. Idempotency-key persistence shape — RESOLVED: outbox owns the key,
  cart_lines carries a cached pointer.** The UUID v4 lives in
  `cart_action_outbox.action_id` (one row per action; append-only).
  `cart_lines.last_action_id` is a cached pointer into the outbox so a
  bridge handler can answer "what was the last applied action on this
  line?" without scanning. Read-after-write verification reads both
  (outbox for the action shape; line for the materialised state).

- **R5. Handoff envelope serialisation — RESOLVED: in-process struct +
  persisted JSON copy; unsigned.** The `PaymentIntentEnvelope` is
  constructed in-memory as a `Readonly<>` TypeScript object protected by
  `Object.freeze`; a JSON serialisation is also persisted to
  `carts.handoff_envelope_json` so support-bundle export sees the envelope
  even after restart. Signing (HMAC with a per-terminal key from
  `safeStorage`) is **deferred to §A4** — if the future payments feature
  requests signing, 005 adds it at ratification time; until then the
  envelope is unsigned (the cart and payments features run in the same
  trust line within a single terminal, so cross-process tampering is not
  the threat model 005 owns).

- **R6. Discount-placeholder schema — RESOLVED: line-level only.**
  Consistent with Q2's per-line scope (LOCKED 2026-05-14: percentage of
  `line_subtotal_minor`, applied per-line). `discount_placeholders` is a
  separate table `cart_line_discount_placeholders` referenced by
  `(cart_id, line_id)`; zero-or-more placeholders per line; cart-level
  discounts are deferred to a future feature. The DiscountPlaceholder
  entity stores the placeholder *kind* (opaque token whose catalogue is
  owned by the future payments feature) and a `requires_manager_attribution`
  flag set true when the placeholder's magnitude exceeds the Q2 threshold.

- **R7. Item-catalogue resolution seam — RESOLVED per AD-5: stub seam
  with fixture-only resolver until a future item-catalogue feature lands.**
  `bridge.cart.resolveItemRef(item_ref)` returns
  `{ display_name, unit_price_minor, version }` on success or a generic
  refusal `{ kind: 'refused', reason: 'unknown_item' | 'disabled' |
  'no_connection' | 'generic' }`. The fixture-only resolver lives in
  test scope; production code paths refuse generically when no real
  catalogue is available. The seam contract is documented in
  [`contracts/bridge-api.md`](./contracts/bridge-api.md).

## Phase 1 — Design & Contracts

Phase 1 deliverables are authored in this PR (co-resident with `plan.md`).
Pointers below; each artifact is the source of truth for its surface.

- **[`data-model.md`](./data-model.md)** — entities `Cart`, `CartLine`,
  `DiscountPlaceholder`, `PaymentIntentEnvelope`. Three new SQLite tables
  described conceptually:

  - `carts` — header / lifecycle: `cart_id` (UUID v4), `tenant_id`,
    `branch_id`, `terminal_id`, `owning_operator_id` (Clerk-backed),
    `state` (`empty` / `editing` / `discount_pending_attribution` /
    `handing_off` / `frozen_handed_off` / `cancelled`), `cart_subtotal_minor`,
    `created_at`, `updated_at`, `frozen_at` nullable, `cancelled_at` nullable,
    `cancellation_reason` nullable ∈ {`cashier_voided`, `manager_voided_post_handoff`,
    `session_ended`}, `handoff_envelope_json` nullable (per R5),
    `last_action_id` (FK → `cart_action_outbox`). The `session_ended`
    reason is the Q3 (LOCKED 2026-05-14) discard path; the
    `cart.discarded_on_session_end` audit event is emitted alongside the
    transition.
  - `cart_lines` — per-line state: `line_id` (UUID v4), `cart_id` (FK →
    `carts`), `item_ref`, `display_name`, `quantity` (positive integer),
    `unit_price_minor` (integer), `line_subtotal_minor` (integer), `note`
    nullable (length ≤ **200 chars**, Q1 LOCKED 2026-05-14), `version`
    (monotonic integer per R2), `last_action_id` (FK → `cart_action_outbox`),
    `removed_at` nullable (soft-remove for audit continuity; `cart_lines`
    rows are NOT deleted on remove — they are soft-marked). **Per Q4
    (LOCKED 2026-05-14):** the bridge-side `cart.lines.add` handler MUST
    detect an existing non-removed line with the same `item_ref` on the
    same `cart_id` and merge (increment `quantity`, advance `version`)
    rather than insert a duplicate; uniqueness is enforced at the
    application layer (not by a SQL constraint, so that `removed_at`
    soft-marked lines can coexist with a later non-removed re-add).
  - `cart_action_outbox` — append-only action history: `action_id` (UUID
    v4), `cart_id` (FK → `carts`), `line_id` nullable (FK → `cart_lines`),
    `action_kind` (enum: `cart.create`, `cart.line.add`, `cart.line.update`,
    `cart.line.remove`, `cart.line.note_set`, `cart.line.merge` (Q4 path),
    `cart.discount_placeholder.add`, `cart.discount_placeholder.remove`,
    `cart.void`, `cart.handoff_to_payment`, `cart.cancel.post_handoff`,
    `cart.discount.above_threshold`, `cart.discarded_on_session_end`),
    `acting_operator_id` (Clerk-backed), `attribution_operator_id` nullable
    (Clerk-backed; for manager-attributed actions like discount-above-
    threshold and post-handoff cancel), `payload_json` (canonicalised
    serialisation of action input), `applied_at`, `synced_at` nullable
    (reserved for future backend sync; 005 does not run a sync). UPDATE /
    DELETE denied by trigger.

- **[`contracts/bridge-api.md`](./contracts/bridge-api.md)** — the new
  `cart.*` namespace. Handler list (final names; bridge handler stubs
  authored in S1):

  - `cart.create({ idempotency_key })` → `{ cart_id }` | refusal
  - `cart.lines.add({ cart_id, item_ref, quantity, idempotency_key })`
  - `cart.lines.update({ cart_id, line_id, quantity, version, idempotency_key })`
  - `cart.lines.remove({ cart_id, line_id, version, idempotency_key })`
    (sets `removed_at`; soft-remove)
  - `cart.lines.setNote({ cart_id, line_id, note, version, idempotency_key })`
  - `cart.discountPlaceholders.add({ cart_id, line_id?, token, idempotency_key })`
    (manager attribution required if magnitude exceeds threshold —
    threshold-check is bridge-side; the magnitude *interpretation* of the
    token is the payments feature's job, but 005 sees the magnitude class
    "above threshold yes/no" via a future seam similar to AD-5)
  - `cart.discountPlaceholders.remove(...)`
  - `cart.void({ cart_id, idempotency_key, reason })` (cashier voids own
    pre-handoff; manager voids post-handoff; bridge gates per role)
  - `cart.handoff({ cart_id, idempotency_key })` → `{ envelope }` | refusal
    (constructs envelope, freezes cart)
  - `cart.subscribe({ cart_id })` — optional, push-style updates for the
    `cartStore` to mirror

  Each handler's first executable instruction is `requireOperatorSession`
  (AD-1).

- **[`contracts/handoff-envelope.md`](./contracts/handoff-envelope.md)** —
  the immutable cross-feature payment-intent envelope shape (AD-2). This is
  the named contract surface the future payments feature consumes. Includes:

  - Field-by-field shape (verbatim list from AD-2).
  - Immutability guarantees (TypeScript `Readonly` + `Object.freeze` at
    construction; persisted JSON copy is by definition immutable).
  - Ratification protocol: the future payments feature owner must sign off
    on the shape before S4 of 005 merges (§A4).
  - Versioning: the envelope carries an `envelope_version` field (`'v1'`)
    so future revisions remain backward-compatible.

- **[`contracts/role-visibility-matrix-cart.md`](./contracts/role-visibility-matrix-cart.md)** —
  proposed additions to 004's role-visibility matrix for cart surfaces
  (this file is a **proposal-only** companion to 004's canonical matrix
  per NFR-009 / SC-008):
  - cart pane: visible to cashier, manager, admin
  - cart-mutating actions (add, update, remove, set-note, add-discount-
    below-threshold): cashier, manager, admin
  - discount-above-threshold: requires *manager attribution* (cashier
    initiates, manager approves at the prompt; both identities are recorded;
    manager attribution is the audit `acting_operator`)
  - cart void pre-handoff: cashier may void own cart; manager / admin may
    void any cart in branch
  - cart void post-handoff: manager / admin only (cashier-initiated post-
    handoff void is generically refused AND emits the post-handoff-attempt
    audit event)
  - handoff (cart freeze): cashier (the cart's `owning_operator_id`)
  - handoff envelope view (read-only) for support: manager / admin only

  **Deferred to 004 S5 review** — the matrix MUST be reviewed against the
  cashier-forbidden-information catalogue finalised in S5; conflicts require
  re-clarification (§A0 path 2 below).

- **[`quickstart.md`](./quickstart.md)** — reviewer's walkthrough for
  testing each user story independently after each slice.

## Phase 2 — Visual Direction (Slice 0)

**Mandated by 003 FR-033 inheritance. Non-code. Required before any of
Slices S1–S5 begin. Slice 0 itself is BLOCKED behind 004 S5 because the
cart-pane visibility rules are finalised there.**

### Deliverables (gated before any of Slices S1–S5 begin; slice S0 itself blocked behind 004 S5)

A reviewed contact sheet covering, at minimum, the following surfaces in
003-aligned design tokens (`comfortable` density, ≥ 1280 px expanded rail /
1024–1279 px icon-only rail, four-state connection visual, fixed role-
indicator slot from 004):

1. **Cart pane filling 003's reserved cart slot, default state.** Empty cart
   placeholder; cart pane affordance ("Add item", barcode-scan target —
   layout only; no scanner integration).
2. **Cart pane, populated state.** 1–N line-item rows; cart subtotal in
   integer minor units (label only — no tax / no tender breakdown);
   "Hand off to payment" button; "Void cart" button (cashier-attributed;
   visible only when cart has at least one line and is not yet handed off).
3. **Line-item row component.** Display name, quantity stepper (≥ 44 × 44
   CSS px per side; both buttons visible; keyboard arrow keys advance), unit
   price (integer minor units, formatted), line subtotal (integer minor
   units, formatted), note affordance, remove affordance.
4. **Quantity stepper.** Increment, decrement, decrement-to-zero (the
   decrement-to-zero affordance MAY be the same as decrement, with a brief
   confirm if the line note is non-empty). Layout only.
5. **Void confirmation dialog.** Generic copy; reason picker (fixed
   enumerated set per spec FR-equivalent — names finalised in spec); confirm
   + cancel. Cashier-self void pre-handoff: no manager prompt. Manager-
   attributed void post-handoff: requires manager-attribution prompt
   (deliverable 7 below).
6. **Manager-attribution prompt placeholder.** Generic copy ("This action
   needs a manager to approve"); manager identifier field + manager
   credential field (the credential is *Clerk*-backed for manager / admin
   per 004 — not the local PIN factor); confirm + cancel. **Layout only**;
   the actual attribution wiring is S3.
7. **Discount-placeholder row (line-level, per R6 default).** Generic
   "Discount applied" pill on the line; tap to remove (subject to manager
   attribution on remove if the original placeholder required manager
   attribution). Magnitude is **NOT** displayed at the cart layer in 005 —
   the payments feature owns that visualisation.
8. **Handoff summary surface.** Read-only display of the envelope's frozen
   line list, cart subtotal, frozen-at timestamp; "Continue to payment"
   button (no-op in 005; the payments feature owns post-handoff). Cart pane
   transitions to a clearly frozen visual once `frozen_handed_off`.

### Visual-direction review gate

The contact sheet must be reviewed (and the review recorded under
`specs/005-sales-cart/visual-direction/` post-§A0) against:

- 003's design tokens (color, spacing, typography, radius, shadow, density).
- 003's navigation rail behaviour.
- 003's connection-state visuals (cart pane respects offline / degraded
  banners; cart pane does NOT itself emit a connection-state visual).
- 004's role-indicator slot (cashier vs manager visual states; manager-
  attribution prompt MUST visually indicate which operator's credentials
  are being requested).
- The cashier-forbidden-information catalogue finalised in **004 S5**
  (which cart pane elements may be visible to a cashier; what shape the
  manager-attribution prompt takes; whether any cart-pane element must be
  hidden from cashier eyes entirely).
- Accessibility considerations: keyboard path through every surface, axe-
  rule cleanliness on default-state mocks, focus-ring visibility, ≥ 44 × 44
  CSS px floor on every interactive control.

**No implementation slice MAY merge before the Slice 0 review is complete
and recorded.** This is the FR-033 inheritance gate.

## Phase 3 — Implementation Slice Strategy

Each slice produces small reviewable PRs. Slice S0 above is non-code.
**`/speckit-plan` does NOT begin any slice.** Every slice listed below is
held on §A0; slices S1–S5 also hold on the gates listed in their row.

| Slice | Deliverable | Approval gates needed | Indicative test surface |
|:--|:--|:--|:--|
| **S0: Visual Direction** (non-code) | Contact sheet covering the 8 deliverables above; review recorded under `specs/005-sales-cart/visual-direction/`. | §A0 (load-bearing). | Review document is the artifact. |
| **S1: Cart bridge skeleton + `cart.*` namespace stubs + role gating + foundational store** | `cart.*` bridge namespace skeleton (typed, all handlers stubbed-and-role-gated; `requireOperatorSession` integrated per AD-1); `cartStore` 5-state machine (empty / editing / discount_pending_attribution / handing_off / frozen_handed_off); cart pane component shell that fills 003's reserved cart slot. **No persistence or arithmetic in S1.** | §A0; §A1 (item-catalogue seam stub agreed); §A4 (envelope shape **proposal** — full ratification at S4). | Bridge-surface unit tests (every `cart.*` handler refuses without active session). Renderer integration: cart pane renders, store transitions on bridge confirmation. Keyboard-path + axe-clean default + error states. |
| **S2: Cart-line CRUD + idempotency outbox + per-line subtotal arithmetic** | `carts`, `cart_lines`, `cart_action_outbox` migrations; cart-line CRUD bridge handlers (`add`, `update`, `remove`, `setNote`); idempotency-key plumbing (UUID v4 at intent); per-line subtotal arithmetic module (`src/main/cart/line-subtotal.ts`); cross-process redaction smoke extension (cart payload allowlist); also includes **bridge-surface security review** as the merge gate (mirroring 004 S2's pattern — produces `specs/005-sales-cart/security-review/s2-review.md`). | §A0; §A2 (migrations); §A1 (item-catalogue seam stub). | Per-line subtotal arithmetic ≥ 95 % coverage including overflow / non-integer / negative-quantity refusal paths. CRUD round-trip tests including restart-survives. Idempotency tests: same UUID twice → action applied once. Cross-process redaction smoke: `note` field redacted in logs; cart payloads not in Sentry. |
| **S3: Cart-level sensitive actions wired into 004's audit-event emitter** | `cart.void` bridge handler (cashier pre-handoff path; manager post-handoff path); `cart.discountPlaceholders.add` with manager-attribution prompt wiring (S3 contains the bridge handler; the manager-attribution UI was Slice S0 / S1 layout); audit-event categories `cart.void`, `cart.discount_applied_above_threshold`, `cart.line.removed_after_handoff_attempted` finalised + emitted into 004's existing emitter; redaction list extension for cart-action audit payloads. | §A0; §A3 (004 audit-catalogue extension PR — coordinates with 004 S5 close-out). | Audit-event shape tests for all three categories. Manager-attribution flow tests (cashier initiates, manager approves, both identities recorded). Post-handoff cashier-mutation refusal test (action refused + audit event emitted). Cross-tenant safeguards (a cart in tenant A is invisible to tenant B sessions). |
| **S4: Handoff envelope construction; freeze rule; emit handoff event** | `cart.handoff` bridge handler; `PaymentIntentEnvelope` type in `src/shared/cart/handoff-envelope.ts`; envelope construction logic (`Object.freeze` + persisted JSON copy per R5); cart freeze rule (`frozen_handed_off` state; bridge-side post-handoff mutation refusal with audit emission per S3); handoff audit event emitted. **Envelope shape ratified with future payments feature owner before merge** (§A4). | §A0; §A4 (envelope shape ratified by future payments feature owner). | Envelope immutability tests (every mutation attempt throws). Freeze-rule tests (cart in `frozen_handed_off` refuses every mutating bridge call generically + emits audit). Handoff idempotency: same `idempotency_key` twice → one envelope, one audit event. Round-trip: persist → restart → load envelope JSON from `carts.handoff_envelope_json` (read-only) for support bundle. |
| **S5: Final polish + cart pane fills 003's reserved slot** | Screenshot/contact-sheet review against S0; consistency fixes; cart pane visual finalisation (fills the 003 cart slot per layout-capacity decision); `docs/runbook/sales-cart.md`; `<!-- SPECKIT START -->` block update in `CLAUDE.md`. | §A0. | Smoke pass of all prior tests. axe-clean across all cart-pane variants. Keyboard-path full walkthrough. |

**Per-slice non-functional gates** (apply to every slice; mirrors 004):

- **Pre-merge screenshot/contact-sheet review** against S0 deliverables.
- **Pre-merge axe-clean** on default / loading / error variants (P14).
- **Pre-merge cross-process redaction smoke** must pass with the slice's
  diff applied (P7 / P11).
- **Pre-merge `npm test`, `npm run codegen:verify`, `npm run typecheck`,
  `npm run lint`** all pass.
- **No `git add -A`**, **no `--no-verify`**, **no scope creep beyond the
  slice's listed task IDs** (P13).

## Approval Gates

The following gates MUST be cleared *before* the indicated slices may
begin. Each gate is a small, named PR or coordination artifact; the plan
does not pre-write them. They exist so `/speckit-tasks` correctly schedules
blocking work.

### §A0. 005-blocking gate — 004 S4 closeout AND 004 S5 visibility boundaries (LOAD-BEARING)

**Description.** This is the load-bearing 005 gate. **004 S4** (cashier
sign-in via the local PIN unlock factor, takeover detection, audit-event
scaffolding) MUST close cleanly. **004 S5** (visibility boundaries — the
cashier-forbidden-information catalogue, the forced-close manager surface,
and the role-visibility matrix's final shape) MUST be reviewed and approved.
**§A0 is the body of this plan's BLOCKED status** — until §A0 lifts, no
implementation slice of 005 may begin, and `/speckit-tasks` MUST NOT be
invoked.

**Why both 004 S4 AND 004 S5?**

- **004 S4 closeout** is required because the cart layer attributes every
  action to an active operator session. Without S4, there is no cashier
  session to attribute to.
- **004 S5 visibility boundaries** is required because the cashier-
  forbidden-information catalogue directly determines:
  - which cart-pane elements may be visible to a cashier (e.g., a cashier
    might be forbidden from seeing per-line discount magnitudes — this
    constrains the line-item row layout in 005 S0);
  - which cart-mutating actions require manager attribution (e.g., post-
    handoff void's role-visibility matrix entry comes directly from the
    forbidden-information catalogue);
  - whether the manager-attribution prompt itself can name the manager's
    role / display name on the cashier's screen (a forbidden-information
    rule).

**Resolution paths:**

1. **004 S4 + S5 close cleanly → §A0 lifts automatically.** This is the
   default expected path. The plan can then move to `/speckit-tasks`.
2. **004 S5 produces a constraint that conflicts with 005's draft.** For
   example, if the cashier-forbidden-information catalogue restricts cart-
   mutation surfaces unexpectedly (e.g., cashier may not see line subtotals
   above some threshold without manager attribution), the parallel 005
   `spec.md` is **re-clarified** under `/speckit-clarify`, and this plan is
   revised. §A0 then re-evaluates.
3. **Project priorities shift.** 005 is **deferred indefinitely**. This
   plan stays as a draft; the spec-kit lifecycle places 005 in a paused
   state. (No code, no migrations, no artefacts beyond what is already
   written.)

**Blocks:** every slice (S0, S1, S2, S3, S4, S5). §A0 is the parent of
every other gate in this plan.

**Recommendation:** Path 1 (clean closeout). The 004 S4 work is in
progress; 004 S5 review is the next checkpoint after S4 closeout. No
preemptive action from the 005 side is needed until 004 surfaces the S5
review artifact.

### §A1. Cart-related backend / OpenAPI dependencies — future ticket

**Description.** 005 is local-first. The only backend touch-point a cart
action *might* require is **item-catalogue resolution** (AD-5), which is
owned by a future item-catalogue feature. **No 005-specific backend
endpoints are designed by this plan.** §A1 records that any backend
coordination needed for the item-catalogue seam is a future ticket whose
shape is determined by that future feature, not by 005.

**Resolution path.** When the item-catalogue feature lands (or its
coordinating backend ticket lands), the seam contract (AD-5) is finalised.
Until then, S1 + S2 use a fixture-only stub for testing; production code
paths refuse generically when no real catalogue is available.

**Blocks:** S1 (handler stubs need a typed seam) and S2 (handler real
implementation calls the seam). The block is on the *seam being typed*,
not on a real backend existing — a typed stub seam is sufficient.

### §A2. Migrations for `carts`, `cart_lines`, `cart_action_outbox`

**Description.** 005 introduces three new SQLite tables. User's hard-
exclusion list forbids "Do not change database migrations" in plan phase.

**Resolution path.** `/speckit-tasks` produces per-slice migration tasks;
migration files reviewed against `data-model.md` (FUTURE) and the
constitution P4 (append-only) constraints. `cart_action_outbox` is
append-only at the schema level (UPDATE/DELETE denied by trigger);
`cart_lines` uses soft-remove (`removed_at`) so historical line state
remains queryable for support-bundle export. Each migration ships in its
slice's PR.

**Blocks:** S2 (`cart_lines`, `cart_action_outbox`, plus the `carts` header).

### §A3. 004 audit-event catalogue extension

**Description.** S3 emits cart action categories (`cart.void`,
`cart.discount_applied_above_threshold`, `cart.line.removed_after_handoff_attempted`,
plus the action-kind enum landing in `cart_action_outbox`) into 004's
existing `audit_events` table. **The canonical category list is
finalised in 004 S5's close-out PR**, NOT in 005's plan. §A3 is the
coordination gate that ratifies the cart categories alongside 004's
S5 close-out.

**Resolution path.** 004 S5 close-out PR adds the 005-related category
names to 004's authoritative action-category enum. The 005 S3 PR depends
on this PR landing first. Coordination happens between the 004 S5 author
and the 005 S3 author at the time both are ready.

**Blocks:** S3.

### §A4. Handoff envelope shape ratified with the future payments feature owner

**Description.** The `PaymentIntentEnvelope` is the cross-feature contract
surface (AD-2). Its shape is ratified with the future payments feature
owner *before* S4 of 005 merges. Without ratification, S4 ships an
envelope shape the future payments feature might not consume — defeats
the contract.

**Resolution path.** The future payments feature owner reviews
`contracts/handoff-envelope.md` (FUTURE; produced as part of S1's bridge-
api stubs and refined in S4). They sign off on field-by-field shape,
versioning, and immutability guarantees. If the future payments feature
does not yet have an owner, S4 holds.

**Blocks:** S4 merge.

### §A5. Production Readiness gate (rollout PR)

**Description.** Constitution P15 names "cart" alongside "cashier login"
as production-affecting. The merge gate for the production-rollout PR
will require the Production Readiness subsection (below) to be present
AND the future payments feature to have reached its own §A5 — otherwise
carts can be opened but not paid.

**Blocks:** Production rollout, not slice merges. (S0–S5 may merge to
`main` behind a feature flag; rollout requires §A5 sign-off AND the
future payments feature's production readiness.)

## Test Strategy

Vitest is the single test runner (Constitution VI / Tech Stack v1.5.1).
Test shapes per slice:

- **Unit (renderer)**: every component in `src/renderer/ui/cart/` ships
  with a Vitest suite first; default / loading / error variants;
  keyboard path; axe-clean smoke. **Coverage gate ≥ 90 % on `cartStore`.**
- **Unit (main)**: every bridge handler in `src/main/cart/` covered:
  success path, no-active-session refusal, wrong-role refusal, wrong-
  owning-operator refusal, post-handoff refusal, invalid-input rejection,
  redaction. **Coverage gate ≥ 95 % on the bridge-side cart-action gate.**
- **Unit (arithmetic)**: per-line subtotal module covered exhaustively:
  positive integer × positive integer (success), zero-quantity (treated
  as remove; refused at this module — module assumes positive), overflow
  (refused with generic error), non-integer input (refused), negative
  input (refused). **Coverage gate ≥ 95 %** (load-bearing money rule;
  matches 001 `Money` and 004 PIN-verifier).
- **Integration (cross-process)**: extends 002's cross-process redaction
  smoke to cover `cart.*` payload allowlist refusals — `note` field
  length-cap + redaction; discount-placeholder token redaction; cart
  payloads NOT visible in Sentry events.
- **Integration (renderer)**: cart pane + `cartStore` covers session-
  ends-clears-cart-store (per Q3 / R3: discard immediately + emit
  `cart.discarded_on_session_end`), bridge-confirmation-required-before-
  optimistic-commit, role-mismatch refusals reflected in UI, cart restart-
  survival.
- **Contract tests**: per-bridge-call contract tests against the typed
  surface in `src/shared/bridge-api.ts`. Envelope contract tests against
  `src/shared/cart/handoff-envelope.ts`.
- **Negative tests** per spec: cross-tenant cart access produces generic
  refusal; post-handoff cashier mutation refused + audit event emitted;
  same idempotency key twice → action applied once; cart-pane elements
  forbidden by 004 S5 catalogue invisible to cashier (route-enumeration
  walkthrough automated for ≥ 10 access paths). Quantity stepper
  decrement-to-zero correctly removes the line (soft-remove).
- **Per-surface axe rule pass** on default / loading / error variants
  for every cart-pane component.

**No Playwright in this feature.** Acceptance scenarios testable at
Vitest + RTL + happy-dom level given bridge mocks.

## Production Readiness (P15)

Required before production rollout (gates §A5).

### Test plan

- All slice-level tests passing on CI (`windows-latest`).
- Manual reviewer walkthrough of cart lifecycle: empty → editing → adding
  N lines → setting per-line notes → applying discount placeholder (below
  threshold; cashier-attributed) → applying discount placeholder (above
  threshold; manager-attributed) → handoff → frozen state.
- Manual restart-survival scenario: open cart with 3 lines + 1 note + 1
  discount placeholder, kill the application (Task Manager), relaunch,
  cart re-opens for the same operator with all state intact.
- Manual void scenarios: (a) cashier voids own pre-handoff cart; (b)
  manager voids post-handoff cart; (c) cashier attempts to void post-
  handoff cart and is generically refused + audit event emitted.
- Manual cross-tenant scenario: cart created on terminal A (tenant 1) is
  invisible from terminal B (tenant 2) bridge calls.
- Support-bundle export with at least 50 cart action outbox entries; verify
  PII (`note` field) appears length-capped + redacted in logs; discount-
  placeholder tokens redacted to opaque references; no Clerk JWTs; no
  session tokens.

### Rollback strategy

- Each slice ships behind a feature flag readable from the existing 001
  configuration surface.
- Disabling the cart flag returns the application to the 003 + 004 post-
  sign-in shell with the cart pane reverting to its 003-era placeholder
  (003 FR-11).
- Database migrations are forward-only; rollback rolls back the feature
  flag, not the schema. The `carts`, `cart_lines`, `cart_action_outbox`
  tables are harmless to keep unused.
- **Rollback sequencing:** if the future payments feature is rolled back
  after 005 ships, 005 MUST also be rolled back to its feature-flag-off
  state (otherwise carts can be created but not handed off). The 005
  feature flag MUST be coupled to the payments feature flag in the
  rollout configuration.

### Support-runbook entry

- `docs/runbook/sales-cart.md` covers: "cashier reports the cart vanished
  after restart" (5 generic causes + diagnostic steps including outbox
  inspection); "discount-above-threshold prompt does not appear" (manager
  attribution wiring + role catalogue check); "post-handoff void rejected"
  (expected behaviour pre-payments-feature-rollout); "cart frozen but
  payments feature unavailable" (rollback coupling — see Rollback strategy);
  outbox-inspection procedure; idempotency-key tracing.

### Failure-mode catalogue

| Failure mode | User-visible | Recovery |
|:--|:--|:--|
| Operator session ends with open cart | per Q3 (LOCKED option (a)): cart discarded immediately; `cart.discarded_on_session_end` audit event emitted (queued offline if needed); cashier rebuilds the cart on next sign-in | no manager involvement required; rebuild on re-sign-in |
| Bridge refuses cart-mutating action (no active session) | generic refusal toast | sign in |
| Bridge refuses cart-mutating action (wrong role) | generic refusal toast | switch operator |
| Cart in `frozen_handed_off` and cashier attempts mutation | generic refusal + `cart.line.removed_after_handoff_attempted` audit event emitted | the post-handoff state is final from cart's perspective; manager void if needed |
| Per-line subtotal overflow | generic refusal at the bridge; line not added/updated | reduce quantity (UX hint deferred) |
| Item-catalogue seam refuses (`unknown_item`) | generic "cannot resolve item" toast | check SKU / catalogue feature |
| Item-catalogue seam refuses (`no_connection`) | generic "no connection — try again" banner | retry; offline catalogue resolution deferred to that future feature |
| `cart_action_outbox` write failure | bridge refuses the action; nothing applied (atomic) | retry |
| `carts.handoff_envelope_json` corrupted on disk | support-bundle export still works (raw outbox visible); cart cannot be re-shown post-handoff | manager void (post-handoff path) |
| Future payments feature unavailable | handoff produces envelope but payments feature does not consume it; cart stuck `frozen_handed_off` | manager void; rollback coupling (per Rollback strategy) |
| Idempotency-key collision (two distinct actions sent with same UUID — bug case) | first action wins; second is a no-op (idempotent semantic) | bug investigation via outbox inspection |

### Operational readiness

- Per-tenant rollout sequence agreed with the customer-success team; pilot
  pharmacy enables the flag for one branch first; full-tenant rollout after
  one week of pilot signal AND after the future payments feature has also
  pilot-rolled. Cart restart-survival behaviour and post-handoff void
  policy MUST be documented in customer-facing onboarding before the cart
  feature is enabled in any tenant.

## Project Structure

### Documentation (this feature) — descriptive

```text
specs/005-sales-cart/
├── spec.md                                  # §A0-cleared; Q1–Q5 locked 2026-05-14
├── plan.md                                  # This file (v1.0; co-resident with Phase 0/1 artifacts)
├── research.md                              # Phase 0 output — R1–R7 resolved
├── data-model.md                            # Phase 1 output — entities + three SQLite tables (conceptual)
├── quickstart.md                            # Phase 1 output — reviewer's walkthrough
├── contracts/
│   ├── bridge-api.md                        # cart.* preload bridge contract
│   ├── handoff-envelope.md                  # immutable cross-feature envelope shape
│   └── role-visibility-matrix-cart.md       # proposals against 004's matrix (NOT canonical)
├── tasks.md                                 # DRAFT — regenerated by `/speckit-tasks` (next step)
├── coordination.md                          # §A0 CLEARED 2026-05-14
├── checklists/                              # FUTURE — created at slice-PR time
├── visual-direction/                        # Slice S0 contact-sheet review (created in S0)
└── security-review/                         # Slice S2 P8 review notes (created in S2)
```

### Source Code (repository root) — descriptive, NOT authored by this draft

The implementation that would land across Slices S1–S5 (no source files
written in this phase):

```text
src/
├── main/
│   └── cart/                                # FUTURE — gated on §A0
│       ├── cart-bridge.ts                   # cart.* bridge handlers (AD-1)
│       ├── line-subtotal.ts                 # integer-minor-units arithmetic (AD-4; ≥95% coverage)
│       ├── handoff-envelope-builder.ts      # constructs frozen PaymentIntentEnvelope (AD-2)
│       ├── action-outbox.ts                 # P5 idempotency + append-only outbox writes
│       └── role-enforcement-cart.ts         # delegates to 004's role-enforcement.ts
├── preload/
│   └── cart.ts                              # FUTURE — cart.* preload exports
├── shared/
│   ├── bridge-api.ts                        # FUTURE — cart.* type contracts (extended)
│   └── cart/
│       └── handoff-envelope.ts              # FUTURE — PaymentIntentEnvelope type + Object.freeze
└── renderer/
    ├── ui/
    │   └── cart/                            # FUTURE — gated on §A0 + Slice S0 review
    │       ├── CartPane.tsx
    │       ├── LineItemRow.tsx
    │       ├── QuantityStepper.tsx
    │       ├── LineNotePopover.tsx
    │       ├── VoidConfirmation.tsx
    │       ├── DiscountPlaceholderRow.tsx
    │       ├── ManagerAttributionPrompt.tsx
    │       ├── HandoffSummary.tsx
    │       └── __tests__/
    └── stores/
        └── cart-store.ts                    # FUTURE — zustand 5-state machine

migrations/                                  # FUTURE — gated on §A2
├── NNN_carts.sql
├── NNN_cart_lines.sql
└── NNN_cart_action_outbox.sql

tests/                                       # FUTURE
├── contract/
│   ├── cart-bridge.contract.test.ts
│   └── handoff-envelope.contract.test.ts
├── integration/
│   ├── cart-pane.test.tsx
│   ├── cart-restart-survival.test.ts
│   └── cross-process-redaction-cart.test.ts # extended from 002 / 004
└── unit/                                    # per-component / per-handler suites
```

**Structure Decision**: Single project layout, mirroring 004. Trust-
boundary code in `src/main/cart/`, UI in `src/renderer/ui/cart/`, single
typed seam in `src/shared/bridge-api.ts` extended via the `cart.*`
namespace. The cross-feature contract surface lives in
`src/shared/cart/handoff-envelope.ts` (the only shared shape consumed by
the future payments feature). No new top-level packages.

## Complexity Tracking

| Item | Justification | Simpler alternative rejected because |
|:--|:--|:--|
| Cart-handoff envelope as a cross-feature contract surface (AD-2) | Without a named, immutable boundary, the future payments feature would either (a) consume live cart tables (couples two features tightly; mutation races) or (b) reconstruct cart state from the audit log (slow, error-prone). The envelope is the smallest possible contract that lets cart freeze cleanly and lets the payments feature consume a stable shape. | Live cart-table consumption: rejected — couples features, defeats the freeze rule. Audit-log reconstruction: rejected — too costly and fragile. |
| Cart sensitive actions reuse 004's audit emitter (AD-3) | Building a parallel audit substrate would duplicate append-only enforcement, idempotency, redaction, and support-bundle export work that 004 already lands. Re-using 004's emitter is the smallest possible delta to add cart-specific categories. | Parallel audit table: rejected per P12 / P16 (don't re-invent what 004 owns). Single-table merger of audit + outbox: rejected because the outbox is action-history (per-cart) and the audit table is cross-feature accountability — different consumers, different scopes. |
| Per-line subtotal arithmetic in integer minor units, owned by 005 (AD-4) | The cart UI must show line subtotals to the cashier in real time; deferring all subtotal arithmetic to the payments feature would require a bridge call per keystroke and couple the features tightly. Owning *only* per-line subtotal (not tax, not tender, not change) keeps 005's money surface minimal while honouring P1. | Defer all money math to payments feature: rejected — couples features and defeats local-first cart UX. Float arithmetic for "just" subtotals: forbidden by P1. |
| Three new SQLite tables (`carts`, `cart_lines`, `cart_action_outbox`) | Each answers a distinct durability requirement: `carts` is the lifecycle header (mutable state), `cart_lines` is the per-line current state (mutable, soft-remove), `cart_action_outbox` is the append-only action history (P4 + P5). Collapsing them creates schema-level coupling that hurts append-only enforcement on the outbox. | Single combined table: rejected — triggers that enforce append-only on the outbox would also constrain the mutable header / lines. |

---

**End of plan. ✅ APPROVED for `/speckit-tasks`.** §A0 (004 S4 closeout AND
004 S5 visibility boundaries) cleared 2026-05-14. Q1–Q5 clarifications
locked 2026-05-14 (Q1: 200 chars; Q2: percentage of `line_subtotal_minor`,
per-line, tenant-configurable value; Q3: discard immediately on session
end; Q4: merge by `item_ref` default; Q5: separate
`cart.discarded_on_session_end` audit event). Phase 0 (`research.md`) and
Phase 1 (`data-model.md`, `contracts/*`, `quickstart.md`) are co-resident
with this plan. **`/speckit-tasks` is the next Spec Kit step**;
implementation slices S0–S5 remain held behind their per-slice gates
(§A1–§A5 and Slice 0 visual-direction review).
