# Coordination — 005-sales-cart

> 🔁 **RT-28 amendment (2026-09-27):** manual discounts are **manager-only** — the Q2 threshold and every "below/above threshold" rule in this file are SUPERSEDED. Canonical text: [`spec.md`](spec.md) Amendment + FR-023 (revised). New audit category `cart.discount.manager_authorized`; `cart.discount.above_threshold` is historical only. Threshold references below are kept for audit trail.


**Feature:** 005-sales-cart
**Plan:** [./plan.md](./plan.md) (v1.0 APPROVED 2026-05-14)
**Spec:** [./spec.md](./spec.md) (`§A0 CLEARED` — Q1–Q5 locked 2026-05-14)
**Tasks:** [./tasks.md](./tasks.md) (APPROVED — 102 tasks, T001–T102; `/speckit-tasks` complete 2026-05-14)
**Created:** 2026-05-09
**Last updated:** 2026-05-19 (T100 complete — headed Electron walkthrough passed; SQLite evidence verified; S5 complete in full; UI polish deferred to a future dedicated Impeccable/UI slice)

---

> # ✅ S5 COMPLETE — T100 COMPLETE 2026-05-19
>
> **§A0 cleared 2026-05-14.** S0 ✅. Phase 2 ✅. S1 ✅. S2 ✅.
> S3 ✅ (PR #157 + PR #159, 2026-05-17).
> **§A4 ✅ CLEARED 2026-05-17** — `PaymentIntentEnvelope v1` field shape
> ratified by Ahmed Shaaban; conditions recorded in
> `contracts/handoff-envelope.md §Ratification — §A4`.
> **S4 ✅ COMPLETE 2026-05-17** — T076–T088 and T091 merged via PR #162
> (merge commit `dc3c383`); T089–T090 merged via PR #163 (merge commit
> `14456a0`).
> **S5-a ✅ COMPLETE 2026-05-17** — T092–T095 (a11y suites +
> cart-pane shell-slot regression) merged via PR #166 (merge commit
> `5a13be7`); test-only slice, no production source touched.
> **S5-b ✅ COMPLETE 2026-05-17** — T097 merged via PR #168 (merge
> commit `57ba99f`); T098–T099 merged via PR #169 (merge commit
> `50d780b`); docs-only slice, no production source touched.
> **T096 ✅ COMPLETE 2026-05-18** — PR #171 artifact (`s5-screenshot-review.md`)
> present; PR #172 Dev1/Dev2/Dev3 fixes verified on main SHA `897815c`
> (`canVoid` guard, discount inline grouping, `showVoidInHandoff` split);
> review record updated; live pixel inspection deferred (headed Electron
> env unavailable); Dev4/Dev5 deferred P3.
> **T100 ✅ COMPLETE 2026-05-19** — headed Electron walkthrough passed;
> SQLite evidence verified (`cart_action_outbox` sequence of 9 actions,
> `frozen_handed_off` state, restart-survival confirmed).
> T100 sign-off is functional, not final UI polish. UI polish deferred
> to a future dedicated Impeccable/UI slice. No scope change.
> §A5 remains a production-rollout-only gate (does not block S5 merges).
> T101/T102 not started. Production rollout still waits on §A5.

---

## Purpose

Track 005-sales-cart coordination state from spec-draft phase through
implementation. This file is the durable coordination record: returning
agents and humans should read it (and `plan.md` + `tasks.md`) first to
know "where are we?".

This file is **not** a tasks file. It does not authorize implementation.
It is the canonical record of coordination items, gate owners, and
phase status. Updated in place as coordination items resolve.

---

## Current phase / status

