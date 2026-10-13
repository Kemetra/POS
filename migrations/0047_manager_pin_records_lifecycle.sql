-- RT-438 (MA-1, RT-114 C2–C4 on the RT-17 credential) — lifecycle columns for
-- the local manager PIN records.
--
-- [GATED] approval: the owner approved the MA-1 migrations on 2026-10-12
-- (RT-438 comment 11738: "MA-1 builds on the existing PIN"; session answer
-- "approve all" for the MA-1 / MA-2 / PK-2 / S6 migrations). 0047 is the next
-- free number.
--
-- ## Why
--
-- RT-114 makes the RT-17 manager PIN (0044) the one manager credential on a
-- terminal, used by every manager-approved action. Three rules it needs have
-- no column today:
--
--   • lockout_count — consecutive lockouts without a successful PIN between
--     them. The third disables the record (RT-114 C3); a success resets it.
--   • disabled_at — when the record was disabled by repeated lockouts. A
--     disabled record never approves and is not listed; the manager enrols
--     again inside an online session.
--   • revoked_at / revoke_reason — an explicit revocation (RT-114 C4): by the
--     manager themself, or by another manager or admin, inside an online
--     session. A revoked record never approves and is not listed. The reason
--     is a closed set; `ineligible` is reserved for the MA-3 revalidation.
--
-- Per-action-kind validity (24 h for approvals, 30 days for the RT-17
-- variance) needs no column: it is computed from the existing `enrolled_at` /
-- `last_online_at` (manager-approval-policy.ts).
--
-- ## Shape
--
-- Additive ADD COLUMNs with constant defaults; existing rows read as active
-- (no lockouts, not disabled, not revoked). No rebuild, no backfill. A new
-- enrolment over a disabled or revoked record clears all four in place.
--
-- ## Rollback
--
-- The columns are ignored by the 0044-era code. On SQLite ≥ 3.35,
-- `ALTER TABLE manager_pin_records DROP COLUMN …` per column restores 0044.

ALTER TABLE manager_pin_records
  ADD COLUMN lockout_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(lockout_count) = 'integer' AND lockout_count >= 0);

ALTER TABLE manager_pin_records
  ADD COLUMN disabled_at TEXT
  CHECK (disabled_at IS NULL OR length(disabled_at) > 0);

ALTER TABLE manager_pin_records
  ADD COLUMN revoked_at TEXT
  CHECK (revoked_at IS NULL OR length(revoked_at) > 0);

ALTER TABLE manager_pin_records
  ADD COLUMN revoke_reason TEXT
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('self', 'other_manager', 'ineligible'));
