-- RT-530 — the durable sale-void journal (manager-approved void of a finalized sale).
--
-- Owner decisions (Jira RT-530 comment 11988, 2026-10-15): a finalized sale is
-- voided only with a bound RT-114 Manager Approval PIN approval from a
-- different, store_manager-or-above person (never the requester, never the
-- sale's selling operator), on the sale's own business day; the void may be
-- captured offline and sent later with its approval evidence; Backend-Core
-- re-validates on arrival and may refuse it. [GATED] migration, authorized by
-- the same owner comment ("implementation, PRs and merge for RT-530").
--
-- One new table, nothing existing is altered:
--
--   sale_void_journal   one row per void the till requests.
--
-- ## Why a journal
--
-- The void is written HERE, in the same transaction that consumes its manager
-- approval, BEFORE anything is sent (`POST /api/pos/v1/sales/{saleRef}/void`).
-- The row carries its `external_id` (`pos-pulse-void:<uuidv7>`), which is also
-- the Idempotency-Key, and the approval evidence (approval id, approver and
-- requester `users.id`, policy version, approved-at, the bound amount and the
-- business day). The request body is rebuilt from these columns plus the
-- sale's stored server reference, byte-identical on every send, so a retry
-- either replays the recorded void or records it once. A timeout is `unknown`,
-- never success.
--
-- The sale row is append-only (0021) and is never touched: "voided" is this
-- journal, read by returns (a sale with a live void is not returnable) and by
-- the shift cash-up (the voided sale's cash leaves the drawer like a refund).
--
-- ## States
--
--   pending    journaled; not yet answered (never sent, waiting for the sale to
--              sync or for the requester to be signed in online, or crashed
--              mid-send)
--   unknown    sent, but the answer was lost (timeout / network / 5xx / 401)
--   confirmed  Backend-Core answered 201/200: the sale is voided server-side
--   refused    Backend-Core refused it (approval, day, already reversed, ...);
--              final and VISIBLE to staff until acknowledged
--
--   pending -> pending | unknown | confirmed | refused
--   unknown -> unknown | confirmed | refused
--   confirmed, refused: terminal (only `acknowledged_at` may be set, once).
--
-- At most one LIVE void (pending, unknown or confirmed) per sale, by a partial
-- unique index; a refused void frees the sale for a new request. An approval id
-- is used by one void only (UNIQUE), mirroring RT-114's single-use approvals.
--
-- No PIN, no credential, no operator envelope is stored. Money is INTEGER minor
-- units. Audit categories `sale.void.requested|confirmed|refused` are open-set
-- at the SQL layer (0004); the closed set lives in src/shared/audit.
--
-- Additive, IF NOT EXISTS, ships empty. Runs in the runner's per-file
-- transaction.

CREATE TABLE IF NOT EXISTS sale_void_journal (
  void_id                  TEXT     NOT NULL PRIMARY KEY,
  tenant_id                TEXT     NOT NULL,
  branch_id                TEXT     NOT NULL,
  terminal_id              TEXT     NOT NULL,
  sale_id                  TEXT     NOT NULL,
  sale_number              TEXT     NOT NULL,
  external_id              TEXT     NOT NULL UNIQUE CHECK (
    external_id GLOB 'pos-pulse-void:*' AND length(external_id) = 51
  ),
  approval_id              TEXT     NOT NULL UNIQUE CHECK (
    length(approval_id) = 36
    AND approval_id NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(approval_id, '-', '')) = 32
  ),
  approver_user_id         TEXT     NOT NULL CHECK (
    length(approver_user_id) = 36
    AND approver_user_id NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(approver_user_id, '-', '')) = 32
  ),
  requester_user_id        TEXT     NOT NULL CHECK (
    length(requester_user_id) = 36
    AND requester_user_id NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(requester_user_id, '-', '')) = 32
  ),
  requester_operator_id    TEXT     NOT NULL,
  requester_display_name   TEXT     NOT NULL,
  operator_session_id      TEXT     NOT NULL,
  approval_policy_version  TEXT     NOT NULL CHECK (length(approval_policy_version) BETWEEN 1 AND 64),
  approved_at              TEXT     NOT NULL,
  business_date            TEXT     NOT NULL CHECK (
    length(business_date) = 10 AND business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  amount_minor             INTEGER  NOT NULL CHECK (amount_minor >= 0),
  cash_minor               INTEGER  NOT NULL CHECK (cash_minor >= 0),
  currency_code            TEXT     NOT NULL CHECK (
    length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*'
  ),
  state                    TEXT     NOT NULL CHECK (
    state IN ('pending', 'unknown', 'confirmed', 'refused')
  ),
  refusal_reason           TEXT,
  void_ref                 TEXT,
  attempt_count            INTEGER  NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at          TEXT,
  last_error_category      TEXT,
  confirmed_at             TEXT,
  acknowledged_at          TEXT,
  requested_at             TEXT     NOT NULL,
  updated_at               TEXT     NOT NULL,

  CHECK ((state = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK (
    (state = 'confirmed' AND void_ref IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (state <> 'confirmed' AND void_ref IS NULL AND confirmed_at IS NULL)
  ),
  CHECK (acknowledged_at IS NULL OR state IN ('confirmed', 'refused')),

  FOREIGN KEY (sale_id) REFERENCES sales(sale_id)
);

-- One live void per sale; a refused void frees the sale for a new request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_void_journal_one_live_per_sale
  ON sale_void_journal (sale_id)
  WHERE state IN ('pending', 'unknown', 'confirmed');

-- Send / list scan: this terminal's voids by state.
CREATE INDEX IF NOT EXISTS idx_sale_void_journal_scope_state
  ON sale_void_journal (tenant_id, branch_id, terminal_id, state);

-- Journal rows are never deleted.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_journal_no_delete
BEFORE DELETE ON sale_void_journal
BEGIN
  SELECT RAISE(ABORT, 'sale_void_journal: DELETE is denied (RT-530)');
END;

-- Identity, the approval evidence and the bound amounts are fixed at INSERT.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_journal_identity_immutable
BEFORE UPDATE OF void_id, tenant_id, branch_id, terminal_id, sale_id, sale_number, external_id,
  approval_id, approver_user_id, requester_user_id, requester_operator_id,
  requester_display_name, operator_session_id, approval_policy_version, approved_at,
  business_date, amount_minor, cash_minor, currency_code, requested_at
ON sale_void_journal
BEGIN
  SELECT RAISE(ABORT, 'sale_void_journal: identity and evidence are immutable (RT-530)');
END;

-- The state machine; confirmed and refused are terminal.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_journal_state_guard
BEFORE UPDATE ON sale_void_journal
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'pending' AND NEW.state IN ('unknown', 'confirmed', 'refused'))
  OR (OLD.state = 'unknown' AND NEW.state IN ('confirmed', 'refused'))
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_journal: illegal state transition (RT-530)');
END;

-- A terminal row keeps its outcome: only `acknowledged_at` may be set, and once.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_journal_outcome_immutable
BEFORE UPDATE ON sale_void_journal
WHEN OLD.state IN ('confirmed', 'refused') AND (
  NEW.refusal_reason IS NOT OLD.refusal_reason
  OR NEW.void_ref IS NOT OLD.void_ref
  OR NEW.confirmed_at IS NOT OLD.confirmed_at
  OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at)
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_journal: a terminal outcome is immutable (RT-530)');
END;
