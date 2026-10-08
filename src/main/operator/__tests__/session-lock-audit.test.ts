import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from '../session-manager.js';
import { wireSessionLockAudit } from '../session-lock-audit.js';
import { AUDIT_ACTION_CATEGORIES, type AuditEvent } from '../../../shared/audit/event-shape.js';

/**
 * RT-117 (RT-116 §7.3) — lock and unlock are audited
 * (`operator.session.locked` / `operator.session.unlocked`) with the FR-025
 * attribution attributes and a credential-free payload.
 */

function signedIn(): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id: 'op-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    started_at: '2026-10-01T10:00:00.000Z',
  });
  return sm;
}

function wire(sm: SessionManager, emit: (e: AuditEvent) => void): void {
  let n = 0;
  wireSessionLockAudit({
    sessionManager: sm,
    auditEmitter: { emit },
    resolveTerminalId: () => 'term-1',
    uuid: () => `evt-${String(++n)}`,
  });
}

describe('RT-117 wireSessionLockAudit', () => {
  it('registers both categories in the closed catalogue', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain('operator.session.locked');
    expect(AUDIT_ACTION_CATEGORIES).toContain('operator.session.unlocked');
  });

  it('emits operator.session.locked with full attribution', () => {
    const sm = signedIn();
    const events: AuditEvent[] = [];
    wire(sm, (e) => events.push(e));

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(events).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 't1',
        branch_id: 'b1',
        originating_terminal_id: 'term-1',
        acting_operator_id: 'op-1',
        session_id: sm.getCurrent()?.id,
        shift_id: null,
        action_category: 'operator.session.locked',
        created_at: '2026-10-01T10:10:00.000Z',
        approving_supervisor_id: null,
        payload: { lock_cause: 'inactivity' },
      },
    ]);
  });

  it('emits operator.session.unlocked with how long the session was locked', () => {
    const sm = signedIn();
    const events: AuditEvent[] = [];
    wire(sm, (e) => events.push(e));

    sm.lock('2026-10-01T10:10:00.000Z');
    sm.unlock('2026-10-01T10:13:30.000Z');

    expect(events[1]).toMatchObject({
      action_category: 'operator.session.unlocked',
      created_at: '2026-10-01T10:13:30.000Z',
      session_id: sm.getCurrent()?.id,
      payload: { locked_duration_ms: 210_000 },
    });
  });

  it('records an empty terminal id when the terminal is unpaired', () => {
    const sm = signedIn();
    const events: AuditEvent[] = [];
    wireSessionLockAudit({
      sessionManager: sm,
      auditEmitter: { emit: (e) => events.push(e) },
      resolveTerminalId: () => null,
      uuid: () => 'evt-1',
    });

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(events[0]?.originating_terminal_id).toBe('');
  });

  it('reports a zero locked duration when the lock itself was not observed', () => {
    const sm = signedIn();
    sm.lock('2026-10-01T10:10:00.000Z'); // locked before the audit was wired
    const events: AuditEvent[] = [];
    wire(sm, (e) => events.push(e));

    sm.unlock('2026-10-01T10:13:30.000Z');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action_category: 'operator.session.unlocked',
      payload: { locked_duration_ms: 0 },
    });
  });

  it('logs an audit failure through logError when one is provided', () => {
    const sm = signedIn();
    const failure = new Error('disk full');
    const logError = vi.fn();
    wireSessionLockAudit({
      sessionManager: sm,
      auditEmitter: {
        emit: () => {
          throw failure;
        },
      },
      resolveTerminalId: () => 'term-1',
      uuid: () => 'evt-1',
      logError,
    });

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(logError).toHaveBeenCalledWith(failure);
    expect(sm.isLocked()).toBe(true);
  });

  it('an audit failure never breaks the lock', () => {
    const sm = signedIn();
    wire(
      sm,
      vi.fn(() => {
        throw new Error('disk full');
      }),
    );

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(sm.isLocked()).toBe(true);
  });
});
