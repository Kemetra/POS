-- RT-17 slice 4 part 2 — local manager PIN records (option A).
--
-- [GATED] approval: on 2026-10-06 the owner approved option (A) of Jira RT-17
-- comment 10942 ("I approve option A in RT-17 comment 10942 handle it"),
-- recorded in comment 10943: a new POS SQLite migration for manager PIN
-- records — scope, `users.id`, an Argon2id hash and lockout state — with
-- online enrolment and offline verification. 0044 is the next free number.
--
-- ## Why
--
-- A shift close with a non-zero variance needs a verified manager approver
-- who is not the closing cashier (10919 decision 1, 10920: manager PIN for
-- any variance), and a close never waits on the network (10919). Managers had
-- no local credential: `cashier_pin_records` holds cashier PINs only.
--
-- ## Shape (mirrors `cashier_pin_records`, 0006 / 0035 / 0036)
--
--   • Scope (tenant_id, branch_id, terminal_id) — the cashier PIN records'
--     scope: a PIN is enrolled on, and verified on, one paired terminal. A
--     re-pair always yields a new terminal id, so a record of an old pairing
--     can never be used again; the re-pair purges it with the cashier PINs
--     (RT-215 decision 5).
--   • user_id — the manager's provider-neutral `users.id` (028 §16), captured
--     from the online sign-in response at enrolment; stored lower-cased (RT-17
--     10934: ids go on the wire as lower-case UUIDs) and becomes the close's
--     `varianceApprovedByUserId`.
--   • pin_hash / pin_salt — the Argon2id PHC string and its 16-byte salt, both
--     sealed with safeStorage (DPAPI on Windows) exactly like the cashier PIN
--     (`pin-seal.ts`). BLOBs, never text, never empty. The PIN itself is never
--     stored.
--   • failed_attempt_count / lockout_until — the cashier PIN lockout
--     (`pin-credential.ts` / `pin-lockout.ts`: 5 failures → 5 minutes).
--   • enrolled_at — when the PIN was last set (diagnostic).
--
-- No FK, like `cashier_pin_records`: a record must not block a pairing change.
-- A record's key can never be re-pointed at another manager or scope (trigger
-- below); a re-enrolment replaces the secret and clears the lockout in place.
--
-- Additive, IF NOT EXISTS, ships empty, alters nothing. Runs in the runner's
-- per-file transaction.

CREATE TABLE IF NOT EXISTS manager_pin_records (
  tenant_id             TEXT     NOT NULL CHECK (length(tenant_id) > 0),
  branch_id             TEXT     NOT NULL CHECK (length(branch_id) > 0),
  terminal_id           TEXT     NOT NULL CHECK (length(terminal_id) > 0),
  user_id               TEXT     NOT NULL
                        CHECK (length(user_id) > 0 AND user_id = lower(user_id)),

  pin_hash              BLOB     NOT NULL
                        CHECK (typeof(pin_hash) = 'blob' AND length(pin_hash) > 0),
  pin_salt              BLOB     NOT NULL
                        CHECK (typeof(pin_salt) = 'blob' AND length(pin_salt) > 0),

  failed_attempt_count  INTEGER  NOT NULL DEFAULT 0
                        CHECK (typeof(failed_attempt_count) = 'integer'
                               AND failed_attempt_count >= 0),
  lockout_until         TEXT     CHECK (lockout_until IS NULL OR length(lockout_until) > 0),

  enrolled_at           TEXT     NOT NULL CHECK (length(enrolled_at) > 0),

  PRIMARY KEY (tenant_id, branch_id, terminal_id, user_id)
);

CREATE TRIGGER IF NOT EXISTS trg_manager_pin_records_key_immutable
BEFORE UPDATE OF tenant_id, branch_id, terminal_id, user_id ON manager_pin_records
BEGIN
  SELECT RAISE(ABORT, 'manager_pin_records key is immutable');
END;
