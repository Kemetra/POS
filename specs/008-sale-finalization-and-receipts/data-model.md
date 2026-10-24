# Data Model: Sale Finalization & Receipts (Phase 1)

**Feature ID:** 008-sale-finalization-and-receipts
**Plan:** [./plan.md](./plan.md) v1.0
**Spec:** [./spec.md](./spec.md)
**Research:** [./research.md](./research.md)
**Created:** 2026-05-27
**Constitution version pinned:** v1.5.1

> 🚧 **CONCEPTUAL ONLY.** No SQL is authored by `/speckit-plan`. The
> migration files for the five new tables (`sales`, `print_events`,
> `drawer_events`, `sale_sync_outbox`, `sale_number_sequences`) are
> authored during Slice 1 under §A3. This file describes the entities,
> their fields, the invariants, and the relationships — the SQL shape
> is derived from this description by the migration tasks. No source
> code, no `*.sql`, no `*.ts` is created by this document.

---

## Overview

008 introduces **five** new local SQLite tables. Four are append-only
at the physical layer (UPDATE / DELETE denied by trigger per AD-3);
the fifth (`sale_number_sequences`) is the only mutable table, and
its only legal mutation is the per-day monotonic increment by the
sale-number allocator.

| Table | Purpose | Mutability |
|:--|:--|:--|
| `sales` | The durable, audit-anchor record of a finalized sale (one row per finalized sale). | **Physical append-only** (INSERT only; UPDATE / DELETE denied by trigger per AD-3). |
| `print_events` | Audit anchor for every print attempt against a sale. | **Physical append-only** (≥ 1 per finalized sale). |
| `drawer_events` | Audit anchor for every drawer-kick attempt against a sale. | **Physical append-only** (≤ 1 per sale). |
| `sale_sync_outbox` | Future-sync staging row. | **Physical append-only** (exactly 1 per finalized sale). |
| `sale_number_sequences` | Per-terminal per-calendar-day monotonic sale-number allocator (AD-7). | UPSERT-and-increment; primary key `(terminal_id, calendar_day_local)`. |

008 does NOT introduce a parallel audit table. Sale-related sensitive
actions emit into 004's existing `audit_events` table via the
existing emitter, extending its category catalogue with ten new
categories (per plan AD-9):

- `sale.finalized`
- `sale.finalization_refused`
- `sale.receipt.printed`
- `sale.receipt.reprinted`
- `sale.receipt.print_failed`
- `sale.receipt.print_retried_success`
- `sale.receipt.manual_override`
- `sale.drawer.opened`
- `sale.drawer.suppressed`
- `sale.drawer.failed`

---

## Entity: Sale

The durable record of a finalized sale. One row per
`envelope.handoff_action_id`. The row is **physically immutable**
after INSERT; reprints, drawer events, and print attempts append to
sub-tables, never mutate this row.

**Fields** *(behavioural; SQL types derived at migration-author time)*:

