/**
 * RT-443 (MA-2, RT-114 C6–C10) — single-use manager approvals, main-only.
 *
 * `request` (bridge): the requester's live session asks for an approval of one
 * action kind on one subject, naming the approver by MA-1's opaque handle and
 * carrying that manager's PIN. In order:
 *   1. a session (`no_session`), unlocked (`session_locked`), on a paired
 *      terminal (`no_session`);
 *   2. C6: a manager / admin session performs manager-allowed actions
 *      directly, so it asks for nothing (`not_applicable`), except the manager
 *      self-unlock (MA-4);
 *   3. a resolver for the kind (`not_applicable` until its consumer lands);
 *      the subject as main sees it now (`approval_invalid` when it does not
 *      exist or is not in an approvable state for this session);
 *   4. the PIN against that approver's record, with the kind's credential
 *      policy (MA-1). Any failure is one generic `approval_unavailable` (C3);
 *   5. four-eyes (C6): the approver is never the requester;
 *   6. after the PIN's await: the same session, still unlocked, and the
 *      subject unchanged (`approval_stale`);
 *   7. one `manager_approvals` row, bound to the subject's version and amount,
 *      expiring after `ttlMs` (120 s, C7), and `manager_approval.granted`.
 *
 * `consume` (the action handler, inside the action's own transaction): the
 * approval exists, is unconsumed and unexpired, matches the kind, the subject,
 * the terminal and the requester (`approval_invalid`), and the subject's
 * version and amount are still the approved ones (`approval_stale`). On
 * success it is marked consumed, and the caller records the approver.
 *
 * Nothing that identifies the approver leaves main: the bridge answers an
 * opaque `approval_id`. The PIN is never stored, logged or echoed.
 */
import { randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../db/client.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { ManagerActionKind } from '../../shared/operator/manager-action-kinds.js';
import type {
  ManagerApprovalRefusalReason,
  ManagerApprovalRequest,
  ManagerApprover,
} from '../../shared/operator/manager-approval.js';
import { credentialPolicyFor } from './manager-approval-policy.js';
import type { ManagerPinScope, ManagerPinStore } from './manager-pin-store.js';
import type { OperatorSessionRecord } from './session-manager.js';

/** C7: an approval lapses this long after it was issued. */
export const APPROVAL_TTL_MS = 120_000;

/** The policy an approval was checked against (RT-114 reconciliation 2026-10-07). */
export const APPROVAL_POLICY_VERSION = 'rt114-2026-10-07';

/** A subject's state as main sees it: what an approval is bound to. */
export interface ApprovalSubject {
  version: string;
  amountMinor: number | null;
  /**
   * RT-441 (RT-116 §5.3) — a recovery subject's original operator: the
   * approval is recorded as requested on their behalf, and approved by the
   * manager who is signed in. Absent for a cashier's own request.
   */
  requesterOperatorId?: string;
  /**
   * RT-530 — a sale void's selling operator, as a lower-case `users.id`, when
   * the terminal can prove it (a cashier sale's `selling_user_id`). The approver
   * is never this person (owner decision 4); Backend-Core re-checks it against
   * `sales.created_by`.
   */
  sellerUserId?: string;
}

/** Main's view of one kind's subject for this session, or null when not approvable. */
export type ApprovalSubjectResolver = (input: {
  subjectRef: string;
  session: OperatorSessionRecord;
}) => ApprovalSubject | null;

/** RT-530 — what a consumed approval proved, read back to bind a void's evidence. */
export interface ApprovalEvidence {
  approverUserId: string;
  /** The requester's `users.id` as recorded; null for a recovery approval. */
  requesterUserId: string | null;
  policyVersion: string;
  /** When the approval was granted (the terminal clock). */
  issuedAt: string;
}

export type ApprovalRequestOutcome =
  | { kind: 'approved'; approvalId: string }
  | { kind: 'refused'; reason: ManagerApprovalRefusalReason };

export interface ConsumeApprovalInput {
  approvalId: string;
  actionKind: ManagerActionKind;
  subjectRef: string;
  /** The subject as read inside the action's transaction. */
  subject: ApprovalSubject;
  session: Pick<OperatorSessionRecord, 'operator_id' | 'tenant_id' | 'branch_id'> &
    Partial<Pick<OperatorSessionRecord, 'manager_user_id'>>;
}

export type ConsumeApprovalOutcome =
  | { kind: 'consumed'; approverUserId: string }
  | { kind: 'refused'; reason: 'approval_invalid' | 'approval_stale' };

export interface ManagerApprovalService {
  listApprovers(input: {
    actionKind: ManagerActionKind;
  }):
    | { kind: 'approvers'; approvers: ManagerApprover[] }
    | { kind: 'refused'; reason: ManagerApprovalRefusalReason };
  request(input: ManagerApprovalRequest): Promise<ApprovalRequestOutcome>;
  /** Synchronous: call it inside the action's own SQLite transaction. */
  consume(input: ConsumeApprovalInput): ConsumeApprovalOutcome;
  /** RT-530: the evidence of a granted approval (read inside the consuming transaction). */
  evidence(approvalId: string): ApprovalEvidence | null;
}

export interface ManagerApprovalServiceDeps {
  db: Pick<DatabaseHandle, 'prepare'>;
  getSession: () => OperatorSessionRecord | null;
  isSessionLocked: () => boolean;
  /** The paired terminal; null while unpaired. */
  currentTerminalId: () => string | null;
  managerPins: Pick<ManagerPinStore, 'verify' | 'list'>;
  resolvers: Partial<Record<ManagerActionKind, ApprovalSubjectResolver>>;
  auditEmitter?: Pick<AuditEmitter, 'emit'>;
  now: () => string;
  newId?: () => string;
  ttlMs?: number;
}

interface ApprovalRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  action_kind: string;
  subject_ref: string;
  subject_version: string;
  amount_minor: number | null;
  requester_operator_id: string;
  approver_user_id: string;
  requester_user_id: string | null;
  policy_version: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

type Run = { run(...params: unknown[]): { changes: number } };
type Get = { get(...params: unknown[]): ApprovalRow | undefined };

const INSERT = `
  INSERT INTO manager_approvals
    (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
     amount_minor, reason_code, reason_note, requester_operator_id, requester_user_id,
     approver_user_id, policy_version, issued_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT = `
  SELECT tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
         amount_minor, requester_operator_id, approver_user_id, requester_user_id, policy_version,
         issued_at, expires_at, consumed_at
    FROM manager_approvals WHERE approval_id = ?`;

const CONSUME = `UPDATE manager_approvals SET consumed_at = ?
                  WHERE approval_id = ? AND consumed_at IS NULL`;

function refused(reason: ManagerApprovalRefusalReason): { kind: 'refused'; reason: typeof reason } {
  return { kind: 'refused', reason };
}

function sameSubject(a: ApprovalSubject | null, b: ApprovalSubject | null): boolean {
  return a !== null && b !== null && a.version === b.version && a.amountMinor === b.amountMinor;
}

/** The requester's provider-neutral id: the admitted cashier's, or the manager's. */
function requesterUserIdOf(session: OperatorSessionRecord): string | null {
  return (session.user_id ?? session.manager_user_id ?? null)?.toLowerCase() ?? null;
}

/** RT-441 (RT-116 §5.2) — the manager recovery kinds. */
const RECOVERY_KINDS: ReadonlySet<ManagerActionKind> = new Set([
  'recovery.complete_attempt',
  'recovery.cancel_attempt',
  'recovery.cancel_held_cart',
]);

export function isRecoveryKind(kind: ManagerActionKind): boolean {
  return RECOVERY_KINDS.has(kind);
}

function isManagerSession(session: OperatorSessionRecord): boolean {
  return session.role === 'manager' || session.role === 'admin';
}

/**
 * C6: who may ask. A cashier asks for a manager's approval; a manager / admin
 * acts directly, except the self-unlock and (RT-441) recovery, where the
 * signed-in manager approves an action on another operator's sale, and
 * (RT-530) a sale void, which ANY operator needs a different manager's
 * approval for (owner decision 4: no self-void).
 */
function mayRequest(session: OperatorSessionRecord, kind: ManagerActionKind): boolean {
  if (kind === 'sale.void') return true;
  if (isRecoveryKind(kind)) return isManagerSession(session);
  return kind === 'session.self_unlock' || session.role === 'cashier';
}

/**
 * Four-eyes (C6). A cashier's approver is never the cashier. A recovery
 * approval is the signed-in manager's own PIN — the person at the terminal —
 * on another operator's sale (the resolver guarantees the owner is someone
 * else), so the approver must BE the session's manager.
 */
function approverAllowed(
  kind: ManagerActionKind,
  session: OperatorSessionRecord,
  approverUserId: string,
  sellerUserId: string | undefined,
): boolean {
  if (isRecoveryKind(kind)) {
    return approverUserId === session.manager_user_id?.toLowerCase();
  }
  if (kind === 'sale.void' && approverUserId === sellerUserId) return false;
  return kind === 'session.self_unlock' || approverUserId !== requesterUserIdOf(session);
}

/** The requester's user id as recorded: none for a recovery (on another's behalf). */
function recordedRequesterUserId(
  kind: ManagerActionKind,
  session: OperatorSessionRecord,
): string | null {
  return isRecoveryKind(kind) ? null : requesterUserIdOf(session);
}

export function createManagerApprovalService(
  deps: ManagerApprovalServiceDeps,
): ManagerApprovalService {
  const ttlMs = deps.ttlMs ?? APPROVAL_TTL_MS;
  const newId = deps.newId ?? randomUUID;

  /** Steps 1 and 2: the live session and its terminal scope, or a refusal. */
  function admit(
    kind: ManagerActionKind,
  ):
    | { kind: 'ok'; session: OperatorSessionRecord; scope: ManagerPinScope }
    | { kind: 'refused'; reason: ManagerApprovalRefusalReason } {
    const session = deps.getSession();
    if (session === null) return refused('no_session');
    if (deps.isSessionLocked()) return refused('session_locked');
    const terminalId = deps.currentTerminalId();
    if (terminalId === null) return refused('no_session');
    if (!mayRequest(session, kind)) return refused('not_applicable');
    return {
      kind: 'ok',
      session,
      scope: { tenantId: session.tenant_id, branchId: session.branch_id, terminalId },
    };
  }

  function audit(input: {
    session: OperatorSessionRecord;
    scope: ManagerPinScope;
    category: 'manager_approval.granted' | 'manager_approval.refused';
    approverUserId: string | null;
    payload: Record<string, unknown>;
  }): void {
    deps.auditEmitter?.emit({
      event_id: randomUUID(),
      tenant_id: input.scope.tenantId,
      branch_id: input.scope.branchId,
      originating_terminal_id: input.scope.terminalId,
      acting_operator_id: input.session.operator_id,
      session_id: input.session.id,
      shift_id: null,
      action_category: input.category,
      created_at: deps.now(),
      approving_supervisor_id: input.approverUserId,
      payload: input.payload,
    });
  }

  function resolve(
    kind: ManagerActionKind,
    subjectRef: string,
    session: OperatorSessionRecord,
  ): ApprovalSubject | null {
    return deps.resolvers[kind]?.({ subjectRef, session }) ?? null;
  }

  return {
    listApprovers(input) {
      const admitted = admit(input.actionKind);
      if (admitted.kind !== 'ok') return admitted;
      // RT-441: a recovery approval is the signed-in manager's own PIN.
      const self = isRecoveryKind(input.actionKind) ? admitted.session.manager_user_id : undefined;
      if (isRecoveryKind(input.actionKind) && self === undefined) {
        return { kind: 'approvers', approvers: [] };
      }
      const managers = deps.managerPins.list({
        scope: admitted.scope,
        now: deps.now(),
        policy: credentialPolicyFor(input.actionKind),
        ...(self === undefined ? {} : { userId: self }),
      });
      return {
        kind: 'approvers',
        approvers: managers.map((m) => ({
          approver_ref: m.managerRef,
          display_name: m.displayName,
        })),
      };
    },

    async request(input) {
      const kind = input.action_kind;
      const admitted = admit(kind);
      if (admitted.kind !== 'ok') return admitted;
      const { session, scope } = admitted;
      if (deps.resolvers[kind] === undefined) return refused('not_applicable');
      const before = resolve(kind, input.subject_ref, session);
      if (before === null) return refused('approval_invalid');

      const approverUserId = await verifyApprover(input, session, scope, before.sellerUserId);
      if (approverUserId === null) {
        audit({
          session,
          scope,
          category: 'manager_approval.refused',
          approverUserId: null,
          payload: { action_kind: kind, subject_ref: input.subject_ref },
        });
        return refused('approval_unavailable');
      }
      if (movedDuringVerify(input, session, before)) return refused('approval_stale');

      const approvalId = insertApproval({ input, session, scope, before, approverUserId });
      audit({
        session,
        scope,
        category: 'manager_approval.granted',
        approverUserId,
        payload: {
          approval_id: approvalId,
          action_kind: kind,
          subject_ref: input.subject_ref,
          reason_code: input.reason_code,
        },
      });
      return { kind: 'approved', approvalId };
    },

    consume(input) {
      const row = (deps.db.prepare(SELECT) as Get).get(input.approvalId);
      const now = deps.now();
      if (row === undefined || !isUsable(row, input, now)) {
        return refused('approval_invalid') as ConsumeApprovalOutcome;
      }
      const approved: ApprovalSubject = {
        version: row.subject_version,
        amountMinor: row.amount_minor,
      };
      if (!sameSubject(approved, input.subject)) {
        return refused('approval_stale') as ConsumeApprovalOutcome;
      }
      const { changes } = (deps.db.prepare(CONSUME) as Run).run(now, input.approvalId);
      if (changes !== 1) return refused('approval_invalid') as ConsumeApprovalOutcome;
      return { kind: 'consumed', approverUserId: row.approver_user_id };
    },

    evidence(approvalId) {
      const row = (deps.db.prepare(SELECT) as Get).get(approvalId);
      if (row === undefined) return null;
      return {
        approverUserId: row.approver_user_id,
        requesterUserId: row.requester_user_id,
        policyVersion: row.policy_version,
        issuedAt: row.issued_at,
      };
    },
  };

  /**
   * Steps 4 and 5: the approver's user id when the PIN verifies and the
   * approver is allowed (four-eyes; the self-unlock is exempt; a recovery
   * approver is the signed-in manager), otherwise null.
   */
  async function verifyApprover(
    input: ManagerApprovalRequest,
    session: OperatorSessionRecord,
    scope: ManagerPinScope,
    sellerUserId: string | undefined,
  ): Promise<string | null> {
    const verdict = await deps.managerPins.verify({
      scope,
      managerRef: input.approver_ref,
      pin: input.pin,
      now: deps.now(),
      policy: credentialPolicyFor(input.action_kind),
      // RT-438 review: the requesting session, captured before the PIN work.
      actor: { operatorId: session.operator_id, sessionId: session.id },
    });
    if (verdict.kind !== 'verified') return null;
    const allowed = approverAllowed(input.action_kind, session, verdict.userId, sellerUserId);
    return allowed ? verdict.userId : null;
  }

  /** Step 6: after the PIN's await, a different or locked session, or a moved subject. */
  function movedDuringVerify(
    input: ManagerApprovalRequest,
    session: OperatorSessionRecord,
    before: ApprovalSubject,
  ): boolean {
    const live = deps.getSession();
    if (live?.id !== session.id || deps.isSessionLocked()) return true;
    return !sameSubject(before, resolve(input.action_kind, input.subject_ref, live));
  }

  /** Step 7: the approval row, bound to the subject's version and amount. */
  function insertApproval(grant: {
    input: ManagerApprovalRequest;
    session: OperatorSessionRecord;
    scope: ManagerPinScope;
    before: ApprovalSubject;
    approverUserId: string;
  }): string {
    const { input, session, scope, before } = grant;
    const approvalId = newId().toLowerCase();
    const issuedAt = deps.now();
    (deps.db.prepare(INSERT) as Run).run(
      approvalId,
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      input.action_kind,
      input.subject_ref,
      before.version,
      before.amountMinor,
      input.reason_code,
      input.reason_note ?? null,
      before.requesterOperatorId ?? session.operator_id,
      recordedRequesterUserId(input.action_kind, session),
      grant.approverUserId,
      APPROVAL_POLICY_VERSION,
      issuedAt,
      new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    );
    return approvalId;
  }

  /** Unconsumed, unexpired, and bound to this kind, subject, terminal and requester. */
  function isUsable(row: ApprovalRow, input: ConsumeApprovalInput, now: string): boolean {
    return [
      row.consumed_at === null,
      Date.parse(now) <= Date.parse(row.expires_at),
      row.action_kind === input.actionKind,
      row.subject_ref === input.subjectRef,
      row.tenant_id === input.session.tenant_id,
      row.branch_id === input.session.branch_id,
      row.terminal_id === deps.currentTerminalId(),
      row.requester_operator_id ===
        (input.subject.requesterOperatorId ?? input.session.operator_id),
      usedByItsApprover(row, input),
    ].every(Boolean);
  }

  /** RT-441: a recovery approval is used only by the manager who gave it. */
  function usedByItsApprover(row: ApprovalRow, input: ConsumeApprovalInput): boolean {
    if (!isRecoveryKind(input.actionKind)) return true;
    return row.approver_user_id === input.session.manager_user_id?.toLowerCase();
  }
}
