<!--
RT-440 (PK-2) — §A2 migration-safety record for migration 0050_carts_park
(Park v1, spec 024 K5 / R-7). Written with the implementation, before merge.
-->

# §A2 — Migration safety: `0050_carts_park` (RT-440)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-440 — PK-2, Park v1 main and bridge (spec 024) |
| Gate | §A2 — migration safety (`[GATED]`) |
| Migration | `migrations/0050_carts_park.sql` |
| Approval | The owner approved the MA-1 / MA-2 / PK-2 / S6 migrations on 2026-10-12 ("approve all"; recorded in 0049's header). This record is **accepted under that owner delegation**; the owner has not reviewed this file. |
| Baseline | `origin/main` at `f9d3bb9` |
| Prepared by | The implementation agent (Claude Code), 2026-10-13. **Not an independent review.** |
| Verdict | **Agent-assessed PASS.** Additive only: no rebuild, no data rewrite, no new outbox kind. |

## 2. What it changes

| Change | Kind | Notes |
| :-- | :-- | :-- |
| `carts.parked_at TEXT NULL` | `ALTER TABLE ... ADD COLUMN` | No default; existing rows read NULL (not parked). |
| `carts.park_label TEXT NULL CHECK (park_label IS NULL OR length(park_label) <= 40)` | `ALTER TABLE ... ADD COLUMN` | The spec's CHECK verbatim. Main also trims and refuses an empty or non-plain label (`park-rules.ts`). |
| `idx_carts_parked ON carts (tenant_id, branch_id, terminal_id, owning_operator_id) WHERE parked_at IS NOT NULL AND state = 'editing'` | Partial index | Serves the per-terminal limit and the owner's list. |
| `cart_park_actions` | New table | `idempotency_key` PK, `action_kind IN ('cart.park', 'cart.resume')`, request hash, outcome, time. |
| `trg_cart_park_actions_no_update`, `trg_cart_park_actions_no_delete` | Triggers | Append-only, on the `cart_action_outbox` pattern (0009). |

The number: the contract named 0047. 0047, 0048 and 0049 were taken by MA-1, MA-2 and S6 first, so this is the next free number. A test pins that 0050 directly follows 0049 and is the only `0050_` file.

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A2-1 | **Additive only; no rebuild.** | Two `ADD COLUMN`s with no default and nullable, so SQLite adds them in place. No table is dropped or copied. | PASS |
| A2-2 | **Existing rows survive and keep their meaning.** | Test "keeps rows written before it, which read as not parked": every migration up to 0049, then a cart row, then 0050 → the row is intact with `parked_at`/`park_label` NULL. | PASS |
| A2-3 | **Constraints hold.** | 40-character label accepted, 41 refused (`CHECK constraint failed`). `cart_park_actions` refuses an unknown kind and a duplicate key. | PASS |
| A2-4 | **Append-only idempotency record.** | UPDATE and DELETE on `cart_park_actions` abort with the trigger message (test). | PASS |
| A2-5 | **Runs inside the runner's transaction.** | No `PRAGMA`, no `foreign_keys = OFF`, no statement that cannot run in a transaction. | PASS |
| A2-6 | **Readers of `carts` stay correct.** | The new columns are read only by the park store, the K5 exclusions (`held-carts.ts`, `cart-store.ts`, `lock-state-reader.ts`), the shift-close count and `manager-recovery.ts` (which now reads `parked_at` directly instead of probing `PRAGMA table_info`). The 59 test files that hand-pick cart migrations now include 0050. | PASS |
| A2-7 | **No secret or personal data in a new column.** | The label is free text the UI warns against using for customer data (PK-3). It is never copied out of `carts`: not in audit, logs, outbox, `cart_park_actions` or sync (test "the park label never leaves the carts row"). | PASS |

## 4. Forward compatibility

A later rebuild of `carts` (as 0049 did) must list both new columns in its explicit `INSERT ... SELECT` column list, or the copy drops them. 0050's header says so.

## 5. Rollback

Resume or cancel every parked sale first. Then drop the two triggers, `cart_park_actions` and `idx_carts_parked`, and rebuild `carts` without the two columns, using 0049's rebuild as the template. Nothing outside Park v1 reads them.

## 6. Validation

- `src/main/migrations/__tests__/0050-carts-park.test.ts`: 5 tests passed.
- The cart, held-cart, recovery, lock-state, payments and sales suites that load cart migrations: green with 0050 added.

## 7. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
| Agent assessment | Claude Code | 2026-10-13 | PASS |
| Owner | | | Accepted under the 2026-10-12 delegation ("approve all"); personal review *pending* |
