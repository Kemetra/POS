---
description: "Task list for 005-sales-cart — APPROVED, slice-organised, §A0 CLEARED 2026-05-14, S4 complete 2026-05-17, S5-b (T097-T099) complete 2026-05-17, T096 complete 2026-05-18, T100 complete 2026-05-19"
---

# Tasks: 005-sales-cart

> 🔁 **RT-28 amendment (2026-09-27): discount tasks are HISTORICAL.** T059–T062, T065, T068, T069, T072–T074 and every "below/above threshold" discount step in this file implement the superseded Q2 threshold rule: cashier below-threshold adds, a renderer-supplied approver id, manager-gated removal, and `cart.discount.above_threshold` emission. Do **not** derive implementation or regression tests from them. The replacement rule is [`spec.md`](spec.md) Amendment + FR-023 (revised), [`contracts/bridge-api.md`](contracts/bridge-api.md) and [`contracts/handoff-envelope.md`](contracts/handoff-envelope.md) step 3a. Replacement work is the RT-28 Implementation Jira item.


**Feature:** 005-sales-cart — Sales Cart
**Spec:** [./spec.md](./spec.md) (`§A0 CLEARED` — Q1–Q5 locked 2026-05-14)
**Plan:** [./plan.md](./plan.md) (v1.0 APPROVED 2026-05-14)
**Research:** [./research.md](./research.md)
**Data model:** [./data-model.md](./data-model.md)
**Contracts:** [./contracts/bridge-api.md](./contracts/bridge-api.md) · [./contracts/handoff-envelope.md](./contracts/handoff-envelope.md) · [./contracts/role-visibility-matrix-cart.md](./contracts/role-visibility-matrix-cart.md)
**Quickstart:** [./quickstart.md](./quickstart.md)
**Coordination:** [./coordination.md](./coordination.md)
**Visual direction:** [./visual-direction/README.md](./visual-direction/README.md) (produced in S0)
**Constitution version pinned:** v1.5.1
**Created:** 2026-05-09
**Last updated:** 2026-05-19 (T100 complete — headed Electron walkthrough passed; SQLite evidence verified; UI polish deferred to a future dedicated Impeccable/UI slice)
**Status:** ✅ APPROVED — ready for implementation behind per-slice gates

---