| Field | Shape | Notes |
|:--|:--|:--|
| `sale_id` | UUID v4 | Primary key. Allocated main-side at finalize. |
| `sale_number` | string | Canonical shape `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>` per AD-7. Globally unique per terminal per calendar day; unique index `(terminal_id, sale_number)`. |
| `receipt_number` | string | Equal to `sale_number` in 008 v1 (the plan locks this; a future feature MAY decouple them). Persisted explicitly so a future decoupling is additive. |
| `envelope_handoff_action_id` | UUID v4 | The `handoff_action_id` from the bound `PaymentIntentEnvelope v1`. **Unique index** — the idempotency anchor per FR-001 / AD-2. |
| `payment_attempt_id` | UUID v4 | The `payment_attempt_id` from 006's `payment_attempts` row that produced this sale. FK reference (no ON DELETE CASCADE; 006's row is also append-only at terminal state). |
| `envelope_cart_id` | UUID v4 | Cached from the envelope for audit / support-bundle correlation with 005. |
| `tenant_id` | UUID / string | From the bound `OperatorSession` and matched against `envelope.tenant_id`. |
| `branch_id` | UUID / string | From the bound `OperatorSession`. |
| `terminal_id` | UUID / string | From the bound `OperatorSession`. Drives the AD-7 allocator's composite key. |
| `terminal_label` | string | The human-friendly terminal label provisioned at 002 pairing. Cached on the Sale so the receipt slip can render it without re-fetching terminal config. |
| `selling_operator_id` | string (Clerk-backed) | The cashier who took the payment (inherited from 006's `payment_attempts.acting_operator_id`). Stable across sessions. |
| `selling_operator_display_name` | string | Cashier's display name at finalize time. Cached on the Sale because future-feature operator-renames must not change historical receipts. |
| `selling_operator_session_id` | UUID / string | The 004 operator session under which the payment was taken. Inherited from 006. |
| `subtotal_minor` | INTEGER (minor units) | ~~Snapshotted from `envelope.subtotal_minor`.~~ **RT-854 / RT-856 (doc 28 §3.3):** the amount charged before tax, taken from the settled attempt's amount due. It is the **net**: Σ line gross − Σ manual line discount (the envelope's `total_due_minor`), equal to the tender sum. The column keeps the name "subtotal" although the value is net; with no discount, net = gross. Source of truth for the totals on the slip. |
| `total_tax_minor` | INTEGER (minor units) | The **sale-level VAT total** in minor units (Clarifications 2026-05-27). May be 0 if the tenant's tax posture has no VAT on this sale. |
| `total_change_due_minor` | INTEGER (minor units) | Sum of `change_due_minor` across all `cash` tender lines in the settled attempt. May be 0 if no overpayment. |
| `tender_lines_summary_json` | JSON BLOB | The per-line tender summary from 006 (per 006 plan AD-9 payload shape) cached on the Sale for fast receipt-payload regeneration without re-reading 006's `payment_tender_lines`. The shape is the FR-017-listed minimum — generic tender_type label, applied amount, change_due_minor (cash only), `external_reference` (external_card_terminal only — only if 006 OQ-PLAN-5 resolves permissively per R-13), `voucher_authority_redemption_id` (internal_voucher only — only if 006 FR-017 / OQ-PLAN-7 resolves permissively). NO voucher code, NO voucher balance, NO PAN, NO any sensitive field — Constitution §P6 / §P7 enforced at finalize-time validation. |
| `settled_at` | UTC timestamp | The 006 settled-at timestamp. Inherited; immutable. |
| `finalized_at` | UTC timestamp | NOT NULL. Set at finalize. The receipt's "time of print" stamp is derived from this for the first-print template variant. |
| `tenant_tax_registration_id` | string | The tenant's tax-registration ID (cached from terminal config). Printed on the receipt footer. |
| `branch_name` | string | The branch's display name (cached from terminal config). Printed on the receipt header. |
| `branch_address` | string | The branch's address (cached from terminal config). Printed on the receipt header. |
| `local_calendar_day` | string (YYYY-MM-DD) | The local trading-day used by AD-7 to allocate the sale_number. Cached so the date stamp on the slip is derivable from the Sale row alone. |

**`lines_json` discount (RT-856, doc 28 §3.3).** Each `lines_json` element keeps
its gross `line_subtotal_minor`. A line with a manual discount also carries an
optional `discount` object, frozen at finalize from the envelope placeholder and
its `cart.discount.manager_authorized` audit row: `kind`, `value`,
`amount_minor`, `placeholder_id`, `reason_code`, `authority_source`
(`cashier_approval` | `manager_session`), `approver_role` (only when the audit
row recorded it) and `approver_operator_id`. It is a JSON shape in the existing
TEXT column, with no DDL. The receipt reads only `kind`, `value` and
`amount_minor`.

**Invariants:**

1. **`envelope_handoff_action_id` is unique.** A unique index on this
   column enforces the idempotency rule (Constitution §P5; FR-001 /
   SC-009). Duplicate finalize is rejected by the unique constraint
   AND by the AD-2 listener's pre-check.
