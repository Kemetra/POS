-- RT-443 (MA-2, RT-114 C7) — single-use manager approvals bound to one action.
--
-- [GATED] approval: the owner approved the MA-1 / MA-2 / PK-2 / S6 migrations
-- on 2026-10-12 (session answer "approve all"; RT-443). 0048 is the next free
-- number after MA-1's 0047.
--
-- ## Why
--
-- RT-114 retires renderer-supplied approver ids (C10): a manager-approved
-- action must carry a main-verified approval instead. `approval.request`
-- verifies the manager's PIN (MA-1's `manager_pin_records`) and writes one row
-- here, bound to the exact action as main sees it at that moment. The action
-- handler then consumes the row inside its own transaction, re-checking that
-- nothing moved (C7.4).
--
-- ## Shape
--
--   • approval_id — opaque UUID handed to the renderer; the only thing the
--     action carries.
--   • scope — the terminal it was issued on; consumed only there.
--   • action_kind — RT-114 §3's closed catalogue (manager-action-kinds.ts);
--     not CHECKed here so the catalogue can grow by contract without a
--     rebuild (the bridge validates it).
--   • subject_ref / subject_version / amount_minor — the subject and its state
--     at approval, computed by main (never the renderer). A consumption whose
--     current state differs is refused `approval_stale`.
--   • reason_code / reason_note — why (C7), bounded.
--   • requester_operator_id / requester_user_id — the session that asked;
--     approver_user_id — the manager whose PIN verified (users.id, main-only,
--     never sent to the renderer).
--   • policy_version — the policy the approval was checked against
--     (RT-114 reconciliation 2026-10-07).
--   • issued_at / expires_at — 120 s by default (C7); consumed_at set once.
--
-- Additive, IF NOT EXISTS, ships empty, alters nothing. No FK: a row must not
-- block a cart or payment change; consumption checks the subject itself.
--
-- ## Rollback
--
-- `DROP TABLE IF EXISTS manager_approvals;` — nothing else reads it.

CREATE TABLE IF NOT EXISTS manager_approvals (
  approval_id            TEXT     NOT NULL PRIMARY KEY
                         CHECK (length(approval_id) = 36 AND approval_id = lower(approval_id)),
  tenant_id              TEXT     NOT NULL CHECK (length(tenant_id) > 0),
  branch_id              TEXT     NOT NULL CHECK (length(branch_id) > 0),
  terminal_id            TEXT     NOT NULL CHECK (length(terminal_id) > 0),

  action_kind            TEXT     NOT NULL CHECK (length(action_kind) BETWEEN 1 AND 64),
  subject_ref            TEXT     NOT NULL CHECK (length(subject_ref) BETWEEN 1 AND 128),
  subject_version        TEXT     NOT NULL CHECK (length(subject_version) BETWEEN 1 AND 256),
  amount_minor           INTEGER  CHECK (amount_minor IS NULL
                                         OR (typeof(amount_minor) = 'integer' AND amount_minor >= 0)),

  reason_code            TEXT     NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 40),
  reason_note            TEXT     CHECK (reason_note IS NULL OR length(reason_note) <= 200),

  requester_operator_id  TEXT     NOT NULL CHECK (length(requester_operator_id) > 0),
  requester_user_id      TEXT     CHECK (requester_user_id IS NULL OR length(requester_user_id) > 0),
  approver_user_id       TEXT     NOT NULL CHECK (length(approver_user_id) > 0),

  policy_version         TEXT     NOT NULL CHECK (length(policy_version) > 0),
  issued_at              TEXT     NOT NULL CHECK (length(issued_at) > 0),
  expires_at             TEXT     NOT NULL CHECK (length(expires_at) > 0),
  consumed_at            TEXT     CHECK (consumed_at IS NULL OR length(consumed_at) > 0)
);

-- A consumed approval is never consumed again, and nothing else ever changes.
CREATE TRIGGER IF NOT EXISTS trg_manager_approvals_consume_once
BEFORE UPDATE ON manager_approvals
WHEN OLD.consumed_at IS NOT NULL
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.branch_id IS NOT OLD.branch_id
  OR NEW.terminal_id IS NOT OLD.terminal_id
  OR NEW.action_kind IS NOT OLD.action_kind
  OR NEW.subject_ref IS NOT OLD.subject_ref
  OR NEW.subject_version IS NOT OLD.subject_version
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.reason_code IS NOT OLD.reason_code
  OR NEW.reason_note IS NOT OLD.reason_note
  OR NEW.requester_operator_id IS NOT OLD.requester_operator_id
  OR NEW.requester_user_id IS NOT OLD.requester_user_id
  OR NEW.approver_user_id IS NOT OLD.approver_user_id
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'manager_approvals: an approval is consumed once and never edited');
END;

CREATE TRIGGER IF NOT EXISTS trg_manager_approvals_no_delete
BEFORE DELETE ON manager_approvals
BEGIN
  SELECT RAISE(ABORT, 'manager_approvals is append-only');
END;
