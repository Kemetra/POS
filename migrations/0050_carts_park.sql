-- RT-440 (PK-2, spec 024 §2 K5 / R-7) — Park v1: a parked sale is an
-- ordinary `editing` cart with `parked_at` set. No new cart state, no
-- `cart_action_outbox` rebuild, no new outbox kind.
--
-- [GATED] approval: the owner approved the MA-1 / MA-2 / PK-2 / S6 migrations
-- on 2026-10-12 (session answer "approve all"; recorded in 0049's header).
-- The contract named this migration 0047; that number and 0048 / 0049 were
-- taken first, so it takes the next free one.
--
-- ## What it adds (additive only)
--
--   • `carts.parked_at`   — set by `cart.park`, cleared by `cart.resume`.
--   • `carts.park_label`  — optional, at most 40 characters. Local only: it is
--     never written to an audit payload, a log or a sync body (spec 024 §7).
--   • `idx_carts_parked`  — partial index for the per-terminal limit (K2) and
--     the owner's list (§3.2).
--   • `cart_park_actions` — the durable idempotency record of every successful
--     park and resume (R-7): append-only, on the `cart_action_outbox` pattern.
--
-- `ALTER TABLE ... ADD COLUMN` leaves existing rows NULL (not parked). Both
-- columns are nullable with no default, so SQLite adds them without a
-- rebuild. A later `carts` rebuild (as 0049) MUST carry both columns in its
-- explicit column list.
--
-- ## Rollback
--
-- Resume (or cancel) every parked sale first, then: DROP the two triggers,
-- the table and the index, and rebuild `carts` without the two columns
-- (0049's rebuild is the template). Nothing else reads them.

ALTER TABLE carts ADD COLUMN parked_at TEXT NULL;

ALTER TABLE carts ADD COLUMN park_label TEXT NULL
  CHECK (park_label IS NULL OR length(park_label) <= 40);

CREATE INDEX IF NOT EXISTS idx_carts_parked
  ON carts (tenant_id, branch_id, terminal_id, owning_operator_id)
  WHERE parked_at IS NOT NULL AND state = 'editing';

CREATE TABLE IF NOT EXISTS cart_park_actions (
  idempotency_key TEXT NOT NULL PRIMARY KEY,
  cart_id         TEXT NOT NULL,
  action_kind     TEXT NOT NULL CHECK (action_kind IN ('cart.park', 'cart.resume')),
  request_hash    TEXT NOT NULL,
  outcome_json    TEXT NOT NULL,
  applied_at      TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_cart_park_actions_no_update
BEFORE UPDATE ON cart_park_actions
BEGIN
  SELECT RAISE(ABORT, 'cart_park_actions is append-only: UPDATE is denied');
END;

CREATE TRIGGER IF NOT EXISTS trg_cart_park_actions_no_delete
BEFORE DELETE ON cart_park_actions
BEGIN
  SELECT RAISE(ABORT, 'cart_park_actions is append-only: DELETE is denied');
END;