2. **`sale_number` is unique per terminal per calendar day.**
   Composite unique index on `(terminal_id, sale_number)` enforces
   AD-7's allocator output is monotonic + non-colliding.
3. **Physical append-only.** SQLite triggers deny `UPDATE` and
   `DELETE` on `sales`. The only legal DML is `INSERT`.
4. **Tenant / branch / terminal MUST match the bound
   `OperatorSession`.** Validated at finalize-time; mismatch →
   finalization refused with reason `tenant_isolation` (mirrors
   005 / 006 pattern). Audit event `sale.finalization_refused`
   emitted.
5. **Money columns are INTEGER minor units.** `subtotal_minor`,
   `total_tax_minor`, `total_change_due_minor` are guarded by
   `Number.isSafeInteger` at allocate-time and at every read.
   Constitution §II.
6. **`tender_lines_summary_json` MUST NOT contain sensitive fields.**
   Finalize-time validation refuses the INSERT if a forbidden field
   (PAN / CVV / voucher code / etc. per FR-070 / FR-071) is
   detected in the payload from 006. The refusal is a defensive
   guard: 006 already does not emit those fields, but 008's
   finalize-time check ensures the rule holds at the integrity
   layer.

**No mutable columns.** Per AD-3, there is no `last_printed_at`,
`reprint_count`, `last_drawer_opened_at`, or any field that tracks
post-finalize state on the Sale row. Those projections come from
`print_events` and `drawer_events`.

---

## Entity: PrintEvent

Append-only audit anchor for every print attempt against a sale. One
row per print attempt; many per sale (first print + retries +
reprints + manual-override).

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `print_event_id` | UUID v4 | Primary key. |
| `sale_id` | UUID v4 | FK to `sales.sale_id`. NOT NULL. Indexed. |
| `outcome` | enum | One of: `success`, `failure`, `manual_override`. |
| `purpose` | enum | One of: `first_print`, `reprint`, `retry_after_failure`. Distinguishes the audit-event category (per AD-9). |
| `render_path` | enum or NULL | One of `escpos_direct` / `os_print`. NULL when `outcome='manual_override'` (no render path was used). |
| `acting_operator_id` | string (Clerk-backed) | The operator who *initiated* this print event. For `first_print` this equals the Sale's `selling_operator_id`; for `reprint` and `retry_after_failure` this is the *current* signed-in operator (cashier-permitted per AD-10). |
| `acting_operator_session_id` | UUID / string | The 004 operator session under which the print event ran. |
| `duplicate_copy_sequence_number` | INTEGER or NULL | 1 for the first reprint of a sale, 2 for the second, etc. NULL when `purpose ∈ ('first_print', 'retry_after_failure')`. Derived from `SELECT COUNT(*) FROM print_events WHERE sale_id = … AND purpose='reprint' AND outcome='success'` at INSERT time. |
| `failure_reason` | enum or NULL | NULL unless `outcome='failure'`. Closed set: `printer_offline`, `printer_out_of_paper`, `printer_jam`, `os_print_error`, `escpos_write_failure`, `escpos_status_unknown`. |
| `previous_failed_print_event_ids` | JSON array of UUIDs | NULL unless `purpose='retry_after_failure'`. References the prior failed print events this retry attempts to recover from. Enables the `sale.receipt.print_retried_success` audit event payload. |
| `printed_at` | UTC timestamp | NOT NULL. Set at INSERT. |

**Invariants:**

1. **Physical append-only.** SQLite triggers deny `UPDATE` and
   `DELETE`.
2. **`(sale_id, purpose, outcome)` ordering rule:** the first
   row with `purpose='first_print' AND outcome='success'` for a
   sale anchors the receipt number for future reprints. Reprints
   reference this row's `printed_at` only for audit; the slip's
   *original* timestamp comes from the Sale's `finalized_at`, not
   from any PrintEvent.
3. **Reprint precondition** (enforced by `receipts.reprint`
   handler): a reprint INSERT is permitted only if there exists a
   prior `print_events` row for this sale with
   `(purpose='first_print' AND outcome='success') OR
   (purpose='retry_after_failure' AND outcome='success')`.
