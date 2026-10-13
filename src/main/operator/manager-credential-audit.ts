/**
 * RT-438 (MA-1, RT-114 §4) — the manager PIN lifecycle into the local audit
 * trail: `manager_credential.enrolled | revoked | locked_out | disabled`.
 *
 * The actor is the operator session that STARTED the operation (the manager
 * who enrolled or revoked, or whoever tried the PIN that locked it), captured
 * before its async PIN work and carried on the event; without one, the system
 * actor. Never the session that happens to be current when the event lands
 * (review, Codex P2). The payload is the record's opaque handle (and the closed revoke
 * reason): never a PIN, a hash, a seal or a users.id.
 *
 * An audit failure is logged and never undoes or blocks the credential change
 * the store has already committed.
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { SYSTEM_DEVICE_ACTOR_ID, type ActionCategory } from '../../shared/audit/event-shape.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { ManagerCredentialEvent } from './manager-pin-store.js';

export interface ManagerCredentialAuditDeps {
  auditEmitter: Pick<AuditEmitter, 'emit'>;
  logger?: Pick<Logger, 'error'>;
}

const CATEGORY: Readonly<Record<ManagerCredentialEvent['kind'], ActionCategory>> = {
  enrolled: 'manager_credential.enrolled',
  revoked: 'manager_credential.revoked',
  locked_out: 'manager_credential.locked_out',
  disabled: 'manager_credential.disabled',
};

export function createManagerCredentialAudit(
  deps: ManagerCredentialAuditDeps,
): (event: ManagerCredentialEvent) => void {
  return (event) => {
    try {
      const { actor } = event;
      deps.auditEmitter.emit({
        event_id: randomUUID(),
        tenant_id: event.scope.tenantId,
        branch_id: event.scope.branchId,
        originating_terminal_id: event.scope.terminalId,
        acting_operator_id: actor?.operatorId ?? SYSTEM_DEVICE_ACTOR_ID,
        session_id: actor?.sessionId ?? null,
        shift_id: null,
        action_category: CATEGORY[event.kind],
        created_at: event.at,
        approving_supervisor_id: null,
        payload:
          event.revokeReason === undefined
            ? { manager_ref: event.managerRef }
            : { manager_ref: event.managerRef, reason: event.revokeReason },
      });
    } catch (err) {
      deps.logger?.error(
        { err, event: 'manager_credential.audit.failed', kind: event.kind },
        'manager credential audit failed',
      );
    }
  };
}
