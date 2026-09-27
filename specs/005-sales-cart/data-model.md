# Data Model: Sales Cart (Phase 1)

> 🔁 **RT-28 amendment (2026-09-27):** manual discounts are **manager-only** — the Q2 threshold and every "below/above threshold" rule in this file are SUPERSEDED. Canonical text: [`spec.md`](spec.md) Amendment + FR-023 (revised). New audit category `cart.discount.manager_authorized`; `cart.discount.above_threshold` is historical only. Threshold references below are kept for audit trail.


**Feature ID:** 005-sales-cart
**Plan:** [./plan.md](./plan.md)
**Spec:** [./spec.md](./spec.md)
**Created:** 2026-05-14
**Constitution version pinned:** v1.5.1

> 🚧 **CONCEPTUAL ONLY.** No SQL is authored by `/speckit-plan`. The
> migration files for `carts`, `cart_lines`, `cart_action_outbox`, and
> `cart_line_discount_placeholders` are authored during Slice S2 under
> §A2. This file describes the entities, their fields, the invariants,
> and the relationships — the SQL shape is derived from this description
> by the migration tasks. No source code, no `*.sql`, no `*.ts` is
> created by this document.

---

## Overview

005-sales-cart introduces **four** new local SQLite tables in addition
to consuming 004's existing `audit_events`:

| Table | Purpose | Mutability |
|:--|:--|:--|
| `carts` | Cart lifecycle header (one row per cart) | Mutable through bridge handlers; terminal in `cancelled` / `frozen_handed_off`. |
| `cart_lines` | Per-line state (zero-or-more per cart) | Mutable through bridge handlers; soft-remove via `removed_at`. |
| `cart_action_outbox` | Append-only history of every cart-mutating action | Append-only (UPDATE / DELETE denied by trigger). |
| `cart_line_discount_placeholders` | Zero-or-more discount placeholders per line (R6) | Mutable via bridge handlers; rows reference `(cart_id, line_id)`. |

005 **does NOT introduce a parallel audit table.** Cart sensitive
actions emit into 004's existing `audit_events` table via the existing
emitter (AD-3).

The four cart-introduced audit action categories that extend 004's
catalogue (FR-026 + Q5) are:

- `cart.handoff_to_payment`
- `cart.cancel.post_handoff`
- `cart.discount.manager_authorized` *(RT-28 — every positive manual discount)*
- `cart.discount.above_threshold` *(historical only — superseded by RT-28; not emitted for new discounts)*
- `cart.discarded_on_session_end` *(Q5 LOCKED 2026-05-14)*

---

## Entity: Cart

The lifecycle header of a draft cart. One row per cart. Bound to exactly
one `OperatorSession`.

**Fields** *(behavioural; SQL types derived at migration-author time)*:

| Field | Shape | Notes |
|:--|:--|:--|
| `cart_id` | UUID v4 | Primary key. Client-generated at create-time. |
| `tenant_id` | UUID / string | From the bound `OperatorSession`. MUST match `OperatorSession.tenant_id` (FR-002). |
| `branch_id` | UUID / string | From the bound `OperatorSession`. |
| `terminal_id` | UUID / string | From the bound `OperatorSession`. Used for support-bundle scoping. |
| `owning_operator_id` | Clerk-backed identity (string) | The cashier who created the cart. Stable across sessions (the *operator*, not the *session*). |
| `operator_session_id` | UUID / string | The active session under which the cart was created. Bound 1:1 to the cart for its lifetime; on session end, the cart is discarded (Q3). |
| `state` | enum | One of {`empty`, `editing`, `discount_pending_attribution`, `handing_off`, `frozen_handed_off`, `cancelled`}. The five-state FSM lives in the renderer's `cartStore`; `cancelled` is the terminal sink for both cashier void and Q3 session-end discard. |
| `cart_subtotal_minor` | integer minor units | Computed `Σ line_subtotal_minor` over non-removed `cart_lines`. NEVER floats (P1 / NFR-002). |
| `created_at` | UTC timestamp | |
| `updated_at` | UTC timestamp | |
| `frozen_at` | UTC timestamp, nullable | Set when transitioning to `frozen_handed_off`. |
| `cancelled_at` | UTC timestamp, nullable | Set when transitioning to `cancelled`. |
| `cancellation_reason` | enum, nullable | One of {`cashier_voided`, `manager_voided_post_handoff`, `session_ended`}. `session_ended` is the Q3 path. |
| `handoff_envelope_json` | TEXT, nullable | JSON serialisation of the `PaymentIntentEnvelope` (R5). Populated at `frozen_handed_off`; never mutated thereafter. |
| `last_action_id` | UUID v4 (FK → `cart_action_outbox.action_id`) | Cached pointer to the last applied action for read-after-write verification (R4). |

