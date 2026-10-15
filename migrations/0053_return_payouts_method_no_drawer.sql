-- RT-531 — `return_payouts.method` gains `no_drawer`: the cash drawer is
-- optional, and a refund paid on a terminal with no drawer is recorded with an
-- explicit value instead of forcing the manual attestation step.
--
-- [GATED] approval: the owner decided on 2026-10-15 that the cash drawer is
-- optional and authorized the implementation of RT-531, including a forward-only
-- migration for any CHECK that must change (the RT-531 brief).
--
-- ## The new value
--
--   method 'no_drawer'   the payout was paid on a terminal with no cash drawer:
--                        the drawer kick answered `no_drawer_configured`, which
--                        provably never reached hardware, so the kick is
--                        recorded `failed_before_send` (unchanged) and the
--                        payout completes without an attestation. Like
--                        `drawer` needs `kick_outcome = 'opened'`, `no_drawer`
--                        needs `kick_outcome = 'failed_before_send'`: it is
--                        never recorded after a kick that may have opened the
--                        drawer (`unknown`, `opened`) or after no kick at all.
--
-- `drawer` and `manual` keep their meaning. A configured drawer that fails
-- (`printer_dk_failure`, `os_error`, `timeout`) is still `unknown`: only the
-- attested `manual` payout completes it. Cash-up counts every completed payout
-- (it never filters on `method`), so `no_drawer` is counted as cash that left
-- the drawer like the other two.
--
-- ## Why a rebuild
--
-- SQLite cannot ALTER a CHECK constraint in place, so this is the canonical
-- rebuild (as 0019 / 0049): create the new table with the corrected schema, copy
-- every row, drop the old, rename the new into place, re-create the triggers.
-- The schema is byte-for-byte 0040's except the `method` CHECK and one new
-- table CHECK. 0040 itself is never edited.
--
-- ## Mechanics (the order matters)
--
--   1. `trg_return_journal_paid_out_needs_payout` (0040, on `return_journal`)
--      names `return_payouts` in its body. It is DROPPED first: after the old
--      table is dropped it would reference a table that does not exist, and
--      SQLite re-parses every trigger on RENAME and refuses the rename then.
--   2. The new table is created, and the rows are copied with an explicit
--      column list BEFORE any trigger exists on it: 0040's
--      `trg_return_payouts_start_confirmed` would abort the copy of an
--      already-paid row, and the kick guards would reject copying a mid-state.
--   3. The old table is dropped (its six triggers go with it; nothing
--      references `return_payouts` through a foreign key, so the runner's
--      default transaction wrap is enough and no `foreign_keys = OFF` is
--      needed), the new one is renamed into place.
--   4. All six `return_payouts` triggers and the `return_journal` trigger are
--      re-created, verbatim from 0040.
--
-- ## Rollback
--
-- Rebuild again with 0040's CHECK. Payouts completed `no_drawer` must first be
-- rewritten to `manual` (or the copy fails). Their journal and audit rows stay.

DROP TRIGGER IF EXISTS trg_return_journal_paid_out_needs_payout;

CREATE TABLE return_payouts_new (
  return_id            TEXT  NOT NULL PRIMARY KEY,
  started_operator_id  TEXT  NOT NULL,
  started_session_id   TEXT  NOT NULL,
  started_at           TEXT  NOT NULL,
  paid_operator_id     TEXT,
  paid_operator_name   TEXT,
  paid_session_id      TEXT,
  paid_at              TEXT,
  method               TEXT  CHECK (method IS NULL OR method IN ('drawer', 'manual', 'no_drawer')),
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
  -- RT-531: a no-drawer payout follows a kick that provably never reached the
  -- hardware (no drawer configured), never one that may have opened the drawer.
  CHECK (method IS NOT 'no_drawer' OR kick_outcome IS 'failed_before_send'),

  -- The paid facts exist all together or not at all.
  CHECK (
    (paid_at IS NULL AND paid_operator_id IS NULL AND paid_session_id IS NULL
      AND method IS NULL AND paid_operator_name IS NULL)
    OR (paid_at IS NOT NULL AND paid_operator_id IS NOT NULL AND paid_session_id IS NOT NULL
      AND method IS NOT NULL)
  ),

  FOREIGN KEY (return_id) REFERENCES return_journal(return_id)
);

-- Explicit column list: a column added to `return_payouts` but not mirrored
-- here fails loud instead of being dropped.
INSERT INTO return_payouts_new (
  return_id, started_operator_id, started_session_id, started_at,
  paid_operator_id, paid_operator_name, paid_session_id, paid_at,
  method, kick_outcome, kick_count, kicked_at
)
SELECT
  return_id, started_operator_id, started_session_id, started_at,
  paid_operator_id, paid_operator_name, paid_session_id, paid_at,
  method, kick_outcome, kick_count, kicked_at
FROM return_payouts;

DROP TABLE return_payouts;

ALTER TABLE return_payouts_new RENAME TO return_payouts;

-- ── The triggers of 0040, re-created verbatim ───────────────────────────────

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
