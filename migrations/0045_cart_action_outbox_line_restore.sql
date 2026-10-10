-- RT-254 — main-authoritative cart Undo (contract RT-245).
--
-- Adds ONE value, 'cart.line.restore', to `cart_action_outbox.action_kind`.
-- Nothing else about the table changes: same columns, types, defaults,
-- indexes and append-only triggers as 0009/0037. Owner [GATED] approval is
-- recorded on RT-254 (2026-10-10).
--
-- ## Why this migration is necessary
--
-- `cart.undoLast` undoes a just-completed line delete by clearing `removed_at`
-- on the SAME soft-removed row. Every cart mutation writes one append-only
-- `cart_action_outbox` row in the same transaction as the state change: it is
-- the cart's lineage, the action's idempotency key (a replayed Undo returns the
-- original outcome), and the target of `carts.last_action_id`. No existing
-- value truthfully describes a restore (reusing `cart.line.add` would record a
-- new line that was never resolved from the catalogue). The other two Undo
-- inverses keep the existing truthful kinds (`cart.line.remove`,
-- `cart.line.update`). SQLite cannot alter a CHECK constraint in place
-- (https://www.sqlite.org/lang_altertable.html), so the table is rebuilt —
-- exactly as 0037 did.
--
-- ## Why the default transaction wrap is enough
--
-- `cart_action_outbox` has no FK constraints and no table references it, so no
-- `PRAGMA foreign_keys` dance is needed. The runner wraps this file in one
-- transaction: the rebuild commits whole or rolls back whole. DROP TABLE
-- removes the table's triggers BEFORE its implicit delete, so the append-only
-- DELETE trigger does not fire; both triggers are re-created below.
--
-- ## No row is lost, rewritten or reordered
--
-- The copy uses an explicit column list with no filter, and carries `rowid`
-- explicitly: insertion order is load-bearing (the latest-handoff lookup and
-- Undo's "is the target the cart's newest action" check both order by rowid),
-- so it is preserved rather than left to the scan order. Every existing row
-- satisfies the widened CHECK (a strict superset of 0037's list).
--
-- ## Runner-guaranteed single run
--
-- Like 0037 this file is not file-level idempotent (DROP/RENAME); the runner
-- records it in `schema_migrations` and never re-runs it.

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
                              'cart.return_to_sale',
                              'cart.line.restore'
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
  rowid, action_id, cart_id, line_id, action_kind,
  acting_operator_id, attribution_operator_id, operator_session_id,
  payload_json, applied_at, synced_at
)
SELECT
  rowid, action_id, cart_id, line_id, action_kind,
  acting_operator_id, attribution_operator_id, operator_session_id,
  payload_json, applied_at, synced_at
FROM cart_action_outbox
ORDER BY rowid;

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