**Invariants:**

1. `(tenant_id, branch_id, terminal_id)` MUST equal the corresponding
   triple on the bound `OperatorSession`; mismatches are refused at the
   bridge (FR-002).
2. A cart in `cancelled` or `frozen_handed_off` is terminal for cart-layer
   mutation (FR-006).
3. The legal state transitions (FR-005) are:
   - `empty → editing` (first line add)
   - ~~`editing → discount_pending_attribution` / `discount_pending_attribution → editing`~~ *(SUPERSEDED by RT-28: unreachable. An add without verified manager authority is refused before anything is written, and a successful add is written with its approver, so the cart stays `editing`. The manager step-up prompt is pre-call renderer UI state, not a persisted cart state. The `discount_pending_attribution` value stays in the `migrations/0008` CHECK for compatibility (D5) and MUST NOT be entered.)*
   - `editing → handing_off` (handoff invocation)
   - `handing_off → frozen_handed_off` (envelope construction succeeds)
   - `handing_off → editing` (handoff refused on stale version)
   - `editing → cancelled` (cashier void OR Q3 session-end discard)
   - `frozen_handed_off → cancelled` (manager-attributed post-handoff cancel)
4. The renderer's `cartStore` MUST mirror only what the bridge confirms
   (P2; AD-1).

---

## Entity: CartLine

A single line item on a cart. Zero-or-more per cart.

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `line_id` | UUID v4 | Primary key. Client-generated at add-time. |
| `cart_id` | UUID v4 (FK → `carts.cart_id`) | |
| `item_ref` | string | Catalogue reference. Resolved via the R7 stub seam. |
| `display_name` | string | Snapshot at add-time per FR-013. Subsequent catalogue display-name changes do NOT rewrite the line. |
| `quantity` | positive integer | Always positive. `set(0)` is a remove (FR-016). |
| `unit_price_minor` | integer | Snapshot at add-time per FR-011. Integer minor units only (P1). |
| `line_subtotal_minor` | integer | Computed `quantity × unit_price_minor` (FR-012). Recomputed on every successful mutation. Integer arithmetic only; `Number.isSafeInteger`-guarded on the result. |
| `note` | string, nullable | Length ≤ **200 chars** (Q1 LOCKED 2026-05-14). Length-cap enforced at the bridge boundary; partial overwrite forbidden (FR-020). |
| `version` | monotonic integer | Optimistic-concurrency token (R2). Starts at 1; advances by exactly one on each successful mutation. |
| `last_action_id` | UUID v4 (FK → `cart_action_outbox.action_id`) | Pointer into the outbox row that produced the current state. |
| `created_at` | UTC timestamp | |
| `updated_at` | UTC timestamp | |
| `removed_at` | UTC timestamp, nullable | Soft-remove marker. Rows are NEVER hard-deleted; this preserves audit continuity. |

**Invariants:**

1. **Q4 merge default (LOCKED 2026-05-14):** the bridge handler for
   `cart.lines.add` MUST detect an existing non-removed line on the
   same `cart_id` with the same `item_ref` and merge (increment
   `quantity`, advance `version`, write a `cart.line.merge` outbox
   row) rather than insert a duplicate. Uniqueness of
   `(cart_id, item_ref)` among non-removed rows is enforced **at the
   application layer**, not via a SQL `UNIQUE` constraint (so that
   soft-removed lines for the same `item_ref` can coexist with a later
   non-removed re-add as a fresh `line_id`).
2. `unit_price_minor` is snapshotted at add-time and IMMUTABLE for the
   life of the line. Subsequent catalogue price drift does not rewrite
   the line (FR-011). Note that **merges (Q4) do NOT re-snapshot the
   price** — the surviving line retains its original `unit_price_minor`;
   if the catalogue price changed, the cashier sees the original price.
3. `line_subtotal_minor = quantity × unit_price_minor` is the ONLY
   money arithmetic 005 performs at the line level. No discount math,
   no tax, no rounding (FR-012, NFR-002, NFR-003).
4. `note` MUST refuse forbidden patterns at the bridge boundary (FR-021,
   NFR-006).
5. `version` is per-`(cart_id, line_id)` and advances even on merges
   into this line (R2 + R1).

---

## Entity: CartActionOutbox

