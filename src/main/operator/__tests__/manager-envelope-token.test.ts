import { describe, expect, it } from 'vitest';

import { SessionManager } from '../session-manager.js';
import { createJwtHolder } from '../jwt-holder.js';
import { createManagerEnvelopeReader } from '../manager-envelope-token.js';

/**
 * RT-554 (b) — a forced close is sent under a MANAGER / ADMIN's operator
 * envelope only (contract: manager-envelope only; a cashier's envelope is never
 * used for it). The reader returns the envelope of the CURRENT session when it
 * is a manager or admin session, else null (the row stays queued).
 */

function signedIn(role: 'manager' | 'admin' | 'cashier'): {
  sm: SessionManager;
  holder: ReturnType<typeof createJwtHolder>;
} {
  const sm = new SessionManager();
  const holder = createJwtHolder();
  sm.create({
    operator_id: 'op-1',
    display_name: 'Operator',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'be-1',
    started_at: '2026-10-01T10:00:00.000Z',
  });
  holder.set('be-1', 'envelope-abc');
  return { sm, holder };
}

describe('RT-554 createManagerEnvelopeReader', () => {
  it.each(['manager', 'admin'] as const)('returns the envelope of a %s session', (role) => {
    const { sm, holder } = signedIn(role);
    expect(createManagerEnvelopeReader(sm, holder)()).toBe('envelope-abc');
  });

  it('never returns a cashier session’s envelope', () => {
    const { sm, holder } = signedIn('cashier');
    expect(createManagerEnvelopeReader(sm, holder)()).toBeNull();
  });

  it('is null with no session, and with no envelope held for the session', () => {
    const empty = new SessionManager();
    expect(createManagerEnvelopeReader(empty, createJwtHolder())()).toBeNull();
    const { sm } = signedIn('manager');
    expect(createManagerEnvelopeReader(sm, createJwtHolder())()).toBeNull();
  });

  it('keeps the envelope while the session is locked (as sale sync does)', () => {
    const { sm, holder } = signedIn('manager');
    sm.lock('2026-10-01T10:10:00.000Z');
    expect(createManagerEnvelopeReader(sm, holder)()).toBe('envelope-abc');
  });
});
