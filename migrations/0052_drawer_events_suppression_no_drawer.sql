-- RT-531 — `drawer_events.suppression_reason` gains `no_drawer_configured`: the
-- cash drawer is optional, and a cash sale on a terminal with no drawer is no
-- longer a drawer failure but a suppressed drawer event.
--
-- [GATED] approval: the owner decided on 2026-10-15 that the cash drawer is
-- optional and authorized the implementation of RT-531, including a forward-only
-- migration for any CHECK that must change (the RT-531 brief).
--
-- ## Why a rebuild
--
-- SQLite cannot ALTER a CHECK constraint in place, so this is the canonical
-- rebuild (as 0019 / 0049): create the new table with the corrected schema, copy
-- every row, drop the old, rename the new into place, re-create the indexes and
-- the append-only triggers. The schema is byte-for-byte 0023's except the one
-- column CHECK on `suppression_reason`, which now lists `no_drawer_configured`
-- beside `cashless_tender_mix`. 0023 itself is never edited.
--
-- Historical rows stay as written. The pre-RT-531 stub recorded every cash sale
-- on a terminal with no drawer as `failed` / `no_drawer_configured`; those rows
-- are append-only (never rewritten), so `failure_reason` keeps
-- `no_drawer_configured` in its CHECK. New code writes the suppressed form
-- instead, and the banner projector ignores the historical failed form.
--
-- ## Mechanics
--
-- No table references `drawer_events` (the FKs run from it to `sales` and
-- `print_events`), so the runner's default transaction wrap is enough: no
-- `foreign_keys = OFF`. Indexes and triggers follow the old table on DROP and
-- are re-created below. The triggers are created AFTER the copy: the append-only
-- triggers fire on UPDATE and DELETE only, never on the copying INSERT, but
-- creating them last keeps the copy independent of them. DROP TABLE's implicit
-- row removal under foreign keys does not fire triggers.
--
-- ## Rollback
--
-- Rebuild again with 0023's CHECK. Rows suppressed `no_drawer_configured` must
-- first be rewritten (the table is append-only, so a rollback is a deliberate,
-- reviewed operation), or the copy fails.

CREATE TABLE drawer_events_new (
  drawer_event_id                       TEXT     NOT NULL PRIMARY KEY,
  sale_id                               TEXT     NOT NULL,
  outcome                               TEXT     NOT NULL CHECK (outcome IN ('opened', 'suppressed', 'failed')),
  suppression_reason                    TEXT              CHECK (suppression_reason IS NULL OR suppression_reason IN (
                                                      'cashless_tender_mix',
                                                      'no_drawer_configured'
                                                    )),
  failure_reason                        TEXT              CHECK (failure_reason IS NULL OR failure_reason IN (
                                                      'printer_dk_failure',
                                                      'os_error',
                                                      'no_drawer_configured'
                                                    )),
  last_successful_open_at_for_terminal  TEXT,
  triggering_print_event_id             TEXT     NOT NULL,
  terminal_id                           TEXT     NOT NULL,
  attempted_at                          TEXT     NOT NULL,

  FOREIGN KEY (sale_id) REFERENCES sales(sale_id),
  FOREIGN KEY (triggering_print_event_id) REFERENCES print_events(print_event_id),

  -- suppression_reason is biconditional with outcome='suppressed'.
  CHECK (
    (outcome = 'suppressed' AND suppression_reason IS NOT NULL)
    OR (outcome <> 'suppressed' AND suppression_reason IS NULL)
  ),

  -- failure_reason is biconditional with outcome='failed'.
  CHECK (
    (outcome = 'failed' AND failure_reason IS NOT NULL)
    OR (outcome <> 'failed' AND failure_reason IS NULL)
  )
);

-- Explicit column list: a column added to `drawer_events` but not mirrored here
-- fails loud instead of being dropped.
INSERT INTO drawer_events_new (
  drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
  last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
)
SELECT
  drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
  last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
FROM drawer_events;

DROP TABLE drawer_events;

ALTER TABLE drawer_events_new RENAME TO drawer_events;

-- FR-053 double-kick suppression: at most one DrawerEvent per sale.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawer_events_sale_id
  ON drawer_events (sale_id);

-- last_successful_open_at_for_terminal lookup on failure-event INSERT.
CREATE INDEX IF NOT EXISTS idx_drawer_events_terminal_attempted_at
  ON drawer_events (terminal_id, attempted_at DESC);

-- Append-only triggers (AD-3), as 0023.
CREATE TRIGGER IF NOT EXISTS trg_drawer_events_no_update
BEFORE UPDATE ON drawer_events
BEGIN
  SELECT RAISE(ABORT, 'drawer_events is append-only — UPDATE denied (008 AD-3)');
END;

CREATE TRIGGER IF NOT EXISTS trg_drawer_events_no_delete
BEFORE DELETE ON drawer_events
BEGIN
  SELECT RAISE(ABORT, 'drawer_events is append-only — DELETE denied (008 AD-3)');
END;
