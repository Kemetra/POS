-- RT-541 (RT-534 S5) — index for the local sales history read.
--
-- [GATED] approval: Jira RT-541 comment 12093 (owner, 2026-10-16) authorises
-- this migration, limited to the one index RT-541 describes. 0055 is the next
-- free number.
--
-- ## Why
--
-- `sales.list` reads this device's sales over a range of store business days
-- (Africa/Cairo). The day is derived from `finalized_at`, never from
-- `local_calendar_day` (which holds UTC dates on older rows), so the range
-- becomes a half-open `finalized_at` window in the session's tenant and
-- branch, newest first. Without this index that read scans every sale of the
-- terminal and sorts them.
--
-- ## Shape
--
-- Index only: no new column, no data change, no backfill. `sales` is
-- append-only (0021); an index is DDL, not a row UPDATE, so the deny triggers
-- do not fire.
--
-- ## Rollback
--
-- `DROP INDEX IF EXISTS idx_sales_tenant_branch_finalized_at;` restores the
-- prior schema. No data depends on the index.

CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch_finalized_at
  ON sales (tenant_id, branch_id, finalized_at);
