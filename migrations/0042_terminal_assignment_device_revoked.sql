-- RT-215 — durable device-revoked state on the pairing row.
--
-- [GATED] approved: Jira RT-215 comment 10875 (owner, 2026-10-05), decision (3).
--
-- Adds ONE nullable column, `device_revoked_at`, to the single-row
-- `terminal_assignment` table (0003, extended by 0027). Nothing else changes.
--
-- ## Why this migration exists
--
-- When Backend-Core refuses the device credential (two consecutive
-- device-bearer 401s, the second from a confirmation call; RT-215 coordinator
-- decision 1), the terminal must remember that it is revoked across a restart,
-- so it routes to pairing recovery at boot instead of returning to /sign-in
-- with a dead token (RT-138 L6). The pairing row is the single source of truth
-- for pairing state, so the marker lives on it rather than in a settings table
-- or the `secrets` table.
--
-- ## Semantics
--
--   • NULL                 → not revoked (every row before this migration).
--   • unix epoch seconds   → when this terminal confirmed the revocation
--                            (same unit as `paired_at`).
--
-- The pairing store reports `invalid / device_revoked` while it is set. A
-- re-pair writes the row with `INSERT OR REPLACE`, which replaces the whole
-- row, so the column returns to NULL with the new pairing. The device token
-- stays sealed in the SecretStore but is never sent while the row is revoked.
--
-- ## Shape CHECK
--
-- NULL, or a non-negative INTEGER. SQLite tests an ADD COLUMN CHECK against
-- existing rows; every existing row gets NULL, which passes.
--
-- ## Re-apply protection
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`. Like 0027/0035/0038 this file is
-- not file-level idempotent; the runner (`src/main/db/migrate.ts`) records it
-- in `schema_migrations` and never re-runs it. It runs inside the runner's
-- default per-file transaction.

ALTER TABLE terminal_assignment ADD COLUMN device_revoked_at INTEGER
  CHECK (
    device_revoked_at IS NULL
    OR (typeof(device_revoked_at) = 'integer' AND device_revoked_at >= 0)
  );