4. **First-print-after-manual-override edge case:** if the latest
   non-success-outcome row for this sale is
   `purpose='first_print' AND outcome='manual_override'`, the next
   successful print MUST INSERT with
   `purpose='retry_after_failure' AND outcome='success'`, NOT
   `purpose='reprint'`. The duplicate-copy marker is therefore
   absent on this slip. Per FR-052 + spec Edge Cases.
5. **Audit-event-emission rule:** every PrintEvent INSERT
   triggers exactly one canonical 004 `audit_events` row in the
   same transaction. The audit-event category derives from
   `(purpose, outcome)` per the AD-9 catalogue table.

---

## Entity: DrawerEvent

Append-only audit anchor for every drawer-kick attempt against a
sale. At most one row per sale (FR-040 — drawer kicks only on the
first print of a cash-inclusive sale).

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `drawer_event_id` | UUID v4 | Primary key. |
| `sale_id` | UUID v4 | FK to `sales.sale_id`. NOT NULL. Indexed. **Unique index** on `(sale_id)` — at most one DrawerEvent per sale (FR-053 double-kick suppression). |
| `outcome` | enum | One of: `opened`, `suppressed`, `failed`. |
| `suppression_reason` | enum or NULL | NULL unless `outcome='suppressed'`. Closed set: `cashless_tender_mix` only (per FR-042; revised 2026-05-27 post-external-review R2 — the `reprint` enum value was removed as unreachable, because the `UNIQUE (sale_id)` constraint below makes a second DrawerEvent INSERT for a reprint impossible). |
| `failure_reason` | enum or NULL | NULL unless `outcome='failed'`. Closed set: `printer_dk_failure`, `os_error`, `no_drawer_configured` (per FR-043). |
| `last_successful_open_at_for_terminal` | UTC timestamp or NULL | When `outcome='failed'`, populated with the most recent `attempted_at` from any prior DrawerEvent on this terminal **where `outcome='opened'`** (or NULL if the drawer has never successfully opened on this terminal). Required by Constitution Principle IV. *(Revised 2026-05-27 post-external-review R3 — original prose named a non-existent `opened_at` column; the column is `attempted_at` and the WHERE clause was missing.)* |
| `triggering_print_event_id` | UUID v4 or NULL | The PrintEvent row that triggered this drawer-kick attempt. NOT NULL for every legal INSERT (revised 2026-05-27 post-R2 — the NULL case for reprint-suppression went away with the dead `'reprint'` branch). |
| `terminal_id` | UUID / string | Inherited from the Sale; cached for efficient `last_successful_open_at_for_terminal` lookup. |
| `attempted_at` | UTC timestamp | NOT NULL. Set at INSERT. |

**Invariants:**

1. **Physical append-only.**
2. **Unique on `(sale_id)`.** A sale cannot have two DrawerEvents
   (FR-053 enforcement at the schema layer; the application layer
   ALSO checks before attempting a kick, but the unique index is
   the load-bearing guard).
3. **Audit-event-emission rule:** every DrawerEvent INSERT
   triggers exactly one canonical 004 `audit_events` row in the
   same transaction. The audit-event category derives from
   `outcome`:
   - `opened` → `sale.drawer.opened`
   - `suppressed` → `sale.drawer.suppressed`
   - `failed` → `sale.drawer.failed`
4. **Cashless suppression rule** *(revised 2026-05-27 post-external-review R2)***:**
   when the Sale's `tender_lines_summary_json` contains no applied
   `cash` line, the DrawerEvent for the first-print MUST be
   `outcome='suppressed' AND suppression_reason='cashless_tender_mix'`.
   **Reprints do NOT emit a fresh DrawerEvent** — they are blocked
   by Invariant 2 (`UNIQUE (sale_id)`) and the application layer
   does not attempt an INSERT in the reprint flow. The audit trail
   for "reprint considered drawer-kick" is captured by the
   `sale.receipt.reprinted` audit event combined with the absence
   of a second DrawerEvent row for this sale. (Original draft of
   this invariant erroneously named a `suppression_reason='reprint'`
   value; that branch was unreachable and has been removed —
   external review finding R2.)