- **Phase:** **S5 COMPLETE 2026-05-19 — T100 complete; S5 complete in full.**
  - §A0: ✅ cleared 2026-05-14.
  - Phase 1 (T001–T005): ✅ complete.
  - Phase 2 / foundational types (T006–T016): ✅ complete.
  - S0 visual direction (T017–T019): ✅ signed off 2026-05-14 by Ahmed Shaaban.
  - S1 (T020–T029): ✅ complete.
  - S2 (T030–T054): ✅ complete (§A2 cleared 2026-05-14).
  - S3 (T055–T075): ✅ complete 2026-05-17 — T055–T070 merged via PR #157
    (merge commit `99b4d64`); T071–T075 merged via PR #159
    (merge commit `8bce04c`).
  - S4 (T076–T091): ✅ complete 2026-05-17 — T076–T088 and T091 merged
    via PR #162 (merge commit `dc3c383`; `cart.handoff` core,
    `PaymentIntentEnvelope` builder, freeze guard, runbook entry);
    T089–T090 merged via PR #163 (merge commit `14456a0`;
    `HandoffSummary` UI and `CartPane` handoff affordance). §A4 cleared
    2026-05-17 — `PaymentIntentEnvelope v1` ratified by Ahmed Shaaban.
  - **S5-a (T092–T095): ✅ complete 2026-05-17 — merged via PR #166
    (merge commit `5a13be7`). Test-only slice: shell-slot regression
    (`tests/integration/renderer/ui/cart/cart-pane-shell-slot.test.tsx`)
    + a11y suites
    (`tests/integration/renderer/a11y/cart-pane-a11y.test.tsx`,
    `cart-components-a11y.test.tsx`,
    `cart-pane-keyboard.test.tsx`). No production source touched.
    Prerequisite fix (LineNotePopover dialog accessible name) landed via
    PR #165 (merge commit `90825b1`).**
  - **S5-b (T097–T099): ✅ complete 2026-05-17 — T097 merged via PR #168
    (merge commit `57ba99f`); redaction smoke final pass, 39 passing tests
    + 3 skipped gap docs. T098–T099 merged via PR #169 (merge commit
    `50d780b`); runbook entry + operator onboarding guide. Docs-only
    slice; no production source touched.**
  - **T096 ✅ COMPLETE 2026-05-18** — visual review record updated; PR #171
    artifact present; PR #172 Dev1/Dev2/Dev3 fixes verified on main SHA
    `897815c`. Live pixel inspection deferred; Dev4/Dev5 deferred P3.
  - **T100 ✅ COMPLETE 2026-05-19.** Headed Electron walkthrough passed;
    SQLite evidence verified. Sign-off is functional, not final UI polish.
    UI polish deferred to a future dedicated Impeccable/UI slice.
    See `specs/005-sales-cart/quickstart.md §T100 Closeout — 2026-05-19`.
  - §A5: rollout-time gate — does not block slice merges.
- **Spec Kit artifacts (all present and approved):**
  - `spec.md` — `§A0 CLEARED`; Q1–Q5 locked 2026-05-14.
  - `plan.md` — v1.0 APPROVED 2026-05-14.
  - `tasks.md` — APPROVED; 102 tasks T001–T102; S3 tasks T055–T075,
    S4 tasks T076–T091, S5-a tasks T092–T095, and S5-b tasks T097–T099
    now marked complete.
  - `data-model.md`, `research.md`, `quickstart.md` — co-authored 2026-05-14.
  - `contracts/bridge-api.md`, `contracts/handoff-envelope.md`,
    `contracts/role-visibility-matrix-cart.md` — co-authored 2026-05-14.
  - `coordination.md` — this file.

---

## Phase 1 coordination records (T001–T005)

### T001 — Cart feature flag (§A1 configuration surface)

- **Status:** ✅ **COMPLETE — 2026-05-14.** Flag defined in source.
- **Source:** `src/shared/app-config.ts` — `AppConfig.features.cart?: boolean`.
- **Main wiring:** `src/main/index.ts` `getAppConfig()` reads
  `process.env.POS_PULSE_FEATURE_CART`. Truthy values: `'1'`, `'true'`,
  `'yes'`, `'on'` (case-insensitive). Anything else (including unset)
  defaults the flag to `false`. The renderer reads the flag once at
  boot via `window.api.appConfig()` and conditionally mounts the
  CartPane in 003's reserved cart slot.
- **Default:** `false` (disabled). Fail-closed by construction —
  enabling the flag requires explicit ops action (env var on the
  terminal).
- **Disabled-by-default rationale:** disabling the cart flag returns
  the application to the 003 + 004 post-sign-in shell with the cart
  slot reverting to its 003-era `CartPlaceholder` (003 FR-11). The
  four cart SQLite tables are harmless to keep unused when the flag
  is off (the tables themselves do not land until §A2 / S2).
- **Production rollout gate:** §A5. Flipping the flag in a tenant's
  production environment is a §A5 sign-off; dev/CI may flip freely.
- **Record updated:** T001 ✅ COMPLETE — flag key `features.cart`;
  env var `POS_PULSE_FEATURE_CART`; default `false`; recorded
  2026-05-14.

### T002 — §A3 audit-event catalogue extension coordination