Append-only history of every cart-mutating action. One row per action.

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `action_id` | UUID v4 | Primary key. Client-generated at the moment of intent. The idempotency key (P5; FR-018). |
| `cart_id` | UUID v4 (FK → `carts.cart_id`) | |
| `line_id` | UUID v4 (FK → `cart_lines.line_id`), nullable | Set for line-level actions; null for cart-level actions (`cart.create`, `cart.void`, `cart.handoff_to_payment`, `cart.discarded_on_session_end`). |
| `action_kind` | enum | See enum below. |
| `acting_operator_id` | Clerk-backed identity (string) | The operator under whose session the action executed. Equal to the cart's `owning_operator_id` for cashier-attributed actions; equal to the manager's identity for manager-attributed actions. |
| `attribution_operator_id` | Clerk-backed identity (string), nullable | Used for manager-attributed actions where the cashier is the requester and the manager is the approver (`cart.discount.above_threshold`, `cart.cancel.post_handoff`). |
| `operator_session_id` | UUID / string | The session under which the action ran (FR-025). |
| `payload_json` | TEXT | Canonicalised serialisation of the action input (post-redaction per NFR-006). |
| `applied_at` | UTC timestamp | |
| `synced_at` | UTC timestamp, nullable | Reserved for a future backend-sync pipeline. 005 does NOT run a sync. |

**`action_kind` enum** (canonical wording locked 2026-05-14):

