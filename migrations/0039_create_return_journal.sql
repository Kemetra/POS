-- RT-15 S2 — the durable cashier-return journal.
--
-- Jira RT-15 decision D-f authorizes POS-local migrations for this story. Two
-- new tables, nothing existing is altered:
--
--   return_journal        one row per return the till attempts;
--   return_journal_lines  the lines and whole quantities it asked to return.
--
-- ## Why a journal
--
-- A return is written here BEFORE it is sent to Backend-Core
-- (`POST /api/pos/v1/sales/{saleRef}/returns`, AC8). The row carries the
-- return's `external_id` = `pos-pulse-return:<uuidv7>`, which is also the
-- Idempotency-Key, and the exact request body. Every retry (the submit itself,
-- the startup/on-demand resolver after a crash or timeout) re-sends those same
-- bytes under that same key, so Backend-Core either replays the recorded
-- return (201 with `Idempotent-Replayed`, or a 200 provenance replay) or
-- records it once. A timeout is `unknown`, never success (AC9/AC10).
--
-- ## States (header)
--
--   pending    journaled; not yet answered (never sent, or crashed mid-send)
--   unknown    sent, but the answer was lost (timeout / network / 5xx / 429)
--   confirmed  Backend-Core answered 201/200 — payout-ready (S4 kicks the drawer)
--   paid_out   the cash was paid out (written by S4)
--   refused    Backend-Core (or a pre-send check on resend) refused it; final
--
-- Allowed transitions, enforced by `trg_return_journal_state_guard`:
--   pending  -> pending | unknown | confirmed | refused
--   unknown  -> unknown | confirmed | refused
--   confirmed -> paid_out
-- `refused` and `paid_out` are terminal: no further UPDATE. No row is ever
-- deleted. A confirmed row's server facts (`return_ref`, `return_total_minor`,
-- `confirmed_at`) never change once set, so a second confirmation cannot
-- rewrite the first (no double confirmation). The identity columns and the
-- stored request are immutable from INSERT.
--
-- ## Columns
--
-- Money is INTEGER minor units (`quoted_total_minor` computed on the till by
-- the contract pricing rule; `return_total_minor` = the server `returnTotal`).
-- `operator_session_id` is the RT-17 cash-up hook. No PII, no secret: the
-- operator envelope never lands here, and the request body holds only
-- `sourceSystem`, `externalId`, line refs, whole quantities and the cash amount.
--
-- ## Audit categories
--
-- The return flow emits four new `audit_events.action_category` values:
-- `sale.return.attempted`, `sale.return.refused`, `sale.return.confirmed`,
-- `sale.return.payout_ready`. `audit_events.action_category` has no CHECK
-- (0004; see 0017/0026), so no DDL is needed for them; the closed set lives in
-- `src/shared/audit/event-shape.ts`.
--
-- Additive, IF NOT EXISTS, ships empty. Runs in the runner's per-file
-- transaction.

