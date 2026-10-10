-- RT-352 (RT-116 S4a, §7.1) — owner-key index for held draft carts.
--
-- [GATED] approval: Jira RT-352 authorises this migration (index only). The
-- RT-116 contract named it 0037; that number was taken by RT-26, and 0046 is
-- the next free number.
--
-- ## Why
--
-- RT-115 D3.2: a draft cart outlives its operator session. It is held for its
-- operator on its terminal and re-attached when that operator next signs in,
-- including after a restart. Sign-in therefore looks a cart up by its OWNER
-- KEY — (tenant_id, branch_id, terminal_id, owning_operator_id) — instead of
-- by the dead operator_session_id.
--
-- ## Shape
--
-- Index only: no new column, no data change, no backfill. Cancelled carts
-- are never held, so they are left out of the index.
--
-- ## Rollback
--
-- `DROP INDEX IF EXISTS idx_carts_owner_key;` restores the prior schema. No
-- data depends on the index.

CREATE INDEX IF NOT EXISTS idx_carts_owner_key
  ON carts (tenant_id, branch_id, terminal_id, owning_operator_id)
  WHERE state <> 'cancelled';
