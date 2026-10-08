import type { AuditEvent } from '../../shared/audit/event-shape.js';

import type { SessionManager } from './session-manager.js';

/**
 * RT-117 (RT-116 §7.3) — audit `operator.session.locked` and
 * `operator.session.unlocked` for every lock-state change of the current
 * session. Best-effort: an audit failure never blocks the lock (the lock is
 * the safety property; the audit records it).
 */

export interface SessionLockAuditDeps {
  sessionManager: SessionManager;
  auditEmitter: { emit(event: AuditEvent): void };
  /** The pairing row's real terminal_id, or null when unpaired. */
  resolveTerminalId: () => string | null;
  uuid: () => string;
  logError?: (err: unknown) => void;
}

export function wireSessionLockAudit(deps: SessionLockAuditDeps): void {
  const { sessionManager, auditEmitter, resolveTerminalId, uuid, logError } = deps;
  let lockedAt: string | null = null;

  sessionManager.onLockStateChanged((record) => {
    const locking = record.lock_state === 'locked';
    const created_at = locking ? (record.locked_at ?? '') : record.last_activity_at;
    const payload = locking
      ? { lock_cause: 'inactivity' as const }
      : {
          locked_duration_ms:
            lockedAt === null ? 0 : Math.max(0, Date.parse(created_at) - Date.parse(lockedAt)),
        };
    lockedAt = locking ? created_at : null;
    try {
      auditEmitter.emit({
        event_id: uuid(),
        tenant_id: record.tenant_id,
        branch_id: record.branch_id,
        originating_terminal_id: resolveTerminalId() ?? '',
        acting_operator_id: record.operator_id,
        session_id: record.id,
        shift_id: null,
        action_category: locking ? 'operator.session.locked' : 'operator.session.unlocked',
        created_at,
        approving_supervisor_id: null,
        payload,
      });
    } catch (err) {
      logError?.(err);
    }
  });
}
