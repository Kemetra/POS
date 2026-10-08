-- RT-113 P1.1 — the sealed offline grant store (Jira RT-113 planning record
-- 10763 D3/D4/D5/D10; P1 plan 10871). [GATED] migration, approved by the owner
-- in RT-113 comment 10874 (2026-10-05). 0041 is the next free number (OD9).
--
-- ## cashier_offline_grants
--
-- One row per (tenant_id, branch_id, terminal_id, user_id): the local proof
-- that a cashier was admitted ONLINE by Backend-Core on this terminal, and so
-- may later be admitted offline within bounds (P3). It is written only from an
-- online `admitted` cashier-admission response.
--
-- The ONLY trusted content is `sealed_body` (Electron safeStorage, DPAPI on
-- Windows). It holds, as JSON:
--   - the row's own key (tenant_id, branch_id, terminal_id, user_id), so a body
--     copied into another row, or a row whose key was edited, is detected;
--   - the pairing epoch (`terminal_assignment.paired_at`), so a grant does not
--     survive a re-pair (OD4);
--   - admission_id, operator_id, display_name, issued_at_local, ttl_ms,
--     server_time_at_issue;
--   - offline_admissions_used, last_used_at_local and invalidated, which are
--     re-sealed on every use and every invalidation (OD3).
-- There is deliberately no plain counter, expiry or invalidation column: a
-- plain column could be edited, and code could come to trust it. `sealed_at`
-- is a diagnostic stamp only (when the body was last sealed); nothing reads it
-- for a decision.
--
-- A row without a sealed body (NULL, empty or text) cannot be inserted. Such a
-- row could only come from provisioning or a hand edit, never from an
-- admission, and is never admissible (OD2). The store enforces the same thing
-- again when it reads a row.
--
-- No FK: grants are keyed like `cashier_pin_records` (0036), which has none,
-- and a grant must not block a PIN or pairing change.
--
-- ## cashier_offline_clock_hwm
--
-- A single row (id = 1) holding the terminal's wall-clock high-water mark,
-- sealed the same way. It only ever rises (OD7). An offline admission is
-- refused when the wall clock is more than 5 minutes behind it.
--
-- ## Audit categories
--
-- `operator.offline_grant.*` is local only; `audit_events.action_category` has
-- no CHECK (0004), so no DDL is needed for it. P1.1 writes no audit event; the
-- store is not wired yet (P1.2).
--
-- Additive, IF NOT EXISTS, ships empty, alters nothing. Runs in the runner's
-- per-file transaction.

CREATE TABLE IF NOT EXISTS cashier_offline_grants (
  tenant_id    TEXT  NOT NULL CHECK (length(tenant_id) > 0),
  branch_id    TEXT  NOT NULL CHECK (length(branch_id) > 0),
  terminal_id  TEXT  NOT NULL CHECK (length(terminal_id) > 0),
  user_id      TEXT  NOT NULL CHECK (length(user_id) > 0),
  sealed_body  BLOB  NOT NULL
               CHECK (typeof(sealed_body) = 'blob' AND length(sealed_body) > 0),
  sealed_at    TEXT  NOT NULL CHECK (length(sealed_at) > 0),

  PRIMARY KEY (tenant_id, branch_id, terminal_id, user_id)
);

CREATE TABLE IF NOT EXISTS cashier_offline_clock_hwm (
  id           INTEGER  PRIMARY KEY CHECK (id = 1),
  sealed_body  BLOB     NOT NULL
               CHECK (typeof(sealed_body) = 'blob' AND length(sealed_body) > 0),
  sealed_at    TEXT     NOT NULL CHECK (length(sealed_at) > 0)
);
