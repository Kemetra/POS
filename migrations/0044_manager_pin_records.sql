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
--   • manager_ref — review round 1 (Codex P1 4193622781): an opaque handle
--     per record (a random lower-case UUID, unique, never the users.id). The
--     approver picker lists it, and a close names it: a PIN is verified
--     against that one record, with its own lockout, never matched by value
--     across managers. It survives a PIN replacement.
--   • display_name — the manager's operator display name from the sign-in
--     response (as the POS already shows operators), 1–200 characters, for
--     the approver picker. Refreshed on each enrolment.
--   • pin_hash / pin_salt — the Argon2id PHC string and its 16-byte salt, both
--     sealed with safeStorage (DPAPI on Windows) exactly like the cashier PIN
--     (`pin-seal.ts`). BLOBs, never text, never empty. The PIN itself is never
--     stored.
--   • failed_attempt_count / lockout_until — the cashier PIN lockout
--     (`pin-credential.ts` / `pin-lockout.ts`: 5 failures → 5 minutes).
--   • enrolled_at — when the PIN was last set; an attempt's lockout write is
--     guarded on the secret it checked, so it never lands on a newer one.
--   • last_online_at — review round 1 P2-1: the manager's last online
--     manager / admin sign-in on this terminal (set at enrolment, refreshed on
--     each such sign-in). A record is valid for 30 days after it, and never
--     while it lies in the future (review round 2: a clock corrected
--     backwards); an expired record never approves (the constant lives in
--     `manager-pin-store.ts`).
--
-- No FK, like `cashier_pin_records`: a record must not block a pairing change.
-- A record's key and handle can never be re-pointed at another manager or
-- scope (trigger below); a re-enrolment (which needs the current PIN) replaces
-- the secret and clears the lockout in place.
--
-- Additive, IF NOT EXISTS, ships empty, alters nothing. Runs in the runner's
-- per-file transaction.

CREATE TABLE IF NOT EXISTS manager_pin_records (
  tenant_id             TEXT     NOT NULL CHECK (length(tenant_id) > 0),
  branch_id             TEXT     NOT NULL CHECK (length(branch_id) > 0),
  terminal_id           TEXT     NOT NULL CHECK (length(terminal_id) > 0),
  user_id               TEXT     NOT NULL
                        CHECK (length(user_id) > 0 AND user_id = lower(user_id)),
  manager_ref           TEXT     NOT NULL UNIQUE
                        CHECK (length(manager_ref) = 36 AND manager_ref = lower(manager_ref)),
  display_name          TEXT     NOT NULL
                        CHECK (length(display_name) BETWEEN 1 AND 200),

  pin_hash              BLOB     NOT NULL
                        CHECK (typeof(pin_hash) = 'blob' AND length(pin_hash) > 0),
  pin_salt              BLOB     NOT NULL
                        CHECK (typeof(pin_salt) = 'blob' AND length(pin_salt) > 0),

  failed_attempt_count  INTEGER  NOT NULL DEFAULT 0
                        CHECK (typeof(failed_attempt_count) = 'integer'
                               AND failed_attempt_count >= 0),
  lockout_until         TEXT     CHECK (lockout_until IS NULL OR length(lockout_until) > 0),

  enrolled_at           TEXT     NOT NULL CHECK (length(enrolled_at) > 0),
  last_online_at        TEXT     NOT NULL CHECK (length(last_online_at) > 0),

  PRIMARY KEY (tenant_id, branch_id, terminal_id, user_id)
);

CREATE TRIGGER IF NOT EXISTS trg_manager_pin_records_key_immutable
BEFORE UPDATE OF tenant_id, branch_id, terminal_id, user_id, manager_ref ON manager_pin_records
BEGIN
  SELECT RAISE(ABORT, 'manager_pin_records key is immutable');
END;