> ✅ **§A0 CLEARED — 2026-05-14.**
> 004 S4 closeout ✅ (PR #124, 2026-05-11). 004 S5 visibility
> boundaries ✅ (T083–T093 merged; main SHA `d247e8a`, 2026-05-14).
> Q1–Q5 clarifications locked 2026-05-14.
> **Tasks below are the authoritative executable list.**
> Implementation slices remain held on their **per-slice gates only**
> (§A2, §A3, §A4, §A5 as noted per task). §A0 no longer blocks any task.

---

## Locked decisions (informational — do not re-open)

| Decision | Locked value |
|:--|:--|
| Q1 — item-note max length | **200 characters** |
| Q2 — discount-attribution threshold | **percentage of `line_subtotal_minor`, per-line; numeric value is tenant-configurable** |
| Q3 — cart-stale-on-session-end | **option (a): discard immediately on session end** |
| Q4 — duplicate-add line-merge rule | **merge by `item_ref` (default); "force separate line" deferred** |
| Q5 — offline-cart audit event | **`cart.discarded_on_session_end`** (4th category in 004's audit catalogue) |

**Canonical audit action categories** (4; superseding all earlier working-title drafts):
`cart.handoff_to_payment` · `cart.cancel.post_handoff` · `cart.discount.above_threshold` · `cart.discarded_on_session_end`

**Bridge handler canonical names** (from `contracts/bridge-api.md`):
`cart.create` · `cart.lines.add` · `cart.lines.update` · `cart.lines.remove` · `cart.lines.setNote` · `cart.discountPlaceholders.add` · `cart.discountPlaceholders.remove` · `cart.void` · `cart.handoff` · `cart.subscribe`

**Four SQLite tables** (in migration order per `data-model.md §Migration ordering`):
1. `carts` 2. `cart_action_outbox` 3. `cart_lines` 4. `cart_line_discount_placeholders`

**Cart FSM states** (6): `empty` → `editing` → `discount_pending_attribution` ↔ `editing` → `handing_off` → `frozen_handed_off` · any → `cancelled`

---

## Format

```text
- [ ] T### [P?] [US?] Description — `file/path/here`
```

- `[ ]` = unchecked (every implementation task starts unchecked)
- `[P]` = parallelizable with other `[P]` tasks in the same phase (independent files, no shared state)
- `[US1]` / `[US2]` / `[US3]` = user-story trace (see spec.md):
  - **US1** = Build a draft cart (P1 — cart CRUD + idempotency + persistence)
  - **US2** = Cancel a cart with attribution (P2 — void + manager attribution + audit)
  - **US3** = Hand off to the future payment feature (P3 — handoff envelope + freeze rule)
- Gate suffixes where a slice-specific gate still applies: **(§A2)**, **(§A3)**, **(§A4)**

Per **Constitution VI**, every implementation task is preceded by its TDD test task(s).
Test tasks carry the same `[US?]` label as their implementation counterpart.

---

## Approval gates — current status

| Gate | Status | Blocks |
|:--|:--:|:--|
| §A0 — 004 S4 closeout + S5 visibility (LOAD-BEARING) | ✅ **CLEARED 2026-05-14** | ~~all slices~~ — cleared |
| §A1 — item-catalogue seam (stub sufficient for S1+S2; production catalogue deferred) | ⏳ **deferred** | S1+S2 unblocked via fixture stub (R7); real catalogue is a future feature |
| §A2 — migrations for all 4 cart tables | ✅ **CLEARED 2026-05-14** | ~~S2~~ — complete |
| §A3 — 004 `ActionCategory` enum extended with 4 cart categories | ✅ **CLEARED 2026-05-15** | ~~S3~~ — complete |
| §A4 — `PaymentIntentEnvelope` shape ratified with future payments owner | ✅ **CLEARED 2026-05-17** | ~~S4 merge~~ — complete |
| §A5 — production readiness gate | ⏳ **rollout-time** | production rollout only (not slice merges) |

**Bottom line:** S0, S1, S2, S3, S4 complete. §A4 cleared 2026-05-17. S4 merged via PR #162 (T076–T088, T091) + PR #163 (T089–T090) on 2026-05-17. **S5-a (T092–T095, a11y + shell-slot tests) complete via PR #166 on 2026-05-17. S5-b (T097–T099, redaction smoke + runbook/onboarding docs) complete via PRs #168–#169 on 2026-05-17. T096 (visual review) ✅ complete 2026-05-18 — PR #171 artifact + PR #172 Dev1/Dev2/Dev3 fixes verified on main. T100 (quickstart walkthrough) ✅ complete 2026-05-19 — headed Electron + SQLite evidence passed. T100 sign-off is functional, not final UI polish; UI polish deferred to a future dedicated Impeccable/UI slice. Real production item catalogue remains future work; dev fixture resolver was used for T100.** S5 is now complete. T101/T102 not started. Production rollout still waits on §A5.

---

## Path conventions

| Layer | Path |
|:--|:--|
| Main-process cart module | `src/main/cart/` |
| Shared types + bridge API | `src/shared/bridge-api.ts` · `src/shared/cart/` |
| Preload bridge | `src/preload/cart.ts` |
| Renderer cart UI | `src/renderer/ui/cart/` |
| Renderer store | `src/renderer/stores/cart-store.ts` |
| Migrations | `migrations/` |
| Unit tests (main) | `tests/unit/main/cart/` |
| Unit tests (shared) | `tests/unit/shared/cart/` |
| Unit tests (renderer) | `tests/unit/renderer/` |
| Integration tests | `tests/integration/` |
| Contract tests | `tests/contract/` |
| Runbook | `docs/runbook/` |
| Spec docs | `specs/005-sales-cart/` |

---

## Phase 1 — Setup & Coordination (no source code)

**Purpose:** Lock the S0 visual-direction review gate, confirm §A3 and §A4 coordination
owners, and record the feature-flag configuration. No code, no migrations, no packages.
**Startable immediately** — §A0 is cleared.

- [X] T001 Confirm the `cart` feature flag exists in 001's configuration surface and is disabled by default; record the flag key in `specs/005-sales-cart/coordination.md` — `specs/005-sales-cart/coordination.md`
- [x] T002 [P] Open the §A3 coordination thread: confirm 004's `ActionCategory` discriminated union (`src/shared/audit/event-shape.ts`) will be extended with the 4 canonical cart categories before S3 begins; record outcome in `specs/005-sales-cart/coordination.md` — `specs/005-sales-cart/coordination.md`
- [x] T003 [P] Open the §A4 coordination thread: confirm the future payments-feature owner will review `contracts/handoff-envelope.md` and sign off before S4 merges; record outcome in `specs/005-sales-cart/coordination.md` — `specs/005-sales-cart/coordination.md`
- [x] T004 [P] Assign the S0 visual-direction reviewer; record name + expected review date in `specs/005-sales-cart/coordination.md` — `specs/005-sales-cart/coordination.md`
- [x] T005 Update `specs/005-sales-cart/coordination.md` to reflect `/speckit-tasks` completion and the current gate status table — `specs/005-sales-cart/coordination.md`

**Phase 1 exit:** T001–T005 ticked. Feature flag confirmed. §A3/§A4 coordination owners identified. S0 reviewer assigned.

---

## Phase 2 — Foundational (shared types + bridge skeleton + FSM)

**Purpose:** Establish the typed `cart.*` bridge surface, the 6-state FSM type, the
`PaymentIntentEnvelope` type, and `requireOperatorSession` wiring — all as stubs.
No persistence, no arithmetic in this phase. **Startable immediately** — no gate beyond §A0.

Per Constitution VI, tests are written first.

### Phase 2 — Tests

- [X] T006 [P] [US1] Write unit test: `CartState` enum covers exactly 6 states (`empty`, `editing`, `discount_pending_attribution`, `handing_off`, `frozen_handed_off`, `cancelled`); FSM transition table rejects all illegal transitions — `tests/unit/shared/cart/cart-state.test.ts`
- [X] T007 [P] [US3] Write unit test: `PaymentIntentEnvelope` shape carries all v1 fields from `contracts/handoff-envelope.md`; `Object.isFrozen(envelope)` returns true after construction; integer-only `subtotal_minor` and `line_subtotal_minor` fields — `tests/unit/shared/cart/handoff-envelope.test.ts`
- [X] T008 [P] [US1] Write contract test: every handler in the `cart.*` bridge namespace type-checks against the canonical request/response shapes in `contracts/bridge-api.md`; no `any` — `tests/contract/cart-bridge.contract.test.ts`
- [X] T009 [P] [US1] Write unit test: `requireOperatorSession` called as first instruction in every `cart.*` handler stub; no-session path returns `{ kind: 'refused', reason: 'no_session' }`; wrong-role path returns `{ kind: 'refused', reason: 'role_denied' }` — `tests/unit/main/cart/cart-role-gating.test.ts`
- [X] T010 [P] [US1] Write unit test: `cartStore` FSM transitions — `empty→editing` on first add, `editing→handing_off` on handoff initiation, `frozen_handed_off` and `cancelled` are terminal (any mutation attempt returns generic refusal without state change) — `tests/unit/renderer/stores/cart-store.test.ts`

### Phase 2 — Implementation

- [X] T011 [P] [US1] Create `CartState` enum and FSM transition table — `src/shared/cart/cart-state.ts`
- [X] T012 [P] [US3] Create `PaymentIntentEnvelope` type (`Readonly<>` end-to-end) and `freezeEnvelope(envelope)` helper applying `Object.freeze` recursively — `src/shared/cart/handoff-envelope.ts`
- [X] T013 [P] [US1] Extend `src/shared/bridge-api.ts` with the typed `cart.*` namespace skeleton: all 10 handlers stubbed with canonical request/response types from `contracts/bridge-api.md`; no `any` — `src/shared/bridge-api.ts`
- [X] T014 [US1] Create `requireOperatorSession` cart wrapper delegating to `src/main/operator/role-enforcement.ts`; covers all 6 refusal conditions from `contracts/bridge-api.md §Bridge gating` — `src/main/cart/require-operator-session.ts`
- [X] T015 [US1] Create `cartStore` zustand slice: 6-state FSM, active cart ref, line list, in-flight handoff state; mirrors bridge-confirmed state only (no optimistic transitions per AD-1 / P2) — `src/renderer/stores/cart-store.ts`
- [X] T016 [P] [US1] Create preload cart bridge exports (stubs; each delegate immediately to the main-process handler) — `src/preload/cart.ts`

**Phase 2 exit:** Bridge namespace compiles end-to-end; `requireOperatorSession` wiring verified; `cartStore` FSM transitions tested; `PaymentIntentEnvelope` type frozen by construction.

---

## Phase 3 — Slice S0: Visual Direction (non-code)

**Purpose:** Produce and record the contact-sheet review mandated by spec A7 / FR-033 inheritance. Non-code. **Must complete before any of S1–S5 begin.** Startable immediately — §A0 cleared; reviewer assigned in T004.

- [x] T017 Produce S0 contact sheet covering all 8 surfaces from `plan.md §Phase 2 — Visual Direction`: empty cart pane, populated cart pane, line-item row, quantity stepper, void confirmation dialog, manager-attribution prompt placeholder, discount-placeholder row, handoff summary surface — `specs/005-sales-cart/visual-direction/contact-sheet.md`
- [x] T018 Review contact sheet against 003 design tokens (`src/renderer/ui/tokens/`), 003 navigation-rail behaviour, 003 connection-state visuals, 004's role-indicator slot, and the cashier-forbidden-information catalogue from `specs/004-operator-session/contracts/role-visibility-matrix.md` — `specs/005-sales-cart/visual-direction/review-record.md`
- [x] T019 Record the review outcome and the reviewer's sign-off in `specs/005-sales-cart/visual-direction/review-record.md`; cite any required changes to the contact sheet — `specs/005-sales-cart/visual-direction/review-record.md`

**S0 exit:** Review record signed off. Every S1+ PR must cite the S0 review record in its description (FR-033 gate).

---

## Phase 4 — Slice S1: Cart bridge skeleton + role gating + CartPane shell

**Purpose:** Implement all `cart.*` bridge handlers (role-gated, fully stubbed — no persistence, no arithmetic). Render the CartPane shell in 003's reserved cart slot. **Gate: S0 review complete + Phase 2 complete.**

### Phase 4 — Tests

- [X] T020 [P] [US1] Write unit test: `cart.create` succeeds for `cashier`, `manager`, `admin`; returns `{ kind: 'refused', reason: 'no_session' }` when signed out — `tests/unit/main/cart/cart-create.test.ts`
- [X] T021 [P] [US1] Write unit test: `cart.lines.add` with valid session returns `{ kind: 'ok' }`; wrong-owner path returns `{ kind: 'refused', reason: 'wrong_owner' }`; tenant-mismatch returns `{ kind: 'refused', reason: 'tenant_isolation' }` — `tests/unit/main/cart/cart-lines-add.test.ts`
- [X] T022 [P] [US1] Write integration test: CartPane renders in 003's reserved cart slot when operator signed in; pane is absent when signed out; keyboard-focusable entry point exists — `tests/integration/renderer/ui/cart/cart-pane-mount.test.tsx`
- [X] T023 [P] [US1] Write integration test: sign-out while cart is open → `cartStore` transitions to `cancelled` and cart pane reflects cleared state (Q3 policy: discard immediately) — `tests/integration/renderer/stores/cart-signout-clears-store.test.ts`
- [X] T024 [P] [US1] Write cross-process redaction smoke (cart extension): no `cart.*` payload field matching the cart payload allowlist (PII, card data, credential fragments) appears in `pino` logs, Sentry events, or test snapshots — `tests/integration/cross-process-redaction-cart.test.ts`

### Phase 4 — Implementation

- [X] T025 [US1] Implement `cart.create` bridge handler: `requireOperatorSession` first; create `carts` row in-memory; return `{ kind: 'ok', cart_id }` — `src/main/cart/cart-bridge.ts`
- [X] T026 [US1] Implement all remaining `cart.*` handler stubs in the same file (role-gated, return `{ kind: 'refused', reason: 'not_implemented' }` for persistence paths not yet wired) — `src/main/cart/cart-bridge.ts`
- [X] T027 [P] [US1] Implement `CartPane` component shell (empty-state + building-state placeholders per S0 contact sheet; fills 003's reserved cart slot) — `src/renderer/ui/cart/CartPane.tsx`
- [X] T028 [P] [US1] Implement `EmptyCartPlaceholder` component per S0 contact sheet — `src/renderer/ui/cart/EmptyCartPlaceholder.tsx`
- [X] T029 [US1] Wire `cart.create` and stub handlers in preload; extend pino redaction list for cart payload allowlist refusals (do not log offending field value) — `src/preload/cart.ts`, `src/main/logger/redaction.ts`

**S1 exit (quickstart §US1 step 1–2 pass):** Signed-in cashier sees CartPane in 003's shell slot; `cart.create` succeeds; sign-out clears the store; redaction smoke passes.

---

## Phase 5 — Slice S2: Cart-line CRUD + idempotency outbox + per-line arithmetic

**Purpose:** Ship durable cart-line CRUD, the 4-table migration set, the `cart_action_outbox` idempotency key, and the per-line subtotal arithmetic module (integer minor units, ≥95% coverage). **Gate: S1 merged + §A2 (4-table migration review).**

### Phase 5 — Tests

- [X] T030 [P] [US1] Write unit test: `line-subtotal` module — `quantity × unit_price_minor` in integer minor units; overflow refused (`Number.isSafeInteger` guard); non-integer input refused; negative quantity refused; ≥95% branch coverage required — `tests/unit/main/cart/line-subtotal.test.ts`
- [X] T031 [P] [US1] Write unit test: `cart.lines.add` — new-line path writes `carts` + `cart_lines` + `cart_action_outbox` (action_kind `cart.line.add`) in a single transaction; cart transitions `empty→editing` on first add — `tests/unit/main/cart/cart-lines-add-persist.test.ts`
- [X] T032 [P] [US1] Write unit test: `cart.lines.add` **Q4 merge path** — add `item_ref=X qty=2`, then add `item_ref=X qty=3`; result is one line with `quantity=5`, `version` advanced by 1, outbox row `action_kind=cart.line.merge`; no duplicate line — `tests/unit/main/cart/cart-lines-add-merge.test.ts`
- [X] T033 [P] [US1] Write unit test: `cart.lines.update` — increment, decrement, set absolute; stale-`version` returns `{ kind: 'refused', reason: 'stale_version' }`; `set(0)` delegates to `cart.lines.remove` — `tests/unit/main/cart/cart-lines-update.test.ts`
- [X] T034 [P] [US1] Write unit test: `cart.lines.remove` — soft-sets `removed_at`; row is NOT hard-deleted; replay with same `idempotency_key` is a no-op (FR-018); stale `version` refused — `tests/unit/main/cart/cart-lines-remove.test.ts`
- [X] T035 [P] [US1] Write unit test: `cart.lines.setNote` — note ≤200 chars accepted; note >200 chars refused with `{ kind: 'refused', reason: 'note_too_long' }`; partial overwrite MUST NOT occur; forbidden-pattern match refused with `note_forbidden_pattern`; stale `version` refused — `tests/unit/main/cart/cart-lines-set-note.test.ts`
- [X] T036 [P] [US1] Write integration test: `cart_action_outbox` append-only invariant — schema-level `UPDATE` and `DELETE` refused by SQL trigger (mirrors 004's `audit_events` trigger); confirmed via raw SQL in test — `tests/integration/main/cart/cart-action-outbox-append-only.test.ts`
- [X] T037 [P] [US1] Write integration test: idempotency replay — same `idempotency_key` + same payload submitted twice → one row in `cart_action_outbox`, original outcome returned; same `idempotency_key` + different payload → `{ kind: 'refused', reason: 'idempotency_payload_mismatch' }` — `tests/integration/main/cart/cart-action-outbox-idempotency.test.ts`
- [X] T038 [P] [US1] Write integration test: cart draft survives application restart — build a cart with 2 lines + 1 note; simulate restart; reopen; same lines, same `version` tokens, same note (FR-028) — `tests/integration/main/cart/cart-restart-survival.test.ts`
- [X] T039 [P] [US1] Write integration test: tenant isolation — `cart.lines.add` with `cart_id` belonging to tenant T1 refused by a session scoped to tenant T2 with `{ kind: 'refused', reason: 'tenant_isolation' }` — `tests/integration/main/cart/cart-tenant-isolation.test.ts`

### Phase 5 — Implementation (§A2 gated)

- [X] T040 [US1] Author migration for `carts` table per `data-model.md §Entity: Cart` (first in FK order; no outbound FKs to cart tables) — `migrations/` **(§A2)**
- [X] T041 [US1] Author migration for `cart_action_outbox` table per `data-model.md §Entity: CartActionOutbox`; install append-only trigger (`UPDATE`/`DELETE` denied); FK → `carts` — `migrations/` **(§A2)**
- [X] T042 [US1] Author migration for `cart_lines` table per `data-model.md §Entity: CartLine`; FK → `carts`, FK → `cart_action_outbox`; `removed_at` nullable for soft-remove — `migrations/` **(§A2)**
- [X] T043 [US1] Author migration for `cart_line_discount_placeholders` table per `data-model.md §Entity: CartLineDiscountPlaceholder`; FK → `carts`, FK → `cart_lines` — `migrations/` **(§A2)**
- [X] T044 [US1] Implement `line-subtotal` pure function: `quantity × unit_price_minor` integer arithmetic; `Number.isSafeInteger` guard on result; refuses negative/non-integer inputs with generic error — `src/main/cart/line-subtotal.ts`
- [X] T045 [US1] Implement `cart.lines.add` handler: `requireOperatorSession`; R7 seam call (`cart.resolveItemRef`) for `display_name` + `unit_price_minor`; Q4 merge detection (application-layer uniqueness on `(cart_id, item_ref)` among non-removed rows); write `cart_lines` + `cart_action_outbox` in single transaction; idempotency check first — `src/main/cart/cart-bridge.ts`
- [X] T046 [US1] Implement `cart.lines.update` handler: `requireOperatorSession`; version check; `op` dispatch (`increment`/`decrement`/`set`); `set(0)` delegates to remove logic; recompute `line_subtotal_minor` via `line-subtotal`; write outbox `cart.line.update` — `src/main/cart/cart-bridge.ts`
- [X] T047 [US1] Implement `cart.lines.remove` handler: `requireOperatorSession`; version check; soft-set `removed_at`; write outbox `cart.line.remove`; idempotency replay is no-op — `src/main/cart/cart-bridge.ts`
- [X] T048 [US1] Implement `cart.lines.setNote` handler: `requireOperatorSession`; length cap (200 chars); forbidden-pattern check; version check; write `cart_lines.note` + outbox `cart.line.note_set` — `src/main/cart/cart-bridge.ts`
- [X] T049 [P] [US1] Implement `LineItemRow` component: `display_name`, `QuantityStepper` (≥44×44 CSS px per button), `unit_price_minor` formatted, `line_subtotal_minor` formatted, note affordance, remove affordance per S0 contact sheet — `src/renderer/ui/cart/LineItemRow.tsx`
- [X] T050 [P] [US1] Implement `QuantityStepper` component: increment / decrement / decrement-to-zero (decrement-to-zero shows confirm if note is non-empty); keyboard arrow-key support; ≥44×44 CSS px — `src/renderer/ui/cart/QuantityStepper.tsx`
- [X] T051 [P] [US1] Implement `LineNotePopover` component: free-text input, 200-char limit enforced client-side as UX nicety (bridge is authoritative); forbidden-pattern refusal surfaced as generic "note rejected" — `src/renderer/ui/cart/LineNotePopover.tsx`
- [X] T052 [US1] Extend `CartPane` to render live line list using `LineItemRow`; cart subtotal in integer minor units (label only; no tax/tender); wire `cart.lines.add`, `cart.lines.update`, `cart.lines.remove`, `cart.lines.setNote` bridge calls — `src/renderer/ui/cart/CartPane.tsx`
- [X] T053 [P] [US1] Implement R7 seam stub (`cart.resolveItemRef`) returning a known fixture SKU set for tests; production code path refuses generically when no real catalogue available — `src/main/cart/resolve-item-ref.ts`
- [X] T054 [US1] Extend pino redaction list: `cart_lines.note` content, forbidden-pattern fragments, `payload_json` of outbox rows — defence-in-depth (cart payload allowlist at bridge boundary is primary gate) — `src/main/logger/redaction.ts`

**S2 security-review gate:** Before S2 merges, produce `specs/005-sales-cart/security-review/s2-review.md` — line-by-line diff walk of the bridge surface expansion (mirrors 004 S2 pattern). Gate blocks S2 PR merge.

**S2 exit (quickstart §US1 steps 3–8 pass):** Add/merge/increment/decrement/remove/setNote all durable; restart-survival confirmed; idempotency replay confirmed; Q4 merge produces one line; ≥95% arithmetic coverage; append-only trigger verified; redaction smoke green.

---

## Phase 6 — Slice S3: Sensitive actions + audit emission + session-end discard

**Purpose:** Wire `cart.void` (pre- and post-handoff paths), `cart.discountPlaceholders.add/remove` (above-threshold manager attribution), and the session-end discard handler. All four canonical cart audit categories emitted into 004's existing `audit_events` emitter. **Gate: S2 merged + §A3 (`ActionCategory` enum extended with 4 cart categories).**

### Phase 6 — Tests

- [x] T055 [P] [US2] Write unit test: `cart.void` pre-handoff — cart transitions to `cancelled`; `cancellation_reason = 'cashier_voided'`; outbox row `action_kind = cart.void`; NO `audit_events` row emitted (non-sensitive per FR-031) — `tests/unit/main/cart/cart-void-pre-handoff.test.ts`
- [x] T056 [P] [US2] Write unit test: `cart.void` post-handoff (cashier-initiated) — refused with `{ kind: 'refused', reason: 'manager_attribution_required' }` (FR-032); cart stays in `frozen_handed_off` — `tests/unit/main/cart/cart-void-post-handoff-cashier.test.ts`
- [x] T057 [P] [US2] Write unit test: `cart.void` post-handoff (manager-attributed) — cart transitions to `cancelled`; `cancellation_reason = 'manager_voided_post_handoff'`; `audit_events` row emitted with `action_category = cart.cancel.post_handoff`; five mandatory FR-026 attributes present; partial record MUST NOT persist — `tests/unit/main/cart/cart-void-post-handoff-manager.test.ts`
- [x] T058 [P] [US2] Write unit test: `cancelled` cart refuses every mutating bridge call generically (`{ kind: 'refused', reason: 'closed' }`) — `tests/unit/main/cart/cart-cancelled-frozen.test.ts`
- [x] T059 [P] [US1] Write unit test: `cart.discountPlaceholders.add` below-threshold — cashier/manager/admin allowed; writes `cart_line_discount_placeholders` row; outbox `cart.discount_placeholder.add`; no audit emission — `tests/unit/main/cart/cart-discount-add-below.test.ts`
- [x] T060 [P] [US1] Write unit test: `cart.discountPlaceholders.add` above-threshold without attribution — refused with `{ kind: 'refused', reason: 'manager_attribution_required' }` — `tests/unit/main/cart/cart-discount-add-above-no-attr.test.ts`
- [x] T061 [P] [US1] Write unit test: `cart.discountPlaceholders.add` above-threshold with manager attribution — accepted; `requires_manager_attribution = true`; `audit_events` row emitted with `action_category = cart.discount.above_threshold`; manager identity in `attribution_operator_id` — `tests/unit/main/cart/cart-discount-add-above-attr.test.ts`
- [x] T062 [P] [US1] Write unit test: `cart.discountPlaceholders.remove` above-threshold placeholder requires manager attribution (mirrors add rule) — `tests/unit/main/cart/cart-discount-remove.test.ts`
- [x] T063 [P] [US2] Write unit test: session-end discard — simulated session-end event → draft cart in `editing` transitions to `cancelled`; `cancellation_reason = 'session_ended'`; outbox row `action_kind = cart.discarded_on_session_end`; `audit_events` row emitted with `action_category = cart.discarded_on_session_end` (Q3+Q5 locked) — `tests/unit/main/cart/cart-session-end-discard.test.ts`
- [x] T064 [P] [US2] Write integration test: `cart.void` audit record carries all five FR-026 mandatory attributes (`acting_operator_id`, `operator_session_id`, `terminal_id`, `applied_at`, `action_category`); partial record MUST NOT persist (atomic write) — `tests/integration/main/cart/cart-void-audit-completeness.test.ts`
- [x] T065 [P] [US2] Write integration test: above-threshold discount — cashier initiates; manager-attribution prompt wired; on manager approval: discount placeholder applied + `cart.discount.above_threshold` audit event emitted; on manager cancel: no placeholder, no audit event — `tests/integration/renderer/cart/discount-above-threshold-flow.test.tsx`
- [x] T066 [P] [US2] Write integration test: `audit_events` append-only invariant for cart-emitted rows — raw SQL `UPDATE`/`DELETE` refused by 004's existing trigger; confirmed via cross-feature regression — `tests/integration/main/cart/cart-audit-append-only.test.ts`

### Phase 6 — Implementation (§A3 gated)

- [x] T067 [US2] Implement `cart.void` handler: `requireOperatorSession`; state-gate (pre-handoff: any role; post-handoff: manager/admin + `attribution_operator_id` required); FSM transition → `cancelled`; set `cancellation_reason`; outbox write; conditional audit emission per FR-031/FR-033 — `src/main/cart/cart-bridge.ts` **(§A3)**
- [x] T068 [US1] Implement `cart.discountPlaceholders.add` handler: `requireOperatorSession`; threshold check vs tenant config; below-threshold: write `cart_line_discount_placeholders` + outbox; above-threshold without attribution: refuse; above-threshold with attribution: write + emit `cart.discount.above_threshold` audit event — `src/main/cart/cart-bridge.ts` **(§A3)**
- [x] T069 [US1] Implement `cart.discountPlaceholders.remove` handler: `requireOperatorSession`; check original `requires_manager_attribution`; manager attribution required if true; write removal + conditional audit — `src/main/cart/cart-bridge.ts` **(§A3)**
- [x] T070 [US2] Implement session-end discard subscriber: subscribe to 004's session-end emitter; transactionally look up draft cart for session; if found → transition `state→cancelled`, `cancellation_reason='session_ended'`, write outbox + emit `cart.discarded_on_session_end` audit event; session-end MUST NOT block on cart discard (queued in local outbox if write fails partially, Q5) — `src/main/cart/session-end-handler.ts` **(§A3)**
- [x] T071 [P] [US2] Implement `VoidConfirmation` dialog component per S0 contact sheet: generic copy; reason picker; confirm + cancel; cashier pre-handoff path (no manager prompt); manager post-handoff path triggers manager-attribution prompt — `src/renderer/ui/cart/VoidConfirmation.tsx`
- [x] T072 [P] [US1] Implement `ManagerAttributionPrompt` component placeholder per S0 contact sheet: generic "This action needs a manager to approve" copy; manager identifier field + Clerk-backed credential field; confirm + cancel; layout-wired to above-threshold discount and post-handoff void — `src/renderer/ui/cart/ManagerAttributionPrompt.tsx`
- [x] T073 [P] [US1] Implement `DiscountPlaceholderRow` component: opaque "Discount applied" pill; tap-to-remove (subject to manager attribution on remove if original required it); magnitude NOT displayed (payments feature owns magnitude display) — `src/renderer/ui/cart/DiscountPlaceholderRow.tsx`
- [x] T074 [US2] Extend `CartPane` with void affordance (cashier+ pre-handoff; manager post-handoff) and discount affordance (below-threshold cashier+; above-threshold triggers `ManagerAttributionPrompt`) — `src/renderer/ui/cart/CartPane.tsx`
- [x] T075 [P] [US2] Add runbook entry: cart cancellation troubleshooting (common void reasons, manager-attribution prompt, post-handoff void policy) — `docs/runbook/sales-cart.md` **(§A3)**

**S3 exit (quickstart §US2 steps 1–7 pass):** Pre-handoff void transitions `cancelled`; post-handoff cashier void refused; manager post-handoff void emits `cart.cancel.post_handoff` audit event; above-threshold discount emits `cart.discount.above_threshold` audit event; session-end discards draft and emits `cart.discarded_on_session_end`; all five FR-026 mandatory attributes present in every audit row.

> ✅ **S3 COMPLETE — 2026-05-17.** T055–T070 merged via PR #157
> (merge commit `99b4d64`). T071–T075 merged via PR #159
> (merge commit `8bce04c`). S4 is the next candidate slice;
> blocked by §A4 (`PaymentIntentEnvelope` ratification).

---

## Phase 7 — Slice S4: Handoff envelope construction + freeze rule

**Purpose:** Implement `cart.handoff`, construct the `PaymentIntentEnvelope v1`, freeze the cart, emit the `cart.handoff_to_payment` audit event, and enforce the freeze rule on all mutating handlers. **Gate: S3 merged + §A4 (envelope shape ratified with future payments owner).**

### Phase 7 — Tests

- [x] T076 [P] [US3] Write contract test: `PaymentIntentEnvelope v1` carries all fields from `contracts/handoff-envelope.md §Field shape (v1)`: `envelope_version='v1'`, `cart_id`, `operator_session_id`, `owning_operator_id`, `tenant_id`, `branch_id`, `terminal_id`, `lines[]`, `discount_placeholders[]`, `subtotal_minor` (integer), `created_at`, `handoff_action_id` — `tests/contract/handoff-envelope.contract.test.ts` **(§A4)**
- [x] T077 [P] [US3] Write unit test: envelope immutability — `Object.isFrozen(envelope) === true` and `Object.isFrozen(envelope.lines) === true` after construction; mutation attempts throw in strict mode — `tests/unit/shared/cart/envelope-immutability.test.ts`
- [x] T078 [P] [US3] Write unit test: `subtotal_minor` is integer `Σ line_subtotal_minor`; no float coercion; `Number.isSafeInteger(subtotal_minor)` — `tests/unit/main/cart/cart-handoff-subtotal.test.ts`
- [x] T079 [P] [US3] Write unit test: `cart.handoff` refuses empty cart with `{ kind: 'refused', reason: 'empty_cart' }` (US3-AS2; FR-037) — `tests/unit/main/cart/cart-handoff-empty.test.ts`
- [x] T080 [P] [US3] Write unit test: `cart.handoff` refuses stale `per_line_versions` with `{ kind: 'refused', reason: 'stale_version' }`; cart stays in `editing` (US3-AS5; FR-037) — `tests/unit/main/cart/cart-handoff-stale-version.test.ts`
- [x] T081 [P] [US3] Write integration test: freeze rule — after `cart.handoff` succeeds, every mutating bridge call (`cart.lines.add`, `cart.lines.update`, `cart.lines.remove`, `cart.lines.setNote`, `cart.discountPlaceholders.add`, `cart.discountPlaceholders.remove`, `cart.void` (cashier)) returns `{ kind: 'refused', reason: 'frozen' }`; envelope and lines unchanged (SC-004; FR-035) — `tests/integration/main/cart/cart-freeze-after-handoff.test.ts`
- [x] T082 [P] [US3] Write integration test: handoff idempotency — same `idempotency_key` submitted twice → one envelope created, one `cart.handoff_to_payment` audit event, original `{ kind: 'ok', envelope }` returned on replay — `tests/integration/main/cart/cart-handoff-idempotency.test.ts`
- [x] T083 [P] [US3] Write integration test: envelope persistence — after handoff, restart app; `carts.handoff_envelope_json` is readable; rehydrated envelope is re-frozen (bridge re-applies `Object.freeze` on parse; R5) — `tests/integration/main/cart/cart-envelope-persistence.test.ts`
- [x] T084 [P] [US3] Write unit test: `cart.handoff_to_payment` audit event carries all five FR-026 mandatory attributes; `handoff_action_id` in audit row equals the envelope's `handoff_action_id`; partial record MUST NOT persist (atomic transaction per `contracts/handoff-envelope.md §Construction algorithm`) — `tests/unit/main/cart/cart-handoff-audit.test.ts`
- [x] T085 [P] [US3] Write integration test: offline handoff — with network disconnected, handoff proceeds locally; `cart.handoff_to_payment` audit row queued in local outbox (`synced_at = null`); renderer surfaces 003's offline/degraded banner; renderer MUST NOT claim payment succeeded (P2; NFR-008) — `tests/integration/main/cart/cart-handoff-offline.test.ts`

### Phase 7 — Implementation (§A4 gated)

- [x] T086 [US3] Implement `cart.handoff` handler following 7-step construction algorithm from `contracts/handoff-envelope.md §Construction algorithm`: `requireOperatorSession`; non-empty check; per-line version check; atomic transaction (outbox write → envelope construction → `Object.freeze` recursively → JSON serialize → `carts.handoff_envelope_json` → `state=frozen_handed_off` + `frozen_at` → `audit_events` row); return frozen envelope — `src/main/cart/cart-bridge.ts` **(§A4)**
- [x] T087 [US3] Implement `buildPaymentIntentEnvelope` helper: collects non-removed lines + discount placeholders; computes `subtotal_minor = Σ line_subtotal_minor` (integer arithmetic only); calls `freezeEnvelope` from T012 — `src/main/cart/handoff-envelope-builder.ts` **(§A4)**
- [x] T088 [US3] Add freeze guard to all mutating handlers: check `state IN (frozen_handed_off, cancelled)` before processing; return `{ kind: 'refused', reason: 'frozen' }` or `'closed'` as appropriate (defence-in-depth on top of individual handler state checks) — `src/main/cart/cart-bridge.ts` **(§A4)**
- [x] T089 [P] [US3] Implement `HandoffSummary` component: read-only frozen line list, cart subtotal, `frozen_at` timestamp, "Continue to payment" button (no-op in 005; payments feature owns post-handoff); cart pane transitions to clearly-frozen visual — `src/renderer/ui/cart/HandoffSummary.tsx` **(§A4)**
- [x] T090 [US3] Extend `CartPane` with handoff affordance ("Hand off to payment" button; visible only in `editing` state with ≥1 line); on success: render `HandoffSummary` — `src/renderer/ui/cart/CartPane.tsx` **(§A4)**
- [x] T091 [P] [US3] Add runbook entry: cart-payment handoff failure paths (what operator sees on abort, how to recover; `carts.handoff_envelope_json` inspection procedure) — `docs/runbook/sales-cart.md` **(§A4)**

**S4 exit (quickstart §US3 steps 1–7 pass):** Envelope constructed with all v1 fields; frozen recursively; persisted to `carts.handoff_envelope_json`; restart-surviving; freeze rule enforced on every mutating handler; `cart.handoff_to_payment` audit row with five mandatory attributes; idempotency verified; offline path queues outbox row without claiming payment success.

> ✅ **S4 COMPLETE — 2026-05-17.** T076–T088 and T091 merged via PR #162
> (merge commit `dc3c383`) — `cart.handoff` core, `PaymentIntentEnvelope`
> builder, freeze guard, runbook entry. T089–T090 merged via PR #163
> (merge commit `14456a0`) — `HandoffSummary` UI and `CartPane` handoff
> affordance. S5 (T092–T100) is the next candidate slice; §A5 remains
> a production-rollout-only gate.

---

## Phase 8 — Slice S5: Final polish + visual + runbook

**Purpose:** Screenshot/contact-sheet review against S0; full a11y audit; cross-process redaction smoke final pass; runbook entries complete; feature ready for §A5 production-readiness gate. **Gate: S0–S4 all merged.**

- [x] T092 [P] [US1] [US2] [US3] Write integration test: CartPane fills 003's reserved cart slot exactly (shell-slot dimension regression) — `tests/integration/renderer/ui/cart/cart-pane-shell-slot.test.tsx`
- [x] T093 [P] [US1] [US2] [US3] Write test: axe-clean on CartPane default state, loading state, and error state — `tests/integration/renderer/a11y/cart-pane-a11y.test.tsx`
- [x] T094 [P] [US1] [US2] [US3] Write test: axe-clean on LineItemRow, QuantityStepper, LineNotePopover, VoidConfirmation, ManagerAttributionPrompt, DiscountPlaceholderRow, HandoffSummary — `tests/integration/renderer/a11y/cart-components-a11y.test.tsx`
- [x] T095 [P] [US1] [US2] [US3] Write test: keyboard-only navigation — every cart-pane interaction reachable via keyboard; tab order per S0 contact sheet; QuantityStepper responds to arrow keys — `tests/integration/renderer/a11y/cart-pane-keyboard.test.tsx`
- [x] T096 [P] [US1] [US2] [US3] Screenshot review: compare cart-pane states (empty, editing with 3 lines, discount-pending, handing-off, frozen-handed-off, cancelled) against S0 contact sheet; tolerances documented in review record — `specs/005-sales-cart/visual-direction/s5-screenshot-review.md` ✅ COMPLETE 2026-05-18 — PR #171 artifact present; PR #172 Dev1/Dev2/Dev3 fixes verified on main SHA `897815c`; review record updated 2026-05-18; live pixel inspection deferred (headed Electron env unavailable); Dev4/Dev5 deferred P3
- [x] T097 [US1] [US2] [US3] Cross-process redaction smoke final pass: no PII, card data, credential fragments, or note content appear in any log, Sentry event, or test snapshot generated by any `cart.*` bridge call across S1–S4 (SC-009 coverage) — `tests/integration/cross-process-redaction-cart.test.ts` (final regression)
- [x] T098 [P] [US1] Add runbook entry: "cashier reports cart vanished after restart" — 5 generic causes + outbox inspection steps; "cart frozen but payments feature unavailable" — rollback coupling — `docs/runbook/sales-cart.md`
- [x] T099 [P] [US1] Add customer-facing onboarding doc: short operator-facing guide on cart workflow (build → discount → handoff → pay) — `docs/onboarding/cart-workflow.md`
- [x] T100 [US1] [US2] [US3] Quickstart end-to-end walkthrough: sign in → build cart (3 lines) → set note → apply below-threshold discount → apply above-threshold discount with manager attribution → void one line → hand off → observe frozen state → verify audit trail — `specs/005-sales-cart/quickstart.md` (walk through; document result) ✅ COMPLETE 2026-05-19 — headed Electron walkthrough passed; SQLite evidence verified (see `specs/005-sales-cart/quickstart.md` T100 closeout section). T100 sign-off is functional, not final UI polish; UI polish deferred to a future dedicated Impeccable/UI slice.

**S5 exit (§A5 production-readiness gate opens):** Visual pass clean; axe-clean; keyboard path full; redaction smoke green end-to-end; runbook entries in place; quickstart walkthrough documented.

> ✅ **S5-a COMPLETE — 2026-05-17.** T092–T095 merged via PR #166
> (merge commit `5a13be7`) — test-only slice adding the cart-pane
> shell-slot regression and the three a11y suites (CartPane states,
> cart-component axe sweep, keyboard-only navigation). 4 test files
> under `tests/integration/renderer/ui/cart/` and
> `tests/integration/renderer/a11y/`; no production source touched.
>
> ✅ **S5-b COMPLETE — 2026-05-17.** T097 merged via PR #168 (merge
> commit `57ba99f`) — redaction smoke final pass; 39 passing tests +
> 3 skipped defence-in-depth gap docs; no current runtime leaks.
> T098–T099 merged via PR #169 (merge commit `50d780b`) — runbook
> entry ("cart vanished after restart", freeze/payment rollback) and
> operator-facing onboarding guide. Docs-only slice; no production
> source touched.
> Remaining S5 work: T096 visual review, T100 quickstart walkthrough.
> §A5 remains a production-rollout-only gate.

---

## Phase 9 — Production Readiness (§A5 gated)

**Gate: §A5 sign-off AND future payments feature has reached its own production-readiness gate.**

- [ ] T101 Produce production-readiness checklist: per-tenant rollout sequence, telemetry surface, rollback plan (feature-flag coupling with payments feature), schema-migration safety review for 4 new tables — `specs/005-sales-cart/production-readiness.md` **(§A5)**
- [ ] T102 Confirm per-tenant rollout sequence: staged tenant set, canary period, rollback signal, success metric; pilot pharmacy enables cart flag for one branch first; full-tenant rollout after one-week pilot signal AND payments feature pilot-rolled — `specs/005-sales-cart/rollout-sequence.md` **(§A5)**

---

## Dependency graph (slice-level)

```text
§A0 CLEARED 2026-05-14
         │
         ▼
┌─────────────────────────┐
│ Phase 1 — Setup (T001–  │  ✅ COMPLETE (T001–T005 done)
│ T005) + §A3/§A4 threads │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Phase 2 — Foundational  │  ✅ COMPLETE (T006–T016 done)
│ (T006–T016)             │
└────────────┬────────────┘
             │ ← also: S0 review complete (T017–T019) ✅
             ▼
┌─────────────────────────┐
│ S1 — Bridge skeleton +  │  ✅ COMPLETE (T020–T029 done)
│ CartPane shell          │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ S2 — Cart-line CRUD +   │  ✅ COMPLETE (T030–T054 done; §A2 cleared)
│ idempotency outbox      │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ S3 — Sensitive actions  │  ✅ COMPLETE via PR #157 + PR #159
│ + audit emission        │  (T055–T075 done; §A3 cleared 2026-05-15)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ S4 — Handoff envelope + │  ✅ COMPLETE via PR #162 + PR #163
│ freeze rule             │  (T076–T091 done; §A4 cleared 2026-05-17)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ S5 — Final polish +     │  ✅ COMPLETE — S5-a (T092–T095) ✅ via PR #166;
│ visual + runbook        │  S5-b (T097–T099) ✅ via PRs #168–#169; T096 ✅ 2026-05-18; T100 ✅ 2026-05-19
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Production rollout      │  gate: §A5 (T101–T102)
└─────────────────────────┘
```

S0 (visual direction) ran in parallel with Phase 2 — both complete; S1 waited for both and is now merged.

---

## Parallel opportunities

Within a phase, tasks marked `[P]` touch independent files and may run concurrently:

- **Phase 2**: T006–T010 (test files independent); T011/T012 (independent shared modules).
- **S2 tests**: T030–T039 (independent unit/integration files).
- **S2 migrations** (§A2): T040–T043 are independent SQL files; T044 (arithmetic) is independent of migrations.
- **S3 tests**: T055–T066 (independent per-handler test files).
- **S3 UI**: T071–T073 (independent component files).
- **S4 tests**: T076–T085 (independent test files).
- **S5**: T092–T099 (independent test/doc files).

Sequential constraints: T025→T026 (same cart-bridge.ts file, sequential edit); T045–T048 (same cart-bridge.ts, sequential); T067–T069 (same file); T086–T088 (same file). Plan for one implementer per file at a time on `src/main/cart/cart-bridge.ts`.

---

## Independent test criteria per user story

| User story | Slices that prove it | Canonical exit test |
|:--|:--|:--|
| **US1** — Build a draft cart (P1) | S1 + S2 (+ S4 for full persistence) | T038 (restart survival) + T037 (idempotency) + T032 (Q4 merge) |
| **US2** — Cancel with attribution (P2) | S3 | T057 (manager post-handoff void) + T064 (audit completeness) + T063 (session-end discard) |
| **US3** — Hand off to payment (P3) | S4 | T076 (envelope contract) + T081 (freeze rule) + T084 (handoff audit) |

---

## Suggested MVP scope

**MVP = S0 + S1 + S2.** A cashier can build a durable, idempotent draft cart with line CRUD,
per-line notes, Q4 merge-default, per-line subtotal in integer minor units, restart-survival, and
tenant isolation. Void attribution (S3) and handoff envelope (S4) layer on top behind their own
gates (§A3, §A4). S5 is polish. The MVP proves the foundational shape without requiring the
payments feature to exist.

---

## Format validation

| Check | Result |
|:--|:--|
| Total tasks | T001–T102 (102 tasks) |
| S3 tasks T055–T075 marked complete (PR #157 + PR #159) | ✅ |
| S4 tasks T076–T091 marked complete (PR #162 + PR #163) | ✅ |
| S5-a tasks T092–T095 marked complete (PR #166) | ✅ |
| S5-b tasks T097–T099 marked complete (PRs #168–#169) | ✅ |
| T096 visual review marked complete (PR #171 artifact + PR #172) | ✅ |
| T100 quickstart walkthrough marked complete (headed Electron + SQLite evidence 2026-05-19) | ✅ |
| Every implementation task preceded by test task(s) | ✅ (Constitution VI) |
| Gate tags match real open gates only (§A2/§A3/§A4/§A5) | ✅ — §A0 cleared; no stale `[BLOCKED: §A0]` tags |
| Bridge handler names match `contracts/bridge-api.md` verbatim | ✅ |
| Audit categories = 4 canonical names from spec FR-026 + Q5 | ✅ |
| Table count = 4 (including `cart_line_discount_placeholders`) | ✅ |
| Migration order matches `data-model.md §Migration ordering` | ✅ |
| US1/US2/US3 labels match spec.md priorities | ✅ (US1=P1 cart CRUD, US2=P2 cancel, US3=P3 handoff) |
| S0 visual direction appears before S1 implementation | ✅ |
| Session-end handler (Q3+Q5) has dedicated task | ✅ T070 |
| Q4 merge path has concrete test (not stub) | ✅ T032 |
| `cart.subscribe` handler covered | ✅ T008 (contract test) + T026 (stub implementation) |
| No old working-title audit categories used as implementation targets | ✅ |
| Every task has a file path | ✅ |

---

**End of tasks.** ✅ APPROVED — 102 tasks across Phases 1–9 / Slices S0–S5 / Production Readiness.
S3 complete 2026-05-17 (PR #157 + PR #159). §A4 cleared 2026-05-17.
S4 complete 2026-05-17 (PR #162 T076–T088, T091 + PR #163 T089–T090).
S5-a complete 2026-05-17 (PR #166 T092–T095).
S5-b complete 2026-05-17 (PR #168 T097 + PR #169 T098–T099). T096 ✅ complete 2026-05-18 (PR #171 artifact + PR #172 Dev1/Dev2/Dev3 verified on main SHA `897815c`).
**T100 ✅ complete 2026-05-19 — headed Electron walkthrough passed; SQLite evidence verified.** T100 sign-off is functional, not final UI polish; UI polish deferred to a future dedicated Impeccable/UI slice. **S5 is now complete in full.**
T101/T102 not started. Production rollout waits for §A5.
