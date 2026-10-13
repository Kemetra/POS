-- RT-441 (RT-116 S6, §5.2 / §7.1) — `carts.cancellation_reason` gains
-- `manager_cancelled_held`: a manager cancelled another operator's held draft
-- through manager recovery. (The contract named this migration 0038; that
-- number was taken, so it takes the next free one.)
--
-- [GATED] approval: the owner approved the MA-1 / MA-2 / PK-2 / S6 migrations
-- on 2026-10-12 (session answer "approve all"; RT-441).
--
-- ## Why a rebuild
--
-- SQLite cannot ALTER a CHECK constraint in place, so this is the canonical
-- rebuild (as 0019): create the new table with the corrected schema, copy
-- every row, drop the old, rename the new into place, re-create the indexes.
-- The schema is byte-for-byte 0008's except the one CHECK, which now lists
-- `manager_cancelled_held` as its fourth value.
--
-- No table references `carts` (0008 omits FOREIGN KEY clauses by design), so
-- the runner's default transaction wrap is enough: no `foreign_keys = OFF`.
-- Indexes follow the old table on DROP and are re-created below: 0008's
-- three and 0046's partial owner-key index.
--
-- ## Rollback
--
-- Rebuild again with 0008's CHECK. Rows cancelled `manager_cancelled_held`
-- must first be rewritten to `cashier_voided` (or removed), or the copy fails.

CREATE TABLE carts_new (
  cart_id                   TEXT    NOT NULL PRIMARY KEY,
  tenant_id                 TEXT    NOT NULL,
  branch_id                 TEXT    NOT NULL,
  terminal_id               TEXT    NOT NULL,
  owning_operator_id        TEXT    NOT NULL,
  operator_session_id       TEXT    NOT NULL,

  state                     TEXT    NOT NULL
                            CHECK (state IN (
                              'empty', 'editing', 'discount_pending_attribution',
                              'handing_off', 'frozen_handed_off', 'cancelled'
                            )),

  cart_subtotal_minor       INTEGER NOT NULL DEFAULT 0
                            CHECK (cart_subtotal_minor >= 0),

  created_at                TEXT    NOT NULL,
  updated_at                TEXT    NOT NULL,
  frozen_at                 TEXT,
  cancelled_at              TEXT,
  cancellation_reason       TEXT
                            CHECK (cancellation_reason IS NULL OR cancellation_reason IN (
                              'cashier_voided', 'manager_voided_post_handoff', 'session_ended',
                              'manager_cancelled_held'
                            )),

  handoff_envelope_json     TEXT,

  last_action_id            TEXT
);

-- Explicit column list: a column added to `carts` but not mirrored here fails
-- loud instead of being dropped.
INSERT INTO carts_new (
  cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
  state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
  cancellation_reason, handoff_envelope_json, last_action_id
)
SELECT
  cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
  state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
  cancellation_reason, handoff_envelope_json, last_action_id
FROM carts;

DROP TABLE carts;

ALTER TABLE carts_new RENAME TO carts;

CREATE INDEX IF NOT EXISTS idx_carts_tenant_branch
  ON carts (tenant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_carts_owning_operator
  ON carts (owning_operator_id);

CREATE INDEX IF NOT EXISTS idx_carts_state
  ON carts (state);

CREATE INDEX IF NOT EXISTS idx_carts_owner_key
  ON carts (tenant_id, branch_id, terminal_id, owning_operator_id)
  WHERE state <> 'cancelled';