---

## Entity: SaleSyncOutbox

Future-sync staging row. Exactly one row per finalized sale
(FR-060). Append-only at the physical layer. 008 NEVER mutates this
row; the future sync engine adds columns or new state values via
additive migration.

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `outbox_row_id` | UUID v4 | Primary key. |
| `sale_id` | UUID v4 | FK to `sales.sale_id`. NOT NULL. **Unique index** on `(sale_id)` — exactly one outbox row per sale. |
| `envelope_handoff_action_id` | UUID v4 | Carried for cross-feature correlation. The future sync engine MAY use this as the idempotency key against the backend. |
| `tenant_id` | UUID / string | For tenant-isolation queries by the future sync engine (Constitution §P17). |
| `branch_id` | UUID / string | Same purpose. |
| `terminal_id` | UUID / string | Same purpose. |
| `state` | enum | One of: `pending` (only at insert by 008). Future sync engine MAY extend the enum via additive migration. |
| `enqueued_at` | UTC timestamp | NOT NULL. Set at INSERT (inside the AD-2 atomic finalize transaction). |

**Invariants:**

1. **Physical append-only by 008.** SQLite triggers deny `UPDATE`
   and `DELETE` *for 008's lifecycle*. The future sync engine MAY
   ship a migration that relaxes the UPDATE-deny trigger (e.g. to
   allow `state` transitions to `sent` / `failed`); 008 itself does
   not relax it.
2. **`(sale_id)` is unique.** Exactly one outbox row per sale.
3. **The row is written in the same SQLite transaction as the
   `sales` row INSERT and the `audit_events` `sale.finalized` row.**
   AD-2 atomicity is the load-bearing guarantee here.
4. **No sensitive fields.** The outbox carries only `sale_id` +
   `envelope_handoff_action_id` + tenant / branch / terminal +
   timestamps. NO receipt payload, NO tender breakdown, NO
   operator id (those live on the Sale and the audit row).
   Constitution §P7 / §P11.

---

## Entity: SaleNumberSequences

The AD-7 sale-number allocator's state. **The only mutable 008
table.** Its only legal mutation is the per-day monotonic increment
inside the AD-2 atomic finalize transaction.

**Fields:**

| Field | Shape | Notes |
|:--|:--|:--|
| `terminal_id` | UUID / string | Composite primary key. |
| `calendar_day_local` | string (YYYY-MM-DD) | Composite primary key. The local trading-day anchored on the terminal's local timezone. |
| `next_sequence` | INTEGER | The next monotonic sequence number to allocate. Starts at 1 for each new `(terminal_id, calendar_day_local)` pair. UPSERT-and-increment inside AD-2 finalize. |
| `updated_at` | UTC timestamp | Last increment timestamp. Diagnostic only. |

**Invariants:**

1. **Composite primary key `(terminal_id, calendar_day_local)`.**
   This is the load-bearing collision-impossibility guarantee.
2. **UPSERT-and-increment is the ONLY DML.** Implementation:
   `INSERT OR REPLACE` with `next_sequence = next_sequence + 1` (or
   the SQLite `ON CONFLICT … DO UPDATE … SET next_sequence =
   next_sequence + 1` idiom). The increment happens inside the
   AD-2 atomic finalize transaction; SQLite's transaction-level
   isolation makes the increment safe under concurrent finalize
   attempts (even though 006's per-terminal partial unique index
   on `payment_attempts` already serialises finalizes per terminal).
3. **The allocator never decrements.** A failed finalize after the
   sequence has incremented leaves a "gap" in the sale-number
   sequence. This is acceptable; the cashier-quotability rule
   does NOT require gap-free sequences. The legacy POS has the
   same property.