- `cart.create`
- `cart.line.add`
- `cart.line.update` *(quantity / non-merge)*
- `cart.line.merge` *(Q4 merge path)*
- `cart.line.remove`
- `cart.line.note_set`
- `cart.discount_placeholder.add`
- `cart.discount_placeholder.remove`
- `cart.void` *(cashier pre-handoff void; non-sensitive lifecycle event per FR-031)*
- `cart.handoff_to_payment` *(sensitive; emits audit per FR-026)*
- `cart.cancel.post_handoff` *(sensitive; emits audit; manager-attributed per FR-033)*
- `cart.discount.above_threshold` *(sensitive; emits audit; manager-attributed per FR-023)* *(value retained to match the `migrations/0009` CHECK; RT-28's new `cart.discount.manager_authorized` is an `audit_events.action_category` only, NOT an outbox `action_kind` — the outbox row for a discount stays `cart.discount_placeholder.add`)*
- `cart.discarded_on_session_end` *(sensitive; emits audit; Q5 LOCKED 2026-05-14)*

**Invariants:**

1. **Append-only.** UPDATE and DELETE on `cart_action_outbox` are denied
   by SQL trigger (mirrors 004's `audit_events` trigger). Once written,
   a row is durable until the table itself is dropped.
2. **Idempotency.** `action_id` is unique across all rows. Replay of a
   bridge call with the same `action_id` and the same payload MUST be a
   no-op returning the original outcome; replay with a *different*
   payload MUST be refused (FR-018).
3. **Audit emission.** The `action_kind` values marked *sensitive*
   above MUST also emit a row into 004's `audit_events` table with the
   five mandatory attribution attributes (FR-026; SC-005). **RT-28
   exception:** a successful `cart.discount_placeholder.add` (the outbox
   operation) MUST also emit an `audit_events` row whose `action_category`
   is `cart.discount.manager_authorized` (the audit category, distinct from
   the outbox `action_kind`), carrying requester and approving manager.
   Every other non-sensitive action MUST NOT emit `audit_events` rows (FR-027).
4. **No PII in `payload_json`.** The cart-payload allowlist (NFR-006)
   redacts `note` content, forbidden patterns, and any credential
   fragment before serialisation.

---

## Entity: CartLineDiscountPlaceholder

Per-line discount placeholders (R6). Zero-or-more per line.

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `placeholder_id` | UUID v4 | Primary key. |
| `cart_id` | UUID v4 (FK → `carts.cart_id`) | |
| `line_id` | UUID v4 (FK → `cart_lines.line_id`) | |
| `placeholder_kind` | string | Opaque token whose catalogue is owned by the future payment / checkout feature (FR-024). 005 does NOT interpret the token's magnitude. |
| `requires_manager_attribution` | boolean | **RT-28:** always true for a positive manual discount (no threshold). Column kept unchanged (D5 — no schema change). Formerly: true when the magnitude exceeded the Q2 threshold. |
| `attribution_operator_id` | Clerk-backed identity (string), nullable | The approving manager, set only after manager authority is established main-side (RT-28 D1/D1a: manager identifier + password step-up via the existing manager sign-in path) — or the acting manager/admin themselves (D2). Never accepted from the renderer as proof of authority. |
| `created_at` | UTC timestamp | |

**Invariants:**

1. The cart layer does NOT compute the discounted amount. The placeholder
   is *informational* until the future payment / checkout feature applies
   discount math (FR-022, FR-024).
2. **[SUPERSEDED by RT-28]** ~~`requires_manager_attribution = true` AND `attribution_operator_id IS NULL`
   places the *cart* in state `discount_pending_attribution`; the cart
   transitions back to `editing` only when the attribution is recorded.~~
   **RT-28:** every placeholder written after RT-28 carries a non-null verified
   `attribution_operator_id`. A placeholder with `attribution_operator_id IS NULL` can only
   be a pre-RT-28 legacy row; `cart.handoff` refuses (`unauthorized_discount`) until it is
   removed or re-added with manager authority. No data migration (D5).
3. **[SUPERSEDED by RT-28 — there is no threshold; every positive manual
   discount requires manager authority.]** ~~The Q2-locked threshold is **a percentage of `line_subtotal_minor`,
   applied per-line.** The specific numeric value is a tenant-configurable
   parameter owned by the future payment / checkout feature's discount-
   catalogue; this spec does not set that value. The bridge handler reads
   the tenant configuration at apply-time.~~

---

## Entity: PaymentIntentEnvelope *(in-memory + persisted)*

The single cross-feature contract surface between cart and the future
payment / checkout feature (AD-2; FR-034). NOT a database table — lives
in memory as a `Readonly<>` TypeScript object and is persisted as JSON
on `carts.handoff_envelope_json`.

**Fields** *(immutable once constructed; `Object.freeze` applied
recursively):*

| Field | Shape | Notes |
|:--|:--|:--|
| `envelope_version` | string literal `'v1'` | For forward compatibility (R5). |
| `cart_id` | UUID v4 | |
| `operator_session_id` | UUID / string | The session under which handoff occurred. |
| `owning_operator_id` | Clerk-backed identity (string) | The cashier. |
| `tenant_id` | UUID / string | |
| `branch_id` | UUID / string | |
| `terminal_id` | UUID / string | |
| `lines` | readonly array of frozen line snapshots | Each entry: `{ item_ref, display_name, quantity, unit_price_minor, line_subtotal_minor, note, version, last_action_id }` |
| `discount_placeholders` | readonly array of frozen placeholder snapshots | Each entry: `{ line_id, placeholder_kind, requires_manager_attribution, attribution_operator_id }`. Cart-level discounts are NOT in 005's envelope per R6. |
| `subtotal_minor` | integer minor units | `Σ line_subtotal_minor` over the frozen `lines[]`. NEVER floats. |
| `created_at` | UTC timestamp | Equals `carts.frozen_at`. |
| `handoff_action_id` | UUID v4 | The same id as the `cart_action_outbox` row whose `action_kind = cart.handoff_to_payment` and the corresponding `audit_events` row. |

**Invariants:**

1. **Immutable.** The TypeScript value is `Readonly<>` and frozen
   recursively. The JSON serialisation is immutable by construction.
2. **The future payments feature MAY add fields it owns** (tender
   breakdown, totals math beyond `subtotal_minor`, change, paid
   timestamps, receipt-breakdown payload) **but MUST NOT remove,
   rename, or rewrite** any of the fields listed above (FR-036).
3. **Forward compatibility.** Additions are versioned via
   `envelope_version`. A future `'v2'` envelope MAY add fields; cart-
   layer code in 005 emits `'v1'` only.

---

## Relationship summary

```
carts (1) ────< cart_lines (0..N) ────< cart_line_discount_placeholders (0..N)
   │                  │
   │                  └── last_action_id ──> cart_action_outbox
   │
   └── last_action_id ──> cart_action_outbox

cart_action_outbox ──┬── (sensitive rows) ──> audit_events (004's existing table)
                     │
                     └── (non-sensitive rows) ──> [no audit emission per FR-027]
```

The `PaymentIntentEnvelope` is **not** a row in any table; it is the
in-memory + serialised-JSON snapshot held on `carts.handoff_envelope_json`
once the cart is `frozen_handed_off`.

---

## Migration ordering (gated on §A2)

The migration tasks in S2 (gated on §A2) MUST author the four tables in
this order to satisfy FK ordering:

1. `carts` (no FKs out)
2. `cart_action_outbox` (FK → `carts`; FK to `cart_lines` is nullable)
3. `cart_lines` (FKs → `carts`, `cart_action_outbox`)
4. `cart_line_discount_placeholders` (FKs → `carts`, `cart_lines`)

Append-only triggers on `cart_action_outbox` MUST be installed in the
same migration as the table itself; existing tests for 004's
`audit_events` trigger are the reference pattern.

---

**End of data model.** No SQL is authored here. The migration tasks in
S2 derive the SQL from this description and submit it for §A2 review.
The Constitution P4 (append-only audit) check applies to
`cart_action_outbox` only; `carts`, `cart_lines`, and
`cart_line_discount_placeholders` are intentionally mutable (rationale
documented in coordination.md §A2 row).