- **Status:** ✅ **CLEARED 2026-05-15** — extension implemented on
  `feat/005-a3-audit-categories`; `AUDIT_ACTION_CATEGORIES` now contains
  the 4 canonical cart categories and `AuditPayloadMap` carries typed
  payload shapes for each. Compile-time map/category sync assertions
  (`payload-schemas.ts:_AssertMapCoversCategory` /
  `_AssertCategoryCoversMap`) enforce on-going parity. **Handler-level
  emission is S3 territory and is NOT included in this gate clearance.**
- **Finding:** `src/shared/audit/event-shape.ts` (004 T013) defines
  `AUDIT_ACTION_CATEGORIES` as a `const` array + `ActionCategory` type.
  Current members (6): `shift.open`, `shift.close`, `shift.forced_close`,
  `operator.session.takeover`, `cashier.pin.reset`, `cashier.pin.unlock`.
- **Required extension:** Before S3 merges, the array MUST be extended
  with the 4 canonical 005 cart categories (all lowercase, dot-separated):
  1. `cart.handoff_to_payment`
  2. `cart.cancel.post_handoff`
  3. `cart.discount.above_threshold`
  4. `cart.discarded_on_session_end`
- **Why these 4:** These are the only 005 audit categories that are
  sensitive per spec FR-026 + Q5, and therefore must appear in the
  `ActionCategory` discriminated union before the S3 audit-emitter
  wiring tasks (T060–T074) can pass the TypeScript compiler.
- **Coordination path:** The extension lands as a tightly-scoped
  source-only change to `src/shared/audit/event-shape.ts` and
  `src/shared/audit/payload-schemas.ts` (if payload shapes are
  added). It can be authored as its own PR or co-located with the
  first S3 task that needs it. **S3 MUST NOT begin before this
  extension is merged to main.**
- **Old stale names in coordination.md §6 (superseded):**
  `cart.void`, `cart.discount_applied_above_threshold`,
  `cart.line.removed_after_handoff_attempted` — these working titles
  are retired; use only the 4 canonical names above.
- **Owner:** Ahmed.
- **Record updated:** T002 ✅ coordination requirement recorded.

### T003 — §A4 handoff-envelope ratification coordination

- **Status:** ✅ **CLEARED 2026-05-17** — `PaymentIntentEnvelope v1`
  field shape ratified by Ahmed Shaaban. Ratification record in
  `contracts/handoff-envelope.md §Ratification — §A4`.
- **Contract location:** `specs/005-sales-cart/contracts/handoff-envelope.md`.
- **Conditions binding at ratification:**
  1. v1 field list locked for S4.
  2. Future payments work may add its own fields but MUST NOT remove,
     rename, or reinterpret any v1 field without a version bump (FR-036).
  3. v1 remains unsigned unless a future slice adds `envelope_signature`.
  4. Clears §A4 for S4 planning/implementation only.
  5. Does NOT start S4 and does NOT approve production rollout.
- **Owner:** Ahmed Shaaban.
- **Record updated:** T003 ✅ cleared 2026-05-17.

### T004 — S0 visual-direction reviewer

- **Status:** ✅ **COMPLETE** — reviewer assigned and review signed off.
- **Reviewer:** Ahmed Shaaban.
- **Review date:** 2026-05-14.
- **S0 scope completed:**
  1. 003 design tokens: no fork; all cart surfaces use existing token
     inventory only. PASS.
  2. 004 S5 role-visibility-matrix: cashier-forbidden items confirmed
     absent from all surfaces. Void-post-handoff hidden for cashier;
     visible for manager/admin. PASS.
  3. 44 × 44 CSS px touch-target floor: all interactive elements
     specified ≥ 44 × 44 CSS px. PASS.
  4. Role-conditional visibility: Void button, discount-placeholder pill,
     manager-attribution prompt — all correctly conditioned. PASS.
  5. Manager-attribution prompt: locked to generic copy only; no manager
     identity disclosed to cashier. PASS.
  6. Decrement-to-zero rule: locked — direct remove when no note;
     confirm dialog when note is non-null. PASS.
- **Artifacts:**
  - `specs/005-sales-cart/visual-direction/contact-sheet.md` (signed off)
  - `specs/005-sales-cart/visual-direction/review-record.md` (sign-off recorded)
- **Gate cleared:** S1 is now unblocked (FR-033 gate satisfied).
- **Record updated:** T004 ✅ complete — reviewer recorded; S0 signed off 2026-05-14.

