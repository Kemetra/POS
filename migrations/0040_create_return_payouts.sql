-- RT-15 S4 — the cash payout of a confirmed return, and the slip facts of its lines.
--
-- Jira RT-15 decision D-f authorizes POS-local migrations for this story. Two
-- new tables and one new trigger on return_journal; no column, table or 0039
-- trigger is altered.
--
-- ## Why a payout row (and why 0039 alone is not enough)
--
-- 0040 adds one rule to 0039's table: the header moves to paid_out only with a
-- completed payout row (trigger below); otherwise 0039 is unchanged.
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
  -- The drawer kick record (one row per payout, so per return):
  --   sending             a kick is about to be sent (written BEFORE the
  --                       transport call; after a crash it reads as unknown);
  --   opened              the drawer reported opened;
  --   failed_before_send  provably never reached the hardware (no drawer
  --                       configured): the only outcome that allows a retry;
  --   unknown             anything else (timeout, transport or printer fault).
  kick_outcome         TEXT  CHECK (
    kick_outcome IS NULL
    OR kick_outcome IN ('sending', 'opened', 'failed_before_send', 'unknown')
  ),
  kick_count           INTEGER NOT NULL DEFAULT 0 CHECK (kick_count >= 0),
  kicked_at            TEXT,

  CHECK ((kick_outcome IS NULL) = (kick_count = 0)),
  CHECK ((kick_outcome IS NULL) = (kicked_at IS NULL)),
  -- A drawer payout follows a drawer that opened.
  CHECK (method IS NOT 'drawer' OR kick_outcome = 'opened'),

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

-- At most one kick per payout unless the previous kick provably never reached
-- the hardware: a new kick (-> sending, counted) only from no kick or from
-- failed_before_send; a sent kick resolves once to opened / failed_before_send
-- / unknown; opened and unknown are final for the drawer (only a manual,
-- attested payout completes such a payout).
CREATE TRIGGER IF NOT EXISTS trg_return_payouts_kick_guard
BEFORE UPDATE OF kick_outcome, kick_count, kicked_at ON return_payouts
WHEN NOT (
  (NEW.kick_outcome IS OLD.kick_outcome AND NEW.kick_count = OLD.kick_count
    AND NEW.kicked_at IS OLD.kicked_at)
  OR ((OLD.kick_outcome IS NULL OR OLD.kick_outcome = 'failed_before_send')
    AND NEW.kick_outcome = 'sending' AND NEW.kick_count = OLD.kick_count + 1
    AND NEW.kicked_at IS NOT NULL)
  OR (OLD.kick_outcome = 'sending'
    AND NEW.kick_outcome IN ('opened', 'failed_before_send', 'unknown')
    AND NEW.kick_count = OLD.kick_count AND NEW.kicked_at IS OLD.kicked_at)
)
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: illegal drawer kick transition (RT-15)');
END;

-- A kick lease (Codex P1): two app instances may share this database, so the
-- process-local queue cannot stop one instance from completing a payout while
-- another instance's kick is still in flight (a double dispense). While a kick
-- is `sending` and less than the lease (10 s = 2 x the 5 s drawer timeout,
-- RETURN_KICK_LEASE_MS) has passed since `kicked_at`, the payout cannot be
-- completed. Measured against the completion's own `paid_at` (the app clock),
-- never SQLite's clock. The lease is bounded on both sides (-10 s .. +10 s,
-- exclusive above): a clock that jumped backwards never extends it. After the lease a still-`sending` kick means its process
-- died mid-kick: unknown, so only the manual, attested payout completes it.
-- The guarded UPDATE in the app enforces the same rule; this is the backstop.
CREATE TRIGGER IF NOT EXISTS trg_return_payouts_kick_lease
BEFORE UPDATE OF paid_at ON return_payouts
WHEN OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND OLD.kick_outcome = 'sending'
  -- whole milliseconds (julianday is a float): a deterministic boundary
  AND CAST(ROUND((julianday(NEW.paid_at) - julianday(OLD.kicked_at)) * 86400000.0) AS INTEGER)
    BETWEEN -10000 AND 9999
BEGIN
  SELECT RAISE(ABORT, 'return_payouts: a drawer kick in progress holds the payout (RT-15)');
END;

-- The journal header reaches paid_out only with a completed payout row, so the
-- two can never disagree (no paid_out without who, when and how).
CREATE TRIGGER IF NOT EXISTS trg_return_journal_paid_out_needs_payout
BEFORE UPDATE OF state ON return_journal
WHEN NEW.state = 'paid_out' AND OLD.state IS NOT 'paid_out' AND NOT EXISTS (
  SELECT 1 FROM return_payouts WHERE return_id = NEW.return_id AND paid_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal: paid_out needs a completed payout (RT-15)');
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
