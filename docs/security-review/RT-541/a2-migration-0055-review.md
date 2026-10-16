<!--
RT-541 (RT-534 S5) — §A2 migration-safety record for migration
0055_sales_finalized_at_index. Written with the implementation, before merge.
-->

# §A2 — Migration safety: `0055_sales_finalized_at_index` (RT-541)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-541 — RT-534 S5, local sales history read over a Cairo business-day range |
| Gate | §A2 — migration safety (`[GATED]`) |
| Migration | `migrations/0055_sales_finalized_at_index.sql` |
| Approval | Owner authorization in Jira RT-541 comment 12093 (2026-10-16): "start + approve the index", limited to the index RT-541 describes. |
| Baseline | `origin/main` at `e9caa3e` |
| Prepared by | The implementation agent (Claude Code), 2026-10-16, with an agent database review. **Not an independent human review.** |
| Verdict | **Agent-assessed PASS.** One index, nothing else. |

## 2. What it changes

| Change | Kind | Notes |
| :-- | :-- | :-- |
| `idx_sales_tenant_branch_finalized_at ON sales (tenant_id, branch_id, finalized_at)` | Index | Exactly the index the issue names. No column, table, trigger or data change. |

0055 is the next free number. A test pins that it is the only `0055_` file.

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A2-1 | **Additive only.** | One `CREATE INDEX IF NOT EXISTS` statement (test parses the file: one statement, an index). | PASS |
| A2-2 | **Existing rows survive.** | Test "applies to a database that already holds sales": rows and `PRAGMA table_info(sales)` unchanged, `integrity_check` ok. | PASS |
| A2-3 | **Append-only `sales` is untouched.** | An index is DDL; the 0021 deny triggers fire on row UPDATE/DELETE only. | PASS |
| A2-4 | **Idempotent.** | Re-running the SQL is a no-op (`IF NOT EXISTS`); the real runner applies it once (test). | PASS |
| A2-5 | **Runs inside the runner's transaction.** | No `PRAGMA`, nothing that cannot run in a transaction. | PASS |
| A2-6 | **The read uses it.** | `EXPLAIN QUERY PLAN` on the production `SALES_LIST_SQL` and `SALES_LIST_AFTER_SQL` shows `SEARCH sales USING INDEX idx_sales_tenant_branch_finalized_at (tenant_id=? AND branch_id=? AND finalized_at>? AND finalized_at<?)`, with and without `ANALYZE`, with the terminal and operator filters; without the index the planner falls back to `idx_sales_tenant_branch_terminal` plus a full sort. | PASS |

## 4. Known trade-offs (not changed: the authorization covers this index only)

- `terminal_id` and `sale_id` are not in the index. The terminal filter is applied to rows inside the window (this device's sales only), and the `sale_id` tie-break uses a temporary B-tree over each `finalized_at` group (`USE TEMP B-TREE FOR LAST TERM OF ORDER BY`). Both stay bounded by the 31-day window on one till.
- The range compares `finalized_at` as TEXT. Every writer stores `Date#toISOString` (`finalize-transaction.ts`), and the bounds and the cursor use the same format.

## 5. Rollback

`DROP INDEX IF EXISTS idx_sales_tenant_branch_finalized_at;` No data depends on it; `sales.list` keeps working, more slowly.

## 6. Validation

- `src/main/migrations/__tests__/0055-sales-finalized-at-index.test.ts`: 4 passed.
- `tests/unit/main/sales/repositories/sales.repository.list.test.ts`: plan and keyset tests passed.

## 7. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