CREATE TABLE IF NOT EXISTS return_journal (
  return_id            TEXT     NOT NULL PRIMARY KEY,
  tenant_id            TEXT     NOT NULL,
  branch_id            TEXT     NOT NULL,
  terminal_id          TEXT     NOT NULL,
  sale_id              TEXT     NOT NULL,
  sale_number          TEXT     NOT NULL,
  server_sale_ref      TEXT     NOT NULL CHECK (
    length(server_sale_ref) = 36
    AND server_sale_ref NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(server_sale_ref, '-', '')) = 32
  ),
  external_id          TEXT     NOT NULL UNIQUE CHECK (
    external_id GLOB 'pos-pulse-return:*' AND length(external_id) = 53
  ),
  operator_id          TEXT     NOT NULL,
  operator_session_id  TEXT     NOT NULL,
  currency_code        TEXT     NOT NULL CHECK (
    length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*'
  ),
  quoted_total_minor   INTEGER  NOT NULL CHECK (quoted_total_minor >= 0),
  request_body_json    TEXT     NOT NULL CHECK (length(request_body_json) > 0),
  state                TEXT     NOT NULL CHECK (
    state IN ('pending', 'unknown', 'confirmed', 'paid_out', 'refused')
  ),
  return_ref           TEXT,
  return_total_minor   INTEGER  CHECK (return_total_minor IS NULL OR return_total_minor >= 0),
  refusal_reason       TEXT,
  attempt_count        INTEGER  NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at      TEXT,
  confirmed_at         TEXT,
  paid_out_at          TEXT,
  created_at           TEXT     NOT NULL,
  updated_at           TEXT     NOT NULL,

  -- Confirmed facts exist exactly when the server confirmed the return.
  CHECK (
    (state IN ('confirmed', 'paid_out')
      AND return_ref IS NOT NULL AND return_total_minor IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (state NOT IN ('confirmed', 'paid_out')
      AND return_ref IS NULL AND return_total_minor IS NULL AND confirmed_at IS NULL)
  ),
  CHECK ((state = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK ((state = 'paid_out') = (paid_out_at IS NOT NULL)),

  FOREIGN KEY (sale_id) REFERENCES sales(sale_id)
);

-- Resolver / list scan: this terminal's returns by state.
CREATE INDEX IF NOT EXISTS idx_return_journal_scope_state
  ON return_journal (tenant_id, branch_id, terminal_id, state);

-- Per-sale lookup (the "unresolved return on this sale" guard).
CREATE INDEX IF NOT EXISTS idx_return_journal_sale
  ON return_journal (sale_id, state);

CREATE TABLE IF NOT EXISTS return_journal_lines (
  return_id  TEXT     NOT NULL,
  line_ref   TEXT     NOT NULL CHECK (
    length(line_ref) = 36
    AND line_ref NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(line_ref, '-', '')) = 32
  ),
  quantity   INTEGER  NOT NULL CHECK (quantity >= 1),

  PRIMARY KEY (return_id, line_ref),
  FOREIGN KEY (return_id) REFERENCES return_journal(return_id)
);

-- Journal rows are never deleted.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_no_delete
BEFORE DELETE ON return_journal
BEGIN
  SELECT RAISE(ABORT, 'return_journal: DELETE is denied (RT-15)');
END;

-- Identity and the stored request are fixed at INSERT.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_identity_immutable
BEFORE UPDATE OF return_id, tenant_id, branch_id, terminal_id, sale_id, sale_number,
  server_sale_ref, external_id, operator_id, operator_session_id, currency_code,
  quoted_total_minor, request_body_json, created_at
ON return_journal
BEGIN
  SELECT RAISE(ABORT, 'return_journal: identity and request are immutable (RT-15)');
END;

-- The state machine; refused and paid_out are terminal.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_state_guard
BEFORE UPDATE ON return_journal
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('pending', 'unknown', 'confirmed', 'refused'))
  OR (OLD.state = 'unknown' AND NEW.state IN ('unknown', 'confirmed', 'refused'))
  OR (OLD.state = 'confirmed' AND NEW.state = 'paid_out')
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal: illegal state transition (RT-15)');
END;

-- A confirmation is written once: its server facts never change afterwards.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_confirmation_immutable
BEFORE UPDATE ON return_journal
WHEN OLD.confirmed_at IS NOT NULL AND (
  NEW.return_ref IS NOT OLD.return_ref
  OR NEW.return_total_minor IS NOT OLD.return_total_minor
  OR NEW.confirmed_at IS NOT OLD.confirmed_at
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal: a confirmation is immutable (RT-15)');
END;

-- Lines are append-only.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_lines_no_update
BEFORE UPDATE ON return_journal_lines
BEGIN
  SELECT RAISE(ABORT, 'return_journal_lines is append-only: UPDATE is denied (RT-15)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_lines_no_delete
BEFORE DELETE ON return_journal_lines
BEGIN
  SELECT RAISE(ABORT, 'return_journal_lines is append-only: DELETE is denied (RT-15)');
END;
