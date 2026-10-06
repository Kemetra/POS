-- RT-17 slice 3 — the local shift cash-up facts and their sync outbox.
--
-- [GATED] approval: Jira RT-17 comment 10920 (owner, 2026-10-05) approves the
-- POS SQLite migration `0043_shift_cash_up` — "cash-up, cash movements, and the
-- shift sync outbox and state tables" — on the design record of comment 10919.
--
-- Five new tables; nothing existing is altered. In particular the 004-era
-- `shifts` table (0007, lifecycle only, mutable, written by the legacy forced
-- close) is NOT used: a cash-up shift lives only in the tables below.
--
-- ## The facts (immutable)
--
-- The POS owns the shift's offline lifecycle and is authoritative for the
-- cash-up (10919, RT-160 R-7). Each fact is written once and never changed:
--
--   shift_cashup_opens      ShiftOpened   (one row per shift)
--   shift_cashup_movements  CashMovement  (pay-in / pay-out on an open shift)
--   shift_cashup_closes     ShiftClosed   (the cash-up; one per shift)
--
-- A shift is open while it has no close row. At most ONE open shift per
-- terminal (Backend-Core allows one open shift per device). Money is INTEGER
-- minor units in the shift's single currency (`typeof = 'integer'`, so a float
-- can never be stored). Ids are the client-generated UUIDs that go on the wire,
-- stored in lower case (RT-17 10934: ids are sent as lower-case UUIDs). The
-- close arithmetic is checked here exactly as Backend-Core checks it on ingest:
--   expected = float + cash sales - cash refunds + pay-in - pay-out
--   variance = counted - expected
-- and the close's float and pay-in / pay-out totals must equal the open's float
-- and the sums of the shift's movements. `expected` and `counted` are never
-- negative (the contract's NonNegativeDecimalAmount); `variance` is signed.
--
-- ## The outbox (immutable) and its sync state (mutable)
--
-- `shift_sync_outbox` holds one ORIGINAL row per fact, in causal order
-- (`seq`). The row carries the exact request body and the Idempotency-Key,
-- decided ONCE when the fact is recorded, in the same transaction (RT-17
-- 10931/10934: every retry sends exactly the stored bytes). The row can never
-- be updated or deleted, so a retry can never send different bytes.
-- `auth_path` is the credential the body was built for: `device` bodies carry
-- `operatorUserId` as a JSON string, `envelope` bodies do not carry it at all
-- (the contract's rule, checked below), and a forced close is never a
-- `device` row (forced close is manager-envelope only).
--
-- `shift_sync_state` is the companion bookkeeping row (the 0024 / 0034 split):
-- created automatically with its outbox row as `pending`, then moved by the
-- drain. `synced` is terminal. `dead_letter` keeps its reason; it may go back
-- to `pending` (a re-send of the same bytes), never to `synced` directly, or
-- be `superseded` by a repair.
--
-- ## Repairing a dead letter (RT-17 10919 decision 4, RT-113 P3/P4)
--
-- A device-path fact the server refuses (e.g. 403 `refused`: made offline
-- outside every admission window) is dead-lettered, and it blocks every later
-- fact of the terminal. Re-sending its bytes would fail the same way, so it is
-- repaired on the manager-envelope path by a NEW outbox row (`supersedes_seq`
-- = the dead letter's seq) that:
--   • is an `envelope` row whose body is the dead letter's body without
--     `operatorUserId` (same fact, same payload: the natural-key payload hash
--     excludes the claim, so a fact the server already holds replays `200`);
--   • has its OWN Idempotency-Key: exactly-once rests on the natural-key
--     dedupe, not on the key, and the device key may already be stored by the
--     server's interceptor against a body that carried `operatorUserId`;
--   • takes the CAUSAL POSITION of the fact (`origin_seq` = the fact's
--     original row seq, carried through a repair of a repair), so the drain,
--     which orders by `COALESCE(origin_seq, seq)`, sends it before every later
--     fact.
-- Inserting it moves the dead letter to `superseded` (with `resolved_at` and
-- `superseded_by_seq`) in the same statement, by trigger. `superseded` is
-- terminal. One ACTIVE (non-superseded) row per fact holds by construction:
-- one original row per fact (unique index), a row is superseded at most once
-- (UNIQUE `supersedes_seq`), and only a dead-lettered row of the same fact can
-- be superseded, so a fact's rows form one chain whose last row is the only
-- one not superseded.
--
-- No secret and no PII: user ids, amounts, timestamps, the optional movement
-- note (documented "no PII" by the contract) and closed-set codes only.
--
-- Additive, IF NOT EXISTS, ships empty. Runs in the runner's per-file
-- transaction.

-- ─── ShiftOpened ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shift_cashup_opens (
  shift_id             TEXT     NOT NULL PRIMARY KEY CHECK (
    length(shift_id) = 36
    AND shift_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(shift_id, 9, 1) = '-' AND substr(shift_id, 14, 1) = '-'
    AND substr(shift_id, 19, 1) = '-' AND substr(shift_id, 24, 1) = '-'
    AND length(replace(shift_id, '-', '')) = 32
  ),
  tenant_id            TEXT     NOT NULL,
  branch_id            TEXT     NOT NULL,
  terminal_id          TEXT     NOT NULL,
  opening_user_id      TEXT     NOT NULL CHECK (
    length(opening_user_id) = 36
    AND opening_user_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(opening_user_id, '-', '')) = 32
  ),
  currency_code        TEXT     NOT NULL CHECK (
    length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*'
  ),
  opening_float_minor  INTEGER  NOT NULL CHECK (
    typeof(opening_float_minor) = 'integer' AND opening_float_minor >= 0
  ),
  opened_at            TEXT     NOT NULL,
  created_at           TEXT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_cashup_opens_scope
  ON shift_cashup_opens (tenant_id, branch_id, terminal_id);

-- At most one open shift per terminal: no new open while one has no close.
CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_opens_one_open
BEFORE INSERT ON shift_cashup_opens
WHEN EXISTS (
  SELECT 1 FROM shift_cashup_opens s
  WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id
    AND s.terminal_id = NEW.terminal_id
    AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = s.shift_id)
)
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_opens: this terminal already has an open shift (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_opens_no_update
BEFORE UPDATE ON shift_cashup_opens
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_opens is append-only: UPDATE is denied (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_opens_no_delete
BEFORE DELETE ON shift_cashup_opens
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_opens is append-only: DELETE is denied (RT-17)');
END;

-- ─── CashMovement ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shift_cashup_movements (
  movement_id       TEXT     NOT NULL PRIMARY KEY CHECK (
    length(movement_id) = 36
    AND movement_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(movement_id, 9, 1) = '-' AND substr(movement_id, 14, 1) = '-'
    AND substr(movement_id, 19, 1) = '-' AND substr(movement_id, 24, 1) = '-'
    AND length(replace(movement_id, '-', '')) = 32
  ),
  shift_id          TEXT     NOT NULL,
  kind              TEXT     NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
  amount_minor      INTEGER  NOT NULL CHECK (
    typeof(amount_minor) = 'integer' AND amount_minor > 0
  ),
  reason_code       TEXT     NOT NULL CHECK (
    reason_code IN ('bank_drop', 'float_top_up', 'petty_expense', 'other')
  ),
  note              TEXT     CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  occurred_at       TEXT     NOT NULL,
  operator_user_id  TEXT     NOT NULL CHECK (
    length(operator_user_id) = 36
    AND operator_user_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(operator_user_id, '-', '')) = 32
  ),
  created_at        TEXT     NOT NULL,

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_cashup_movements_shift
  ON shift_cashup_movements (shift_id, kind);

-- A movement is recorded only on an open shift.
CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_movements_shift_open
BEFORE INSERT ON shift_cashup_movements
WHEN EXISTS (SELECT 1 FROM shift_cashup_closes WHERE shift_id = NEW.shift_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_movements: the shift is closed (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_movements_no_update
BEFORE UPDATE ON shift_cashup_movements
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_movements is append-only: UPDATE is denied (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_movements_no_delete
BEFORE DELETE ON shift_cashup_movements
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_movements is append-only: DELETE is denied (RT-17)');
END;

-- ─── ShiftClosed (the cash-up) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shift_cashup_closes (
  shift_id                      TEXT     NOT NULL PRIMARY KEY,
  closed_at                     TEXT     NOT NULL,
  closing_user_id               TEXT     NOT NULL CHECK (
    length(closing_user_id) = 36
    AND closing_user_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(closing_user_id, '-', '')) = 32
  ),
  close_kind                    TEXT     NOT NULL CHECK (close_kind IN ('normal', 'forced')),
  forced_reason                 TEXT     CHECK (
    forced_reason IS NULL OR length(forced_reason) BETWEEN 1 AND 200
  ),
  opening_float_minor           INTEGER  NOT NULL CHECK (
    typeof(opening_float_minor) = 'integer' AND opening_float_minor >= 0
  ),
  cash_sales_total_minor        INTEGER  NOT NULL CHECK (
    typeof(cash_sales_total_minor) = 'integer' AND cash_sales_total_minor >= 0
  ),
  cash_refunds_total_minor      INTEGER  NOT NULL CHECK (
    typeof(cash_refunds_total_minor) = 'integer' AND cash_refunds_total_minor >= 0
  ),
  pay_in_total_minor            INTEGER  NOT NULL CHECK (
    typeof(pay_in_total_minor) = 'integer' AND pay_in_total_minor >= 0
  ),
  pay_out_total_minor           INTEGER  NOT NULL CHECK (
    typeof(pay_out_total_minor) = 'integer' AND pay_out_total_minor >= 0
  ),
  expected_cash_minor           INTEGER  NOT NULL CHECK (
    typeof(expected_cash_minor) = 'integer' AND expected_cash_minor >= 0
  ),
  counted_cash_minor            INTEGER  NOT NULL CHECK (
    typeof(counted_cash_minor) = 'integer' AND counted_cash_minor >= 0
  ),
  variance_minor                INTEGER  NOT NULL CHECK (typeof(variance_minor) = 'integer'),
  sale_count                    INTEGER  NOT NULL CHECK (
    typeof(sale_count) = 'integer' AND sale_count BETWEEN 0 AND 2147483647
  ),
  cash_refund_return_refs_json  TEXT     NOT NULL CHECK (
    json_valid(cash_refund_return_refs_json)
    AND json_type(cash_refund_return_refs_json) = 'array'
    AND json_array_length(cash_refund_return_refs_json) <= 1000
  ),
  variance_approved_by_user_id  TEXT     CHECK (
    variance_approved_by_user_id IS NULL OR (
      length(variance_approved_by_user_id) = 36
      AND variance_approved_by_user_id NOT GLOB '*[^0-9a-f-]*'
      AND length(replace(variance_approved_by_user_id, '-', '')) = 32
    )
  ),
  created_at                    TEXT     NOT NULL,

  -- The cash-up arithmetic (Backend-Core checks the same on ingest; 422
  -- `shift_cashup_inconsistent` otherwise).
  CHECK (
    expected_cash_minor = opening_float_minor + cash_sales_total_minor
      - cash_refunds_total_minor + pay_in_total_minor - pay_out_total_minor
  ),
  CHECK (variance_minor = counted_cash_minor - expected_cash_minor),
  -- `forcedReason` exactly when the close is forced (the contract's if/then).
  CHECK ((close_kind = 'forced') = (forced_reason IS NOT NULL)),

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

-- The close carries the open's float and the shift's own movement totals.
CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_closes_consistent
BEFORE INSERT ON shift_cashup_closes
WHEN NEW.opening_float_minor IS NOT (
    SELECT opening_float_minor FROM shift_cashup_opens WHERE shift_id = NEW.shift_id
  )
  OR NEW.pay_in_total_minor IS NOT (
    SELECT COALESCE(SUM(amount_minor), 0) FROM shift_cashup_movements
    WHERE shift_id = NEW.shift_id AND kind = 'pay_in'
  )
  OR NEW.pay_out_total_minor IS NOT (
    SELECT COALESCE(SUM(amount_minor), 0) FROM shift_cashup_movements
    WHERE shift_id = NEW.shift_id AND kind = 'pay_out'
  )
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_closes: float or movement totals do not match the shift (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_closes_no_update
BEFORE UPDATE ON shift_cashup_closes
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_closes is append-only: UPDATE is denied (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_cashup_closes_no_delete
BEFORE DELETE ON shift_cashup_closes
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_closes is append-only: DELETE is denied (RT-17)');
END;

-- ─── The outbox (exact request bytes, causal order) ─────────────────────────

CREATE TABLE IF NOT EXISTS shift_sync_outbox (
  seq              INTEGER  PRIMARY KEY AUTOINCREMENT,
  fact_kind        TEXT     NOT NULL CHECK (fact_kind IN ('open', 'movement', 'close')),
  shift_id         TEXT     NOT NULL,
  movement_id      TEXT,
  tenant_id        TEXT     NOT NULL,
  branch_id        TEXT     NOT NULL,
  terminal_id      TEXT     NOT NULL,
  auth_path        TEXT     NOT NULL CHECK (auth_path IN ('device', 'envelope')),
  -- The contract's Idempotency-Key grammar: 16-128 printable ASCII, no space.
  idempotency_key  TEXT     NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key NOT GLOB '*[^!-~]*'
  ),
  request_body     TEXT     NOT NULL CHECK (
    json_valid(request_body) AND json_type(request_body) = 'object'
  ),
  enqueued_at      TEXT     NOT NULL,
  -- Repair lineage; both NULL on a fact's original row. `supersedes_seq` is
  -- the dead letter this row replaces (each row is replaced at most once);
  -- `origin_seq` is the fact's original row: the causal position it drains in.
  supersedes_seq   INTEGER  UNIQUE,
  origin_seq       INTEGER,

  CHECK ((supersedes_seq IS NULL) = (origin_seq IS NULL)),
  -- A repair goes on the manager-envelope path.
  CHECK (supersedes_seq IS NULL OR auth_path = 'envelope'),
  CHECK ((fact_kind = 'movement') = (movement_id IS NOT NULL)),
  -- The body is the fact's own: its natural key matches the row.
  CHECK (fact_kind <> 'open' OR json_extract(request_body, '$.shiftId') = shift_id),
  CHECK (fact_kind <> 'movement' OR json_extract(request_body, '$.movementId') = movement_id),
  -- `operatorUserId` as a string on the device path; absent on the envelope
  -- path (an envelope request that carries it, even as null, is a 401).
  CHECK (auth_path <> 'device' OR json_type(request_body, '$.operatorUserId') IS 'text'),
  CHECK (auth_path <> 'envelope' OR json_type(request_body, '$.operatorUserId') IS NULL),
  -- Forced close is manager-envelope only (a device-path forced close is a 403).
  CHECK (NOT (
    fact_kind = 'close' AND auth_path = 'device'
    AND json_extract(request_body, '$.closeKind') = 'forced'
  )),

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id),
  FOREIGN KEY (movement_id) REFERENCES shift_cashup_movements(movement_id),
  FOREIGN KEY (supersedes_seq) REFERENCES shift_sync_outbox(seq),
  FOREIGN KEY (origin_seq) REFERENCES shift_sync_outbox(seq)
);

-- One ORIGINAL outbox row per fact (repairs chain from it; see the header).
CREATE UNIQUE INDEX IF NOT EXISTS ux_shift_sync_outbox_shift_fact
  ON shift_sync_outbox (fact_kind, shift_id)
  WHERE fact_kind IN ('open', 'close') AND supersedes_seq IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_shift_sync_outbox_movement
  ON shift_sync_outbox (movement_id)
  WHERE movement_id IS NOT NULL AND supersedes_seq IS NULL;

-- The drain's scan path: this terminal's facts in causal order.
CREATE INDEX IF NOT EXISTS idx_shift_sync_outbox_scope_seq
  ON shift_sync_outbox (tenant_id, branch_id, terminal_id, seq);

-- An outbox row names a recorded fact of its own shift, in the shift's scope.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_fact_exists
BEFORE INSERT ON shift_sync_outbox
WHEN NOT EXISTS (
    SELECT 1 FROM shift_cashup_opens
    WHERE shift_id = NEW.shift_id AND tenant_id = NEW.tenant_id
      AND branch_id = NEW.branch_id AND terminal_id = NEW.terminal_id
  )
  OR (NEW.fact_kind = 'movement' AND NOT EXISTS (
    SELECT 1 FROM shift_cashup_movements
    WHERE movement_id = NEW.movement_id AND shift_id = NEW.shift_id
  ))
  OR (NEW.fact_kind = 'close' AND NOT EXISTS (
    SELECT 1 FROM shift_cashup_closes WHERE shift_id = NEW.shift_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_outbox: no such fact in this scope (RT-17)');
END;

-- A repair replaces a DEAD-LETTERED row of the same fact, in the same scope,
-- with the same payload less `operatorUserId`, and keeps the fact's causal
-- position.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_repair_target
BEFORE INSERT ON shift_sync_outbox
WHEN NEW.supersedes_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shift_sync_outbox t JOIN shift_sync_state s ON s.seq = t.seq
    WHERE t.seq = NEW.supersedes_seq
      AND s.sync_status = 'dead_letter'
      AND t.fact_kind = NEW.fact_kind AND t.shift_id = NEW.shift_id
      AND t.movement_id IS NEW.movement_id
      AND t.tenant_id = NEW.tenant_id AND t.branch_id = NEW.branch_id
      AND t.terminal_id = NEW.terminal_id
      AND NEW.origin_seq IS COALESCE(t.origin_seq, t.seq)
      AND json_valid(NEW.request_body)
      AND json(NEW.request_body) = json_remove(t.request_body, '$.operatorUserId')
  )
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_outbox: a repair supersedes a dead-lettered row of the same fact and payload (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_no_update
BEFORE UPDATE ON shift_sync_outbox
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_outbox is append-only: UPDATE is denied (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_no_delete
BEFORE DELETE ON shift_sync_outbox
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_outbox is append-only: DELETE is denied (RT-17)');
END;

-- ─── The sync state (one row per outbox row) ────────────────────────────────

CREATE TABLE IF NOT EXISTS shift_sync_state (
  seq                  INTEGER  NOT NULL PRIMARY KEY,
  sync_status          TEXT     NOT NULL CHECK (
    sync_status IN ('pending', 'synced', 'dead_letter', 'superseded')
  ),
  attempt_count        INTEGER  NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at        TEXT,
  last_error_category  TEXT     CHECK (
    last_error_category IS NULL
    OR (length(last_error_category) BETWEEN 1 AND 64
      AND last_error_category NOT GLOB '*[^a-z_]*')
  ),
  dead_letter_reason   TEXT     CHECK (
    dead_letter_reason IS NULL
    OR (length(dead_letter_reason) BETWEEN 1 AND 64
      AND dead_letter_reason NOT GLOB '*[^a-z_]*')
  ),
  last_attempt_at      TEXT,
  synced_at            TEXT,
  -- The repair row that replaced this dead letter, and when.
  superseded_by_seq    INTEGER  UNIQUE,
  resolved_at          TEXT,
  created_at           TEXT     NOT NULL,
  updated_at           TEXT     NOT NULL,

  -- A superseded row keeps the reason it was dead-lettered for.
  CHECK ((sync_status IN ('dead_letter', 'superseded')) = (dead_letter_reason IS NOT NULL)),
  CHECK ((sync_status = 'synced') = (synced_at IS NOT NULL)),
  CHECK ((sync_status = 'superseded') = (superseded_by_seq IS NOT NULL)),
  CHECK ((sync_status = 'superseded') = (resolved_at IS NOT NULL)),

  FOREIGN KEY (seq) REFERENCES shift_sync_outbox(seq),
  FOREIGN KEY (superseded_by_seq) REFERENCES shift_sync_outbox(seq)
);

-- The drain's head lookup reads only the unsettled rows, never the synced or
-- superseded history.
CREATE INDEX IF NOT EXISTS idx_shift_sync_state_unsettled
  ON shift_sync_state (seq) WHERE sync_status IN ('pending', 'dead_letter');

-- Every outbox row gets its state row, pending, in the same statement.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_state
AFTER INSERT ON shift_sync_outbox
BEGIN
  INSERT INTO shift_sync_state (seq, sync_status, attempt_count, created_at, updated_at)
  VALUES (NEW.seq, 'pending', 0, NEW.enqueued_at, NEW.enqueued_at);
END;

-- Inserting a repair supersedes its dead letter in the same statement.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_outbox_supersede
AFTER INSERT ON shift_sync_outbox
WHEN NEW.supersedes_seq IS NOT NULL
BEGIN
  UPDATE shift_sync_state
  SET sync_status = 'superseded', superseded_by_seq = NEW.seq,
      resolved_at = NEW.enqueued_at, updated_at = NEW.enqueued_at
  WHERE seq = NEW.supersedes_seq;
END;

-- A state row starts pending and unattempted.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_state_starts_pending
BEFORE INSERT ON shift_sync_state
WHEN NEW.sync_status <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_state: a state row starts pending (RT-17)');
END;

-- The row's identity never changes; `synced` and `superseded` are terminal; a
-- dead letter goes back to pending (a re-send of the same bytes) or is
-- superseded, and only by the repair row that names it; the attempt count
-- never decreases.
CREATE TRIGGER IF NOT EXISTS trg_shift_sync_state_transition
BEFORE UPDATE ON shift_sync_state
WHEN NEW.seq IS NOT OLD.seq
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempt_count < OLD.attempt_count
  OR OLD.sync_status IN ('synced', 'superseded')
  OR (OLD.sync_status = 'dead_letter'
    AND NEW.sync_status NOT IN ('dead_letter', 'pending', 'superseded'))
  OR (NEW.sync_status = 'superseded' AND (
    OLD.sync_status <> 'dead_letter'
    OR NOT EXISTS (
      SELECT 1 FROM shift_sync_outbox
      WHERE seq = NEW.superseded_by_seq AND supersedes_seq = OLD.seq
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_state: illegal transition (RT-17)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_sync_state_no_delete
BEFORE DELETE ON shift_sync_state
BEGIN
  SELECT RAISE(ABORT, 'shift_sync_state: DELETE is denied (RT-17)');
END;
