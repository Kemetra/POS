-- RT-861 (RT-854 follow-up) — the approving manager's role, for the cashier-
-- path manual discount.
--
-- [GATED] approval: the owner authorised this migration in Jira RT-861 on
-- 2026-10-24 ("add approver_role to manager_approvals … The migration is
-- authorized in that ticket"), and widened it the same day to the PIN record
-- after RT-861 comment 13722 found no trusted local source for the role
-- ("Owner authorizes the extra GATED column: nullable role (manager|admin) on
-- manager_pin_records, written at enrolment and refreshed on online
-- manager/admin sign-in, copied into manager_approvals.approver_role at grant.
-- Implement RT-861 with both columns in 0056."). 0056 is the next free number.
--
-- ## Why
--
-- Backend-Core requires `approverRole` (`manager` | `admin`) on every
-- discounted capture line (sales.yaml 1.15.0-draft). RT-854 records it on the
-- manager / admin direct path from the session. On the cashier path the
-- approver is another person, known to main only by the `users.id` their PIN
-- verified; neither the PIN record (0044 / 0047) nor the approval (0048) kept
-- whether they are a manager or an admin.
--
-- ## Shape
--
--   • manager_pin_records.role — the role of the manager / admin session that
--     enrolled the PIN, refreshed by each online manager / admin sign-in on
--     this terminal (the `last_online_at` refresh). Not part of the key, so
--     0044's key-immutable trigger does not cover it.
--   • manager_approvals.approver_role — copied from the approving record at
--     grant. Like every other approval column (0048) it is never edited:
--     `trg_manager_approvals_approver_role_immutable` extends 0048's rule.
--
-- Both are nullable `TEXT` constrained to `manager` / `admin`. Additive ADD
-- COLUMNs with no default: rows written before 0056 read NULL, which main
-- treats as "role unknown" and never guesses. A pre-0056 PIN record gains its
-- role at the manager's next online sign-in; a pre-0056 approval never does.
-- No rebuild, no backfill, no index.
--
-- ## §A2 migration safety
--
--   • Additive only: two ADD COLUMNs and one trigger; no existing column,
--     constraint, index or trigger is altered or dropped.
--   • The CHECKs pass for every existing row (all NULL), so the ADD COLUMNs
--     cannot fail on an existing database.
--   • Code before 0056 names its columns in every INSERT / SELECT, so it reads
--     and writes these tables unchanged after the migration.
--   • The new trigger fires only on an UPDATE of `approver_role`; the consume
--     UPDATE (`consumed_at`) does not touch it.
--   • No PIN, hash or user id moves; nothing is sent to the renderer.
--
-- ## Rollback
--
-- The columns are ignored by the pre-0056 code. On SQLite ≥ 3.35:
--   DROP TRIGGER IF EXISTS trg_manager_approvals_approver_role_immutable;
--   ALTER TABLE manager_approvals DROP COLUMN approver_role;
--   ALTER TABLE manager_pin_records DROP COLUMN role;
-- restores 0055.

ALTER TABLE manager_pin_records
  ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('manager', 'admin'));

ALTER TABLE manager_approvals
  ADD COLUMN approver_role TEXT
  CHECK (approver_role IS NULL OR approver_role IN ('manager', 'admin'));

-- The role an approval was granted with is never edited (0048's rule).
CREATE TRIGGER IF NOT EXISTS trg_manager_approvals_approver_role_immutable
BEFORE UPDATE OF approver_role ON manager_approvals
WHEN NEW.approver_role IS NOT OLD.approver_role
BEGIN
  SELECT RAISE(ABORT, 'manager_approvals: an approval is consumed once and never edited');
END;