4. **Midnight roll boundary.** When the local calendar day changes
   (terminal clock crosses midnight), a finalize-in-progress that
   started at 23:59:59 and commits at 00:00:00 the next day uses
   the *commit-time* calendar day for `local_calendar_day` on the
   Sale, which is the same day used by the allocator. Race-window
   is sub-second; tested by the Slice 1 midnight-boundary
   integration test.

---

## Relationships

```text
006-payments-tender                                 008-sale-finalization-and-receipts
─────────────────────                              ──────────────────────────────────
payment_attempts ─────┐
   (state='settled')  │  via envelope.handoff_action_id  ┌── sales (one)
                      └────────────────────────────────► │     │
                                                         │     ├── print_events (many; append-only)
                                                         │     │     │
                                                         │     │     └─► audit_events (one per PrintEvent)
                                                         │     │
                                                         │     ├── drawer_events (≤ 1; append-only)
                                                         │     │     │
                                                         │     │     └─► audit_events (one per DrawerEvent)
                                                         │     │
                                                         │     ├── sale_sync_outbox (exactly 1; append-only)
                                                         │     │
                                                         │     └─► audit_events (sale.finalized)
                                                         │
                                                         └── (allocates sale_number via)
                                                              sale_number_sequences
                                                              (UPSERT-and-increment)
```

Notes on the diagram:

- The arrow from `payment_attempts` to `sales` is a *reference*, not
  a foreign-key cascade. 006's row is also physically append-only at
  terminal state; neither table is ever deleted.
- The `audit_events` arrows go to **004's existing table**, not a
  new one. The category enum is extended (per plan AD-9), but the
  schema is unchanged.
- The `sale_number_sequences` table has no row-level relationship to
  `sales`; it is a state machine the allocator owns. The composite
  key `(terminal_id, calendar_day_local)` is the only access path.

---

## Indices (plan-pinned)

The migration tasks under §A3 author these indices:

| Table | Index | Purpose |
|:--|:--|:--|
| `sales` | `UNIQUE (envelope_handoff_action_id)` | AD-2 idempotency (FR-001 / SC-009). |
| `sales` | `UNIQUE (terminal_id, sale_number)` | AD-7 sale-number uniqueness (FR-010). |
| `sales` | `INDEX (tenant_id, branch_id, terminal_id)` | Tenant-isolation queries (Constitution §P17). |
| `sales` | `INDEX (terminal_id, local_calendar_day)` | "Sales finalized today on this terminal" — receipt re-lookup for the cashier. |
| `print_events` | `INDEX (sale_id)` | Receipt reprint precondition check (Invariant 3 above). |
| `print_events` | `INDEX (sale_id, purpose, outcome, printed_at DESC)` | Latest-print-state projection (Invariant 4 above). |
| `drawer_events` | `UNIQUE (sale_id)` | FR-053 double-kick suppression (Invariant 2 above). |
| `drawer_events` | `INDEX (terminal_id, attempted_at DESC)` | `last_successful_open_at_for_terminal` lookup on failure-event INSERT. |
| `sale_sync_outbox` | `UNIQUE (sale_id)` | One outbox row per sale (FR-060). |
| `sale_sync_outbox` | `INDEX (tenant_id, branch_id, terminal_id, state, enqueued_at)` | Future sync-engine scan path. |
| `sale_number_sequences` | `PRIMARY KEY (terminal_id, calendar_day_local)` | AD-7 collision-impossibility. |

---

## Append-only triggers (plan-pinned)

For each of the four append-only tables (`sales`, `print_events`,
`drawer_events`, `sale_sync_outbox`), the §A3 migration tasks author
two triggers:

```text
CREATE TRIGGER <table>_deny_update BEFORE UPDATE ON <table>
  BEGIN
    SELECT RAISE(ABORT, '<table> is append-only — UPDATE denied (008 AD-3)');
  END;

CREATE TRIGGER <table>_deny_delete BEFORE DELETE ON <table>
  BEGIN
    SELECT RAISE(ABORT, '<table> is append-only — DELETE denied (008 AD-3)');
  END;
```

