/**
 * RT-438 (MA-1) — manager PIN lifecycle facts become local audit events:
 * the right category, the session that started the operation as actor (the
 * system actor without one), the record's handle (and revoke reason) as the whole payload, and an
 * audit failure logged rather than thrown.
 */
import { describe, expect, it, vi } from 'vitest';

import { SYSTEM_DEVICE_ACTOR_ID, type AuditEvent } from '../../../shared/audit/event-shape.js';
import { createManagerCredentialAudit } from '../manager-credential-audit.js';
import type { ManagerCredentialEvent } from '../manager-pin-store.js';

const SCOPE = { tenantId: 't1', branchId: 'b1', terminalId: 'term-1' };
const REF = '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa';
const USER = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const AT = '2026-10-13T08:00:00.000Z';

const ACTOR = { operatorId: 'op-1', sessionId: 'sess-1' };

function event(over: Partial<ManagerCredentialEvent> = {}): ManagerCredentialEvent {
  return {
    kind: 'enrolled',
    scope: SCOPE,
    userId: USER,
    managerRef: REF,
    at: AT,
    actor: ACTOR,
    ...over,
  };
}

function setup() {
  const emitted: AuditEvent[] = [];
  const logger = { error: vi.fn() };
  const audit = createManagerCredentialAudit({
    auditEmitter: { emit: (e) => emitted.push(e) },
    logger,
  });
  return { audit, emitted, logger };
}

describe('RT-438 — manager credential audit', () => {
  it.each([
    ['enrolled', 'manager_credential.enrolled'],
    ['locked_out', 'manager_credential.locked_out'],
    ['disabled', 'manager_credential.disabled'],
  ] as const)('%s → %s with the handle as the whole payload', (kind, category) => {
    const { audit, emitted } = setup();
    audit(event({ kind }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      tenant_id: 't1',
      branch_id: 'b1',
      originating_terminal_id: 'term-1',
      acting_operator_id: 'op-1',
      session_id: 'sess-1',
      shift_id: null,
      action_category: category,
      created_at: AT,
      approving_supervisor_id: null,
      payload: { manager_ref: REF },
    });
  });

  it('revoked carries the closed reason too', () => {
    const { audit, emitted } = setup();
    audit(event({ kind: 'revoked', revokeReason: 'other_manager' }));
    expect(emitted[0]?.action_category).toBe('manager_credential.revoked');
    expect(emitted[0]?.payload).toEqual({ manager_ref: REF, reason: 'other_manager' });
  });

  it('never carries the users.id', () => {
    const { audit, emitted } = setup();
    audit(event());
    expect(JSON.stringify(emitted)).not.toContain(USER);
  });

  it('falls back to the system actor when the operation names none', () => {
    const { audit, emitted } = setup();
    const systemEvent = event({ kind: 'locked_out' });
    delete systemEvent.actor;
    audit(systemEvent);
    expect(emitted[0]).toMatchObject({
      acting_operator_id: SYSTEM_DEVICE_ACTOR_ID,
      session_id: null,
    });
  });

  it('logs an emitter failure and never throws', () => {
    const logger = { error: vi.fn() };
    const audit = createManagerCredentialAudit({
      auditEmitter: {
        emit: () => {
          throw new Error('disk full');
        },
      },
      logger,
    });
    expect(() => {
      audit(event());
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'manager_credential.audit.failed', kind: 'enrolled' }),
      'manager credential audit failed',
    );
  });
});
