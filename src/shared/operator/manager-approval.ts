/**
 * RT-443 (MA-2, RT-114 C6–C10) — the manager approval bridge contract.
 *
 * A manager-approved action never trusts an identity the renderer names. The
 * renderer asks main for an approval of one exact action (`action_kind` +
 * `subject_ref`), naming an approver by the opaque handle from
 * `listApprovers` and carrying that manager's PIN inward. Main checks the PIN
 * against the terminal's manager PIN record (MA-1), binds the approval to the
 * subject's current version and amount as main sees them, and answers an
 * opaque single-use `approval_id`. The action then carries only that id; main
 * consumes it inside the action's own transaction.
 *
 * Nothing that identifies the approver crosses back (no users.id, no name of
 * who approved): the renderer already knows which handle it chose. Refusals
 * are generic (C3): they never say whether the PIN, the manager or the
 * subject was wrong.
 */
import type { ManagerActionKind } from './manager-action-kinds.js';

/** A short machine reason chosen by the consumer flow (e.g. `customer_left`). */
export const APPROVAL_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** A free-text note beside the reason code, at most this long. */
export const APPROVAL_REASON_NOTE_MAX_LENGTH = 200;

export interface ManagerApprovalRequest {
  action_kind: ManagerActionKind;
  /** The action's subject as the consumer names it (e.g. a cart id). */
  subject_ref: string;
  reason_code: string;
  reason_note?: string;
  /** The approver's opaque handle from `listApprovers`. */
  approver_ref: string;
  /** That manager's PIN (6–8 digits). Inward only; never echoed or logged. */
  pin: string;
}

export const APPROVAL_REFUSAL_REASONS = [
  'no_session',
  'session_locked',
  'invalid_input',
  // A manager / admin session performs manager-allowed actions directly (C6).
  'not_applicable',
  // The subject does not exist or is not in a state this action applies to.
  'approval_invalid',
  // Generic: a wrong PIN, an unknown, locked, expired or revoked approver, or
  // an approver who is the requester. Never says which (C3).
  'approval_unavailable',
  // The subject changed between the request and the action.
  'approval_stale',
] as const;

export type ManagerApprovalRefusalReason = (typeof APPROVAL_REFUSAL_REASONS)[number];

export type ManagerApprovalResponse =
  | { kind: 'approved'; approval_id: string }
  | { kind: 'refused'; reason: ManagerApprovalRefusalReason };

/** An approver the sheet may offer: the opaque handle and the display name. */
export interface ManagerApprover {
  approver_ref: string;
  display_name: string;
}

export type ManagerApproversResponse =
  | { kind: 'approvers'; approvers: ManagerApprover[] }
  | { kind: 'refused'; reason: ManagerApprovalRefusalReason };

export interface ManagerApprovalBridgeAPI {
  /** The managers who may approve `action_kind` on this terminal now. */
  listApprovers(req: { action_kind: ManagerActionKind }): Promise<ManagerApproversResponse>;
  request(req: ManagerApprovalRequest): Promise<ManagerApprovalResponse>;
}

export const MANAGER_APPROVAL_IPC_CHANNELS = {
  LIST_APPROVERS: 'approval:listApprovers',
  REQUEST: 'approval:request',
} as const;
