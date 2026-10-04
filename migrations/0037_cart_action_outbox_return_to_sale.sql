-- RT-26 — Safe Checkout Back / Esc to the active sale.
--
-- Adds ONE value, 'cart.return_to_sale', to `cart_action_outbox.action_kind`.
-- Nothing else about the table changes: same columns, types, defaults,
-- indexes and append-only triggers as 0009.
--
-- ## Why this migration is necessary
--
-- `cart.returnToSale` moves a `frozen_handed_off` cart back to `editing`. Every
-- cart mutation writes one append-only `cart_action_outbox` row in the same
-- transaction as the state change: it is the cart's lineage (Constitution P4),
-- the action's idempotency key (P5 — a replayed Back returns the original
-- outcome), and the target of `carts.last_action_id`. 0009 constrains
-- `action_kind` with a CHECK list, and no existing value truthfully describes
-- this transition (reusing `cart.void` or `cart.cancel.post_handoff` would
-- record a cancellation that did not happen). SQLite cannot alter a CHECK
-- constraint in place (https://www.sqlite.org/lang_altertable.html), so the
-- table is rebuilt.
--
-- ## Why the default transaction wrap is enough
--
-- `cart_action_outbox` has no FK constraints (0009: "No FK constraints") and no
-- table references it, so no `PRAGMA foreign_keys` dance is needed (unlike
-- 0019). The runner wraps this file in one transaction: the rebuild commits
-- whole or rolls back whole. DROP TABLE removes the table's triggers BEFORE its
-- implicit delete, so the append-only DELETE trigger does not fire; it is
-- re-created on the new table below.
--
-- ## No row is lost or rewritten
--
-- The copy uses an explicit column list with no filter. Every existing row
-- satisfies the widened CHECK (it is a strict superset), so the INSERT…SELECT
-- cannot fail on data that 0009 accepted.
--
-- ## Runner-guaranteed single run
--
-- Like 0019/0036 this file is not file-level idempotent (DROP/RENAME); the
-- runner records it in `schema_migrations` and never re-runs it.

CREATE TABLE cart_action_outbox_new (
  action_id                 TEXT    NOT NULL PRIMARY KEY,
  cart_id                   TEXT    NOT NULL,
  -- Nullable: cart-level action kinds carry no line.
  line_id                   TEXT,

  action_kind               TEXT    NOT NULL
                            CHECK (action_kind IN (
                              'cart.create',
                              'cart.line.add',
                              'cart.line.update',
                              'cart.line.merge',
                              'cart.line.remove',
                              'cart.line.note_set',
                              'cart.discount_placeholder.add',
                              'cart.discount_placeholder.remove',
                              'cart.void',
                              'cart.handoff_to_payment',
                              'cart.cancel.post_handoff',
                              'cart.discount.above_threshold',
                              'cart.discarded_on_session_end',
                              'cart.return_to_sale'
                            )),

  acting_operator_id        TEXT    NOT NULL,
  -- Manager identity for manager-attributed actions; otherwise NULL.
  attribution_operator_id   TEXT,
  operator_session_id       TEXT    NOT NULL,

  -- Canonicalised JSON of the action input, post-redaction (NFR-006).
  payload_json              TEXT    NOT NULL,

  applied_at                TEXT    NOT NULL,
  -- Reserved for a future backend-sync pipeline; not used in 005.
  synced_at                 TEXT
);

INSERT INTO cart_action_outbox_new (
  action_id, cart_id, line_id, action_kind,
  acting_operator_id, attribution_operator_id, operator_session_id,
  payload_json, applied_at, synced_at
)
SELECT
  action_id, cart_id, line_id, action_kind,
  acting_operator_id, attribution_operator_id, operator_session_id,
  payload_json, applied_at, synced_at
FROM cart_action_outbox;

DROP TABLE cart_action_outbox;

ALTER TABLE cart_action_outbox_new RENAME TO cart_action_outbox;

CREATE INDEX IF NOT EXISTS idx_cart_action_outbox_cart
  ON cart_action_outbox (cart_id);

CREATE INDEX IF NOT EXISTS idx_cart_action_outbox_line
  ON cart_action_outbox (line_id);

CREATE INDEX IF NOT EXISTS idx_cart_action_outbox_action_kind
  ON cart_action_outbox (action_kind);

-- Append-only: deny UPDATE. Re-created exactly as 0009 declared it.
CREATE TRIGGER IF NOT EXISTS trg_cart_action_outbox_no_update
BEFORE UPDATE ON cart_action_outbox
BEGIN
  SELECT RAISE(ABORT, 'cart_action_outbox is append-only: UPDATE is denied');
END;

-- Append-only: deny DELETE. Re-created exactly as 0009 declared it.
CREATE TRIGGER IF NOT EXISTS trg_cart_action_outbox_no_delete
BEFORE DELETE ON cart_action_outbox
BEGIN
  SELECT RAISE(ABORT, 'cart_action_outbox is append-only: DELETE is denied');
END;
