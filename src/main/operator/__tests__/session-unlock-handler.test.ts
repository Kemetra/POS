import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from '../session-manager.js';
import { SessionUnlockHandler } from '../session-unlock-handler.js';
import type { ClerkExchanger, ClerkExchangeResult } from '../clerk-client.js';
import type { Role } from '../../../shared/operator/role.js';

/**
 * RT-117 (RT-116 §2.4) — same-operator unlock of the CURRENT locked session.
 *
 *   • cashier → local PIN verifier (004), works offline;
 *   • manager/admin → interim online credential exchange (owner decision Z3),
 *     verified against the locked session's operator; NO new session, NO
 *     backend session, NO lifecycle hooks.
 *
 * Any mismatch is one generic refusal and the lock is unchanged.
 */

const T_LOCK = '2026-10-01T10:10:00.000Z';

function lockedSession(role: Role, operator_id = 'op-1'): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id,
    display_name: 'Someone',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: role === 'cashier' ? '' : 'be-1',
    started_at: '2026-10-01T10:00:00.000Z',
  });
  sm.lock(T_LOCK);
  return sm;
}

function clerkReturning(result: ClerkExchangeResult): ClerkExchanger {
  return { exchange: vi.fn(() => Promise.resolve(result)) };
}

const OK_CLERK = (operator_id: string): ClerkExchangeResult => ({
  kind: 'ok',
  jwt: 'jwt-fresh',
  operator_id,
  display_name: 'Manager',
  role: 'manager',
});

function handler(
  sm: SessionManager,
  over: {
    verifyCashierPin?: (
      operator_id: string,
      pin: string,
    ) => Promise<null | { kind: 'refused'; category: 'invalid_input' | 'rate_limited' }>;
    clerk?: ClerkExchanger;
  } = {},
): SessionUnlockHandler {
  return new SessionUnlockHandler({
    sessionManager: sm,
    verifyCashierPin: over.verifyCashierPin ?? (() => Promise.resolve(null)),
    clerk: over.clerk ?? clerkReturning({ kind: 'refused' }),
    now: () => new Date('2026-10-01T10:12:00.000Z'),
  });
}

describe('RT-117 SessionUnlockHandler — cashier PIN', () => {
  it('unlocks the same session when the PIN verifies', async () => {
    const sm = lockedSession('cashier');
    const id = sm.getCurrent()?.id;
    const verifyCashierPin = vi.fn(() => Promise.resolve(null));
    let started = 0;
    sm.onStarted(() => {
      started += 1;
    });

    const res = await handler(sm, { verifyCashierPin }).unlock({ method: 'pin', pin: '1234' });

    expect(res).toEqual({ kind: 'unlocked' });
    expect(verifyCashierPin).toHaveBeenCalledWith('op-1', '1234');
    expect(sm.isLocked()).toBe(false);
    expect(sm.getCurrent()?.id).toBe(id);
    expect(started).toBe(0);
  });

  it('stays locked and refuses generically on a wrong PIN', async () => {
    const sm = lockedSession('cashier');
    const res = await handler(sm, {
      verifyCashierPin: () => Promise.resolve({ kind: 'refused', category: 'invalid_input' }),
    }).unlock({ method: 'pin', pin: '0000' });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(sm.isLocked()).toBe(true);
  });

  it('passes through the 004 PIN lockout (rate_limited) and stays locked', async () => {
    const sm = lockedSession('cashier');
    const res = await handler(sm, {
      verifyCashierPin: () => Promise.resolve({ kind: 'refused', category: 'rate_limited' }),
    }).unlock({ method: 'pin', pin: '0000' });

    expect(res).toEqual({ kind: 'refused', category: 'rate_limited' });
    expect(sm.isLocked()).toBe(true);
  });

  it('refuses the online-credential method for a cashier session', async () => {
    const sm = lockedSession('cashier');
    const exchange = vi.fn(() => Promise.resolve(OK_CLERK('op-1')));
    const res = await handler(sm, { clerk: { exchange } }).unlock({
      method: 'online_credential',
      identifier: 'x@y',
      password: 'pw',
    });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(exchange).not.toHaveBeenCalled();
    expect(sm.isLocked()).toBe(true);
  });

  it('refuses an empty PIN without calling the verifier', async () => {
    const sm = lockedSession('cashier');
    const verifyCashierPin = vi.fn(() => Promise.resolve(null));
    const res = await handler(sm, { verifyCashierPin }).unlock({ method: 'pin', pin: '' });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(verifyCashierPin).not.toHaveBeenCalled();
  });
});

describe('RT-117 SessionUnlockHandler — manager/admin interim online re-auth (Z3)', () => {
  it.each(['manager', 'admin'] as const)(
    'unlocks the same %s session when the exchanged identity matches',
    async (role) => {
      const sm = lockedSession(role, 'mgr-1');
      const id = sm.getCurrent()?.id;
      const clerk = clerkReturning(OK_CLERK('mgr-1'));

      const res = await handler(sm, { clerk }).unlock({
        method: 'online_credential',
        identifier: 'mgr@example.test',
        password: 'pw',
      });

      expect(res).toEqual({ kind: 'unlocked' });
      expect(sm.getCurrent()?.id).toBe(id);
      // The backend session (and with it the sale-sync envelope key) is untouched.
      expect(sm.getCurrent()?.backend_session_id).toBe('be-1');
    },
  );

  it('refuses and stays locked when a DIFFERENT person authenticates', async () => {
    const sm = lockedSession('manager', 'mgr-1');
    const res = await handler(sm, { clerk: clerkReturning(OK_CLERK('mgr-OTHER')) }).unlock({
      method: 'online_credential',
      identifier: 'other@example.test',
      password: 'pw',
    });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(sm.isLocked()).toBe(true);
  });

  it('maps a Clerk network failure to no_connection and stays locked', async () => {
    const sm = lockedSession('manager', 'mgr-1');
    const res = await handler(sm, { clerk: clerkReturning({ kind: 'no_connection' }) }).unlock({
      method: 'online_credential',
      identifier: 'mgr@example.test',
      password: 'pw',
    });

    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(sm.isLocked()).toBe(true);
  });

  it('refuses the PIN method for a manager session', async () => {
    const sm = lockedSession('manager', 'mgr-1');
    const verifyCashierPin = vi.fn(() => Promise.resolve(null));
    const res = await handler(sm, { verifyCashierPin }).unlock({ method: 'pin', pin: '1234' });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(verifyCashierPin).not.toHaveBeenCalled();
    expect(sm.isLocked()).toBe(true);
  });
});

describe('RT-117 SessionUnlockHandler — state guards', () => {
  it('refuses not_signed_in when there is no session', async () => {
    const res = await handler(new SessionManager()).unlock({ method: 'pin', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });

  it('refuses state_invalid when the session is not locked', async () => {
    const sm = lockedSession('cashier');
    sm.unlock('2026-10-01T10:11:00.000Z');
    const res = await handler(sm).unlock({ method: 'pin', pin: '1234' });
    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
  });

  it('does not unlock a session that changed while the credential was being verified', async () => {
    const sm = lockedSession('cashier');
    const res = await handler(sm, {
      verifyCashierPin: () => {
        sm.end('signed_out'); // session gone mid-verification
        return Promise.resolve(null);
      },
    }).unlock({ method: 'pin', pin: '1234' });

    expect(res).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(sm.getCurrent()).toBeNull();
  });

  it('refuses a malformed request generically', async () => {
    const sm = lockedSession('cashier');
    const res = await handler(sm).unlock({ method: 'telepathy' } as never);
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(sm.isLocked()).toBe(true);
  });
});