### T005 — `/speckit-tasks` completion + current gate status

- **Status:** ✅ **COMPLETE.**
- **`/speckit-tasks` run:** 2026-05-14. Output: `specs/005-sales-cart/tasks.md`
  regenerated from stale BLOCKED draft → 102 executable tasks (T001–T102)
  across 9 phases. PR #148 merged to main 2026-05-14 (SHA `31663b9`).
- **Gate status as of 2026-05-14:**

  | Gate | Status | Notes |
  |:--|:--:|:--|
  | §A0 | ✅ CLEARED | 004 S4 (PR #124, 2026-05-11) + 004 S5 (SHA `d247e8a`, 2026-05-14) |
  | T001 | ⏳ pending | Cart feature-flag key confirmation required before S1 |
  | T004 | ⏳ pending | S0 reviewer assignment required before S0 kickoff |
  | §A1 | ⏳ deferred | S1+S2 unblocked via R7 fixture stub; real catalogue is a future feature |
  | §A2 | ✅ CLEARED 2026-05-14 | 4-table migration review signed off; S2 (T030–T054) startable — see `security-review/s2-migration-review.md` |
  | §A3 | ✅ CLEARED 2026-05-15 | `ActionCategory` + `AuditPayloadMap` extended with 4 cart categories (PR #156, `b307455`); S3 complete via PR #157 + PR #159 |
  | §A4 | ⏳ pending | Blocks S4 (T076–T091); requires envelope ratification (see T003) |
  | §A5 | rollout-time | Blocks production rollout only; does not block slice merges |

- **First startable tasks (now):**
  - T006–T016 (Phase 2, foundational types + bridge skeleton stubs — no gate)
- **Pending before next phases unlock:**
  - T001 resolved → confirms feature-flag key before S1
  - T004 resolved (reviewer assigned) → S0 visual direction (T017–T019) may begin
- **Record updated:** T005 ✅ complete.

---

## Dependencies on 004-operator-session

005-sales-cart consumes the following 004 deliverables. Each bullet
links the relevant 004 task ID range where applicable.

- **Operator session, role catalogue, and audit-attribution
  scaffold** — delivered by 004 S4 closeout (004 tasks T052–T082).
  005 reads the active operator session for cart ownership and audit
  attribution; cart action records carry the operator's
  Clerk-backed identity, not any local-only PIN factor.
- **Visibility boundaries (cashier vs manager/admin)** — delivered
  by 004 S5 closeout (004 tasks T083–T093). 005's cart-level
  sensitive actions (void, discount-above-threshold,
  remove-line-after-handoff-attempt) inherit and extend these
  visibility rules; the cart pane's role-conditional UI must match
  the canonical role-visibility-matrix in 004.
- **Audit-event emitter and `audit_events` table** — delivered by
  004 S3 (POS-Pulse PR #49, SHA `e50f5b8`). 005 emits new cart
  action categories through the same emitter; no new audit table.
- **`requireRole` primary trust gate** — delivered as part of 004's
  bridge / preload security work (004 S2). 005 reuses
  `requireRole` for every cart-level role-restricted action; the UI
  is a soft enforcement only.
- **003 design tokens / cart-pane reserved slot** — delivered by
  003 (POS UI shell). 005 S0 (visual direction) and S5 (final
  polish) render the cart pane against these tokens; no token
  forks.
- **001 secrets module / Electron security boundaries** —
  delivered by 001 (foundation). 005's cart bridge is a typed
  preload addition; no upward-of-bridge IPC, `contextIsolation`
  remains true, sandbox remains true.

---

## Required coordination actions before `/speckit-clarify` (and after § A0)

These items MUST resolve before 005 work may proceed. They are
listed in dependency order; some may be worked in parallel once
§A0 lifts.

### 1. 004 S4 closeout

- **Status:** ✅ **CLEARED — 004 S4 closeout completed via PR #124 merged 2026-05-11.**
- **Owner:** Ahmed.
- **Required action:** ~~Confirm the 004 S4 closeout PR (issue #87)
  merges with all S4 tasks (T052–T082) ticked and 004's
  coordination file marks S4 ✅.~~ Complete. All S4 tasks
  T052–T082 merged; 004's coordination file marks S4 ✅;
  PR #124 merged 2026-05-11.
- **Unblocks:** §A0 (partial — half). ✅ This half cleared.

### 2. 004 S5 review

- **Status:** ✅ **CLEARED — 004 S5 visibility boundaries complete; T083–T093 merged; main SHA `d247e8a` on 2026-05-14.**
- **Owner:** Ahmed.
- **Required action:** ~~004 S5 forced-close + visibility-boundary PR
  (004 tasks T083–T093) merges, the role-visibility-matrix is
  finalised, and 004's coordination file marks S5 ✅.~~ Complete.
  All T083–T093 merged (PRs #133/#134/#135/#137/#142/#143);
  role-visibility-matrix finalised; 004's coordination file marks
  S5 ✅; main SHA `d247e8a`, 2026-05-14.
- **Unblocks:** §A0 (the other half). ✅ This half cleared.

### 3. §A0 sign-off

- **Status:** ✅ **CLEARED — both §A0 prerequisites met; `/speckit-clarify` may proceed.**
  Cleared 2026-05-14: 004 S4 complete (PR #124, 2026-05-11) AND
  004 S5 complete (T083–T093 merged, main SHA `d247e8a`, 2026-05-14).
  Cart-side visibility additions in 004's role-visibility-matrix are
  accepted; the rows that 005 will inherit and extend are finalised.
- **Owner:** Ahmed (or constitution maintainer).
- **Required action:** ~~Confirm 004 S4 + S5 are approved AND that the
  cart-side visibility additions in 004's role-visibility-matrix
  are accepted.~~ Complete. Sign-off recorded in this file
  2026-05-14.
- **Unblocks:** ✅ `/speckit-clarify` on 005 **may now run**; 005 S0
  (visual direction) may begin once `/speckit-clarify` completes.

### 4. §A1 backend coordination

- **Status:** ⏳ **deferred.** Activates only once §A0 clears.
- **Owners:** Ahmed (POS-Pulse) + future payments-feature backend
  counterpart.
- **Required action:** Identify the SmartDataPulse backend
  interfaces 005 will need (item catalogue, item-ref resolution).
  Document in `coordination/a1-backend-handoff.md` (future file).
- **Important note:** Cart drafts themselves DO NOT introduce new
  backend endpoints. Drafts are local-only (`carts`, `cart_lines`,
  `cart_action_outbox` are local SQLite tables). The §A1 backend
  dependency is for **item-ref resolution only** (to validate the
  `item_ref` on each cart line against the canonical catalogue).
  This dependency MAY be deferred to a future item-catalogue
  feature; if so, 005 ships with a stubbed item-ref resolver and
  §A1 closes against that stub.
- **Unblocks:** S2 (item-ref resolution path), if/when the backend
  catalogue is needed.

### 5. §A2 migrations

- **Status:** ✅ **CLEARED — 2026-05-14.** Review record at
  [`security-review/s2-migration-review.md`](./security-review/s2-migration-review.md).
- **Owner:** Ahmed Shaaban.
- **Base SHA at clearance:** `e5c2d74` (PR #151 merge — S1 shell).
- **Scope cleared:** 4-table migration order (`carts` → `cart_action_outbox`
  → `cart_lines` → `cart_line_discount_placeholders`); FK graph
  (logical, not enforced by SQL — mirrors `0004_audit_events.sql`);
  append-only trigger pair required on `cart_action_outbox` only;
  `cart_action_outbox.line_id` nullable; no SQL `UNIQUE(cart_id, item_ref)`
  (Q4 merge is application-layer); test plan T030–T039; implementation
  plan T040–T054.
- **Constitution P4 ruling:** append-only constraint applies to
  `cart_action_outbox` only. `carts`, `cart_lines`, and
  `cart_line_discount_placeholders` remain intentionally mutable —
  rationale documented in the review record §5 and in data-model.md
  lines 304–305.
- **Unblocks:** S2 (cart-line CRUD), S3 (cart-level sensitive
  actions auditing).

### 6. §A3 audit-event catalogue extension

- **Status:** ✅ **CLEARED — 2026-05-15.** `AUDIT_ACTION_CATEGORIES` and
  `AuditPayloadMap` extended with 4 canonical cart categories via
  `feat/005-a3-audit-categories` (PR #156, merge commit `b307455`).
  Compile-time sync assertions added. See T002 Phase 1 record for detail.
- **Owner:** Ahmed.
- **Unblocked:** S3 (T055–T075) — now complete via PR #157 + PR #159.

### 7. §A4 handoff-envelope ratification

- **Status:** ✅ **CLEARED 2026-05-17** — `PaymentIntentEnvelope v1`
  field shape ratified by Ahmed Shaaban. Ratification record at
  [`contracts/handoff-envelope.md §Ratification — §A4`](./contracts/handoff-envelope.md).
- **Owner:** Ahmed Shaaban.
- **Conditions:** v1 field list locked; future payments work may extend
  but not reshape v1 fields (FR-036); v1 unsigned pending explicit
  extension; clears §A4 for S4 planning/implementation only; does not
  start S4 and does not approve production rollout.
- **Unblocked:** S4 (handoff envelope + freeze rule, T076–T091) — now
  complete via PR #162 (T076–T088, T091; merge `dc3c383`) + PR #163
  (T089–T090; merge `14456a0`), 2026-05-17.

### 8. Slice 0 visual-direction reviewer

- **Status:** ✅ **COMPLETE** — Ahmed Shaaban; signed off 2026-05-14.
- **Owner:** Ahmed Shaaban.
- **Required action:** Complete. Contact sheet reviewed and signed off
  against all 6 mandatory criteria:
  1. 003 design tokens (no fork). ✅
  2. 003 navigation-rail behaviour. ✅
  3. 003 connection-state visuals. ✅
  4. 004 role-indicator slot. ✅
  5. 44 × 44 CSS px touch-target floor. ✅
  6. Cashier-forbidden information catalogue (004 S5). ✅
- **Artifacts:**
  - `specs/005-sales-cart/visual-direction/contact-sheet.md`
  - `specs/005-sales-cart/visual-direction/review-record.md`
- **Unblocks:** ✅ S1 (cart bridge + role gating) — FR-033 gate cleared.

### 9. §A5 production-readiness reviewer

- **Status:** ⏳ **rollout-time.**
- **Owner:** TBD (assigned at production-rollout PR open time).
- **Required action:** Sign off on the full production-rollout PR
  for 005 (feature-flag flip, customer-facing readiness check).
- **Unblocks:** Production rollout. Does NOT block individual S0–S5
  merges to `main` behind a feature flag.

---

## Gate owner table

| Gate | Status | Owner | Resolution-path note |
|:--|:--:|:--|:--|
| §A0 — 005-blocking gate (LOAD-BEARING) | ✅ **CLEARED 2026-05-14** | **Ahmed** | 004 S4 closeout ✅ (PR #124, 2026-05-11) AND 004 S5 visibility boundaries ✅ (T083–T093 merged; main SHA `d247e8a`, 2026-05-14). `/speckit-clarify` is now eligible to run. |
| §A1 — cart-related backend / OpenAPI dependencies | ⏳ deferred | **Ahmed** + future-feature owner | Item-ref resolution only; cart drafts add NO new backend endpoints. May ship with stubbed resolver if catalogue feature is later. |
| §A2 — migrations (`carts`, `cart_action_outbox`, `cart_lines`, `cart_line_discount_placeholders`) | ✅ **CLEARED 2026-05-14** | **Ahmed Shaaban** | Review record at [`security-review/s2-migration-review.md`](./security-review/s2-migration-review.md). 4-table FK-safe order; append-only trigger on `cart_action_outbox` only; `line_id` nullable; no SQL UNIQUE(cart_id, item_ref). Base SHA `e5c2d74`. **S2 may start.** |
| §A3 — 004 audit-event catalogue extension | ✅ **CLEARED 2026-05-15** | **Ahmed** | `ActionCategory` + `AuditPayloadMap` extended with 4 cart categories (PR #156, `b307455`). S3 complete via PR #157 + PR #159. |
| §A4 — handoff-envelope shape | ✅ **CLEARED 2026-05-17** | **Ahmed Shaaban** | `PaymentIntentEnvelope v1` ratified 2026-05-17. Record in `contracts/handoff-envelope.md §Ratification — §A4`. S4 (T076–T091) complete via PR #162 + PR #163. |
| §A5 — production-readiness rollout gate | ⏳ rollout-time | **TBD** | Production gate only. Does not block slice merges behind a feature flag. |

---

## Gate unblock table

| Gate clears | Slices that become eligible to schedule |
|:--|:--|
| §A0 | `/speckit-clarify` on 005 may run; S0 (visual direction) may begin |
| §A0 + S0 review | S1 (cart bridge + role gating) may begin |
| §A0 + §A2 | S2 (cart-line CRUD + idempotency outbox) may begin |
| §A0 + §A3 | S3 (cart-level sensitive actions into 004 audit emitter) may begin |
| §A0 + §A4 | S4 (handoff envelope + freeze rule) may begin |
| §A0 + §A1 (if needed) + S2 + S3 + S4 merged | S5 (final polish + cart pane visual) may begin; production rollout may proceed pending §A5 |

**Bottom line:** S0 ✅, Phase 2 ✅, S1 ✅, S2 ✅, S3 ✅ (PR #157 + PR #159,
2026-05-17). §A4 ✅ CLEARED 2026-05-17. S4 ✅ COMPLETE 2026-05-17
(PR #162 T076–T088, T091 + PR #163 T089–T090). **S5-a ✅ COMPLETE
2026-05-17 (PR #166 T092–T095). S5-b ✅ COMPLETE 2026-05-17 (PR #168
T097 + PR #169 T098–T099). T096 ✅ COMPLETE 2026-05-18 (visual review
record updated; PR #171 artifact + PR #172 Dev1/Dev2/Dev3 fixes verified
on main SHA `897815c`). T100 ✅ COMPLETE 2026-05-19 (headed Electron
walkthrough passed; SQLite evidence verified; S5 complete in full).
UI polish deferred to a future dedicated Impeccable/UI slice; no scope change.
T101/T102 not started.** §A5 blocks production rollout only.

---

## Required approvals (summary callout)

✅ All pre-implementation Spec Kit approvals are complete. S0–S4 merged; S5-a merged; S5-b merged.

1. ✅ 004 S4 closeout PR merged (PR #124, 2026-05-11).
2. ✅ 004 S5 visibility-boundaries merged (T083–T093; SHA `d247e8a`, 2026-05-14).
3. ✅ §A0 sign-off recorded in this file (2026-05-14).
4. ✅ `/speckit-clarify` resolved all `[NEEDS CLARIFICATION]` items (Q1–Q5 locked 2026-05-14).
5. ✅ `/speckit-plan` approved (plan v1.0, PR #147, 2026-05-14).
6. ✅ `/speckit-tasks` complete (tasks.md APPROVED, PR #148, 2026-05-14).
7. ✅ §A2 cleared (4-table migration review, 2026-05-14).
8. ✅ §A3 cleared (audit-category extension, PR #156, 2026-05-15).
9. ✅ S3 complete (PR #157 T055–T070 + PR #159 T071–T075, 2026-05-17).
10. ✅ §A4 cleared — `PaymentIntentEnvelope v1` ratified by Ahmed Shaaban 2026-05-17.
11. ✅ S4 complete (PR #162 T076–T088, T091 + PR #163 T089–T090, 2026-05-17).
12. ✅ S5-a complete (PR #166 T092–T095 a11y + shell-slot tests, 2026-05-17).
13. ✅ S5-b complete (PR #168 T097 redaction smoke + PR #169 T098–T099 runbook/onboarding, 2026-05-17).

**Remaining per-slice gates:** §A5 (production rollout only).
**S5 complete. T101/T102 and §A5 not started.** Next work: §A5 production-readiness gate when production rollout is planned.

---

## Open questions (cross-doc)

✅ **All open questions resolved by `/speckit-clarify` on 2026-05-14.**
Locked values (Q1–Q5):

| Decision | Locked value |
|:--|:--|
| Q1 — Item-note maximum length | **200 characters** |
| Q2 — Discount-attribution threshold | **Percentage of `line_subtotal_minor`, per-line; numeric value is tenant-configurable** |
| Q3 — Cart-stale policy on session end | **Option (a): discard immediately on session end** |
| Q4 — Duplicate-add line-merge rule | **Merge by `item_ref` (default); "force separate line" deferred** |
| Q5 — Offline-cart audit event | **`cart.discarded_on_session_end`** (4th canonical category) |

Additional resolutions: optimistic-concurrency token = monotonic integer
(`version`); idempotency key = UUID v4 stored in `cart_action_outbox`;
handoff-envelope version field = string literal `'v1'`.

---

## Spec Kit step completion record

| Step | Status | Date | PR / SHA |
|:--|:--:|:--|:--|
| `/speckit-specify` (`spec.md`) | ✅ | 2026-05-09 | — |
| `/speckit-clarify` (Q1–Q5 locked) | ✅ | 2026-05-14 | PR #146 |
| `/speckit-plan` (`plan.md` v1.0 + contracts) | ✅ | 2026-05-14 | PR #147 |
| `/speckit-tasks` (`tasks.md` APPROVED) | ✅ | 2026-05-14 | PR #148 |
| Phase 1 coordination (T001–T005) | ✅ | 2026-05-14 | — |
| S0 visual direction (T017–T019) | ✅ signed off | 2026-05-14 | — |
| Phase 2 foundational (T006–T016) | ✅ | 2026-05-14 | — |
| S1 (T020–T029) | ✅ | 2026-05-14 | PR #151 |
| S2 (T030–T054) | ✅ | 2026-05-14 | — |
| S3 (T055–T075) | ✅ | 2026-05-17 | PR #157 (T055–T070) + PR #159 (T071–T075) |
| S4 (T076–T091) | ✅ | 2026-05-17 | PR #162 (T076–T088, T091) + PR #163 (T089–T090) |
| S5-a (T092–T095 a11y + shell-slot tests) | ✅ | 2026-05-17 | PR #166 (merge `5a13be7`) |
| S5-b (T097–T099 redaction smoke + runbook/onboarding) | ✅ | 2026-05-17 | PR #168 (T097, merge `57ba99f`) + PR #169 (T098–T099, merge `50d780b`) |
| T096 visual review | ✅ | 2026-05-18 | PR #171 artifact + PR #172 fixes on main SHA `897815c` |
| T100 quickstart walkthrough | ✅ | 2026-05-19 | Headed Electron walkthrough passed; SQLite evidence verified |

## Explicit non-actions (current state)

The following have **NOT yet started** and MUST NOT start without
the corresponding gate clearing:

- ✅ T096 visual review complete 2026-05-18 (PR #171 artifact + PR #172 Dev1/Dev2/Dev3 fixes
  verified on main SHA `897815c`).
- ✅ T100 quickstart walkthrough complete 2026-05-19 — headed Electron walkthrough
  passed; SQLite evidence verified. UI polish deferred to a future dedicated
  Impeccable/UI slice.
- ❌ §A5 production-readiness review not yet started (rollout-time
  gate; reviewer assigned at production-rollout PR open time).
- ❌ No backend / Data-Pulse-2 changes for 005 (cart drafts are
  local-only; no new backend endpoints in 005's scope).
- ❌ No payments / receipts / inventory / reports / analytics work begun.
- ✅ S0–S4 complete and merged to main (T001–T091 done).
- ✅ S5-a complete and merged to main (T092–T095 done via PR #166).
- ✅ S5-b complete and merged to main (T097–T099 done via PR #168 + PR #169).

---

## Status update protocol

When any item changes state (especially §A0), update this file in
place:

1. Update the row in **Required coordination actions** that
   changed (status, owner, dates).
2. Update the corresponding row in the **Gate owner table**.
3. Update the **Last updated** date at the top.
4. If a gate clears completely, update the **Gate unblock table**
   to reflect the now-eligible slices.
5. When §A0 clears, add a line under **Current phase / status**
   noting "§A0 cleared on YYYY-MM-DD; `/speckit-clarify` may run."
6. When `/speckit-clarify` and `/speckit-plan` complete, update
   the **Phase** marker accordingly.

This file is the durable coordination record across sessions.

---

**End of coordination file.** S3 complete 2026-05-17 (PR #157 + PR #159;
main SHA `8bce04c`). §A4 cleared 2026-05-17 (`PaymentIntentEnvelope v1`
ratified by Ahmed Shaaban). S4 complete 2026-05-17 (PR #162 T076–T088, T091
merge `dc3c383`; PR #163 T089–T090 merge `14456a0`; main SHA `14456a0`).
S5-a complete 2026-05-17 (PR #166 T092–T095 merge `5a13be7`).
S5-b complete 2026-05-17 (PR #168 T097 merge `57ba99f`; PR #169 T098–T099
merge `50d780b`; main SHA `50d780b`).
T096 visual review complete 2026-05-18 (PR #171 artifact + PR #172
Dev1/Dev2/Dev3 fixes verified on main SHA `897815c`).
**T100 quickstart walkthrough complete 2026-05-19** (headed Electron walkthrough
passed; SQLite evidence verified; `cart_action_outbox` sequence of 9 actions;
`frozen_handed_off` state; restart-survival confirmed).
S0 ✅, Phase 2 ✅, S1 ✅, S2 ✅, S3 ✅, §A4 ✅, S4 ✅, S5-a ✅, S5-b ✅,
T096 ✅, T100 ✅. **S5 complete in full.**
UI polish deferred to a future dedicated Impeccable/UI slice. T101/T102 not
started. §A5 remains a production-rollout-only gate.
