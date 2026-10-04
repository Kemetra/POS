-- RT-15 S4 — the cash payout of a confirmed return, and the slip facts of its lines.
--
-- Jira RT-15 decision D-f authorizes POS-local migrations for this story. Two
-- new tables; nothing existing is altered (0039's tables, columns and
-- triggers are unchanged).
--
-- ## Why a payout row (and why 0039 alone is not enough)
--
-- 0039 allows exactly one move after confirmation: `confirmed -> paid_out`,
-- and `paid_out` is terminal. A payout has a physical step in the middle (the
-- drawer kick) that the till cannot undo, so the order is:
--
--   1. start  — INSERT the payout row (with its `payout_started` audit, one
--               transaction): the payout is claimed BEFORE the drawer opens;
--   2. kick   — the drawer;
--   3. paid   — only after the kick reported `opened` (or the operator
--               attested a manual payout): UPDATE the row's paid facts, move
--               the header to `paid_out`, and audit it (one transaction);
--   4. slip   — print, after the commit.
--
-- A crash between 1 and 3 leaves `confirmed` + a started payout. The till
-- then never offers a fresh payout (the drawer may already have opened and
-- the cash may be gone); an operator must complete it explicitly. Without a
-- durable "started" mark (0039 has no state for it and a confirmed header can
-- only move to paid_out) a restart would offer a second payout.
--
-- ## return_payouts
--
--   started_*   who started the payout, in which session, when (immutable);
--   paid_*      who completed it and when, set once, all together;
--   method      'drawer' (the kick reported opened) or 'manual' (the operator
--               paid from a drawer opened by hand and attested it).
--
-- A row is inserted only for a `confirmed` header and only unpaid; it is
-- completed once; it is never deleted. `paid_operator_name` is the operator's
-- display name, printed on the slip as on a sale receipt; no other personal
-- data, no secret.
--
-- ## return_journal_line_details
--
-- The slip needs each returned line's name and refund amount; the journal
-- lines (0039) hold only the server line ref and the quantity, and Backend-Core
-- echoes neither name nor amount in the confirmation. The details are the
-- quote's own values (the live readSale line name and the contract-priced
-- amount in minor units), written in the SAME transaction as the line, while
-- the header is pending and unsent; append-only afterwards. A return journaled
-- before 0040 has no details; its slip prints the quantities and the total.
--
-- ## Audit categories
--
-- `sale.return.payout_started`, `sale.return.drawer_opened`,
-- `sale.return.drawer_failed`, `sale.return.paid_out`,
-- `sale.return.slip_printed`, `sale.return.slip_print_failed`,
-- `sale.return.slip_reprinted`. `audit_events.action_category` has no CHECK
-- (0004), so no DDL is needed; the closed set lives in
-- `src/shared/audit/event-shape.ts`.
--
-- Additive, IF NOT EXISTS, ships empty. Runs in the runner's per-file
-- transaction.

CREATE TABLE IF NOT EXISTS return_payouts (
  return_id            TEXT  NOT NULL PRIMARY KEY,
  started_operator_id  TEXT  NOT NULL,
  started_session_id   TEXT  NOT NULL,
  started_at           TEXT  NOT NULL,
  paid_operator_id     TEXT,
  paid_operator_name   TEXT,
  paid_session_id      TEXT,
  paid_at              TEXT,
  method               TEXT  CHECK (method IS NULL OR method IN ('drawer', 'manual')),

  -- The paid facts exist all together or not at all.
  CHECK (
    (paid_at IS NULL AND paid_operator_id IS NULL AND paid_session_id IS NULL
      AND method IS NULL AND paid_operator_name IS NULL)
    OR (paid_at IS NOT NULL AND paid_operator_id IS NOT NULL AND paid_session_id IS NOT NULL
      AND method IS NOT NULL)
  ),

  FOREIGN KEY (return_id) REFERENCES return_journal(return_id)
);

-- A payout starts only for a confirmed return, and starts unpaid.
CREATE TRIGGER IF NOT EXISTS trg_return_payouts_start_confirmed
BEFORE INSERT ON return_payouts
WHEN NEW.paid_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM return_journal WHERE return_id = NEW.return_id AND state = 'confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: a payout starts only for a confirmed return, unpaid (RT-15)');
END;

-- Who started it, and when, never changes.
CREATE TRIGGER IF NOT EXISTS trg_return_payouts_start_immutable
BEFORE UPDATE OF return_id, started_operator_id, started_session_id, started_at
ON return_payouts
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: the start of a payout is immutable (RT-15)');
END;

-- A payout is completed once.
CREATE TRIGGER IF NOT EXISTS trg_return_payouts_paid_once
BEFORE UPDATE ON return_payouts
WHEN OLD.paid_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: a payout is completed once (RT-15)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_payouts_no_delete
BEFORE DELETE ON return_payouts
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: DELETE is denied (RT-15)');
END;

CREATE TABLE IF NOT EXISTS return_journal_line_details (
  return_id     TEXT     NOT NULL,
  line_ref      TEXT     NOT NULL,
  line_name     TEXT     CHECK (line_name IS NULL OR length(line_name) BETWEEN 1 AND 120),
  amount_minor  INTEGER  NOT NULL CHECK (amount_minor >= 0),

  PRIMARY KEY (return_id, line_ref),
  FOREIGN KEY (return_id, line_ref) REFERENCES return_journal_lines(return_id, line_ref)
);

-- Details are written with their line, before any send.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_line_details_header_pending
BEFORE INSERT ON return_journal_line_details
WHEN NOT EXISTS (
  SELECT 1 FROM return_journal
  WHERE return_id = NEW.return_id AND state = 'pending' AND attempt_count = 0
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal_line_details: header must be pending and unsent (RT-15)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_line_details_no_update
BEFORE UPDATE ON return_journal_line_details
BEGIN
  SELECT RAISE(ABORT, 'return_journal_line_details is append-only: UPDATE is denied (RT-15)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_line_details_no_delete
BEFORE DELETE ON return_journal_line_details
BEGIN
  SELECT RAISE(ABORT, 'return_journal_line_details is append-only: DELETE is denied (RT-15)');
END;