The trigger error text is intentionally specific so a future
refactor that accidentally adds an UPDATE statement gets a clear
error message rooted in this plan's AD-3 decision. (The 006
`payment_action_outbox` triggers follow the same pattern.)

The `sale_sync_outbox` triggers may be relaxed by a future
sync-engine migration (per Invariant 1 on SaleSyncOutbox above); the
other three tables' triggers are **permanent** under Constitution
§P4.

---

## Forbidden fields (validation at finalize-time)

The AD-2 finalize transaction performs a **defensive validation**
against the `tender_lines_summary_json` payload received from 006
before INSERT. The validation refuses the INSERT if ANY of the
following keys appear at any level of the JSON tree:

- `pan`, `card_pan`, `truncated_pan`, `cvv`, `track_data`, `track1`,
  `track2`, `cardholder_name`, `cardholder`, `holder_name`,
  `expiry`, `expiration`, `issuer_name`, `auth_payload`,
  `approval_code`, `cryptogram`, `terminal_receipt_text`,
  `receipt_text` (per FR-070; `issuer_name` added 2026-05-27
  post-CodeRabbit CR3)
- `voucher_code`, `voucher_balance`, `voucher_holder`,
  `voucher_holder_pii`, `voucher_redemption_intent_token`,
  `redemption_intent_token`, `intent_token`, `authority_payload`,
  `authority_response`, `raw_voucher_authority_response` (per FR-071)
- `pin`, `pin_hash`, `pin_record_id`, `password`, `jwt`,
  `device_token`, `attestation` (per FR-072; `pin_record_id` added
  2026-05-27 post-CodeRabbit CR3)
- `envelope_payload`, `raw_envelope`, `payment_intent_envelope` (the
  envelope itself; only `envelope_handoff_action_id` is permitted —
  per FR-074)

Detection of any of these keys → `sale.finalization_refused` audit
event with `refusal_reason='forbidden_field_in_tender_summary'`,
INSERT rejected, the finalize listener logs a high-severity event
(Sentry capture) — this is a **defence-in-depth guard**. 006 already
does not emit these fields, but the guard ensures the rule holds at
the integrity layer even if 006 ever drifts.

---

## Migration sequencing (Slice 1)

The §A3 migration tasks author the five new tables + triggers +
indices + the audit-category catalogue extension in a single
migration file pair (`up.sql` + `down.sql`). The migration runs
under 001's existing transactional migration runner; the migration
is a single SQLite transaction (all-or-nothing).

Migration ordering inside the up.sql:

1. `CREATE TABLE sales` + indices + triggers.
2. `CREATE TABLE print_events` + indices + triggers + FK to `sales`.
3. `CREATE TABLE drawer_events` + indices + triggers + FK to `sales`.
4. `CREATE TABLE sale_sync_outbox` + indices + triggers + FK to
   `sales`.
5. `CREATE TABLE sale_number_sequences` + primary key.
6. Insert ten new rows into 004's `audit_events_categories` lookup
   (or equivalent — exact schema depends on how 004 registers
   categories; the migration adapts to that schema).

Down migration: drop the tables in reverse order; remove the audit-
category lookup rows. Down migrations are best-effort under
Constitution §VI; the rollback strategy in §A5 production-readiness
prefers forward-fix over down migration for production-touching
data.

---

## Tenant / branch / terminal isolation

Every 008 table that holds a sale-correlated row carries
`tenant_id`, `branch_id`, `terminal_id`. Every query into 008 data
MUST scope by these three fields (Constitution §P17). The
indexes pinned above include these three fields in the indexed
prefix so the scope filter is the primary access path.

The future sync engine will scope by `tenant_id` at the support-
bundle / export boundary; 008's outbox table carries the three
fields explicitly so the sync engine does not need to JOIN to
`sales` for tenant isolation.

---

## Phase 1 status

**Data model authored.** All five new tables specified at the
behavioural / invariant level. The migration files are NOT authored
here; they are authored by the §A3 task in Slice 1 against this
description.
