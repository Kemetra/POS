import { describe, expect, it, vi } from 'vitest';

import { ReauthHandler } from '../reauth-handler.js';
import { OnlineCredentialVerifier } from '../online-credential-verifier.js';
import { SessionManager } from '../session-manager.js';
import { SessionUnlockHandler } from '../session-unlock-handler.js';
import { createJwtHolder, type JwtHolder } from '../jwt-holder.js';
import type { ClerkExchanger, ClerkExchangeResult } from '../clerk-client.js';
import type { Role } from '../../../shared/operator/role.js';

/**
 * RT-358 (RT-247 plan §2.3) — `operator:reauthenticate`: a manager whose held
 * sign-in JWT expired proves their credentials again, in place.
 *
 *   • only the SAME operator: another person's valid credentials get the same
 *     generic `invalid_input` as wrong ones;
 *   • the 5-failure / 5-minute lockout and the one-in-flight gate are shared
 *     with the manager online unlock;
 *   • after the exchange the session must still be the same one, unlocked, not
 *     latched, and the device not revoked — otherwise nothing is stored;
 *   • success stores the JWT for the active backend session, with the one-shot
 *     mark; no new backend session; local authority (`manager_signed_in_at`,
 *     Q1 = no) is never refreshed.
 */

const MONO = 4_000_000;
const REQ = { identifier: 'mgr@example.test', password: 'pw' } as const;

function okClerk(operator_id: string, jwt = 'jwt-fresh'): ClerkExchangeResult {
  return { kind: 'ok', jwt, operator_id, display_name: 'Manager', role: 'manager' };
}

function deferred<T>(value: T): { promise: Promise<T>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = () => {
      resolve(value);
    };
  });
  return { promise, release };
}

function session(role: Role = 'manager', operator_id = 'mgr-1'): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id,
    display_name: 'Manager',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: role === 'cashier' ? '' : 'be-1',
    manager_user_id: role === 'cashier' ? undefined : 'user-1',
  } as Parameters<SessionManager['create']>[0]);
  return sm;
}

function setup(opts: {
  sm?: SessionManager;
  exchange?: ClerkExchanger['exchange'];
  revoked?: () => boolean;
  holder?: JwtHolder;
}) {
  const sm = opts.sm ?? session();
  const jwtHolder = opts.holder ?? createJwtHolder();
  jwtHolder.set('be-1', 'jwt-stale');
  const exchange = vi.fn(opts.exchange ?? (() => Promise.resolve(okClerk('mgr-1'))));
  const verifier = new OnlineCredentialVerifier({ clerk: { exchange } });
  const handler = new ReauthHandler({
    sessionManager: sm,
    verifier,
    jwtHolder,
    isDeviceRevoked: opts.revoked ?? (() => false),
    monoNowMs: () => MONO,
  });
  return { sm, jwtHolder, exchange, verifier, handler };
}

describe('RT-358 ReauthHandler — success', () => {
  it.each(['manager', 'admin'] as const)(
    'the same %s → the JWT is stored for the active backend session, with the mark',
    async (role) => {
      const sm = session(role);
      const { handler, jwtHolder, exchange } = setup({ sm });

      await expect(handler.reauthenticate(REQ)).resolves.toEqual({ kind: 'reauthenticated' });
      expect(exchange).toHaveBeenCalledWith({ identifier: REQ.identifier, password: REQ.password });
      expect(jwtHolder.get('be-1')).toBe('jwt-fresh');
      expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(true);
    },
  );

  it('creates no session, fires no lifecycle hooks and keeps the backend session id', async () => {
    const sm = session();
    const before = sm.getCurrent();
    const started = vi.fn();
    const ended = vi.fn();
    sm.onStarted(started);
    sm.onEnded(ended);
    const { handler } = setup({ sm });

    await handler.reauthenticate(REQ);
    expect(sm.getCurrent()).toBe(before);
    expect(sm.getCurrent()?.backend_session_id).toBe('be-1');
    expect(started).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it('Q1 = no: manager_signed_in_at (the enrolment step-up) is not refreshed', async () => {
    const sm = session();
    const current = sm.getCurrent();
    if (current === null) throw new Error('no session');
    current.manager_signed_in_at = '2026-10-11T08:00:00.000Z';
    const { handler } = setup({ sm });

    await expect(handler.reauthenticate(REQ)).resolves.toEqual({ kind: 'reauthenticated' });
    expect(sm.getCurrent()?.manager_signed_in_at).toBe('2026-10-11T08:00:00.000Z');
  });
});

describe('RT-358 ReauthHandler — refusals store nothing', () => {
  it('another person’s valid credentials → invalid_input, the same as wrong credentials', async () => {
    const other = setup({ exchange: () => Promise.resolve(okClerk('mgr-OTHER', 'jwt-other')) });
    const wrong = setup({ exchange: () => Promise.resolve({ kind: 'refused' }) });

    const a = await other.handler.reauthenticate(REQ);
    const b = await wrong.handler.reauthenticate(REQ);
    expect(a).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(b).toEqual(a);
    expect(other.jwtHolder.get('be-1')).toBe('jwt-stale');
    expect(other.jwtHolder.hasFreshMark('be-1', MONO)).toBe(false);
  });

  it('no_connection → refused no_connection, holder unchanged', async () => {
    const { handler, jwtHolder } = setup({
      exchange: () => Promise.resolve({ kind: 'no_connection' }),
    });
    await expect(handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'no_connection',
    });
    expect(jwtHolder.get('be-1')).toBe('jwt-stale');
  });

  it('no session → not_signed_in; a cashier → role_mismatch; no exchange', async () => {
    const none = setup({ sm: new SessionManager() });
    await expect(none.handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    const cashier = setup({ sm: session('cashier') });
    await expect(cashier.handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'role_mismatch',
    });
    expect(none.exchange).not.toHaveBeenCalled();
    expect(cashier.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty identifier', { identifier: '', password: 'pw' }],
    ['an empty password', { identifier: 'x', password: '' }],
  ])('%s → invalid_input, no exchange', async (_l, req) => {
    const { handler, exchange } = setup({});
    await expect(handler.reauthenticate(req)).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a locked session → state_invalid, no exchange', async () => {
    const sm = session();
    sm.lock('2026-10-11T12:00:00.000Z');
    const { handler, exchange } = setup({ sm });
    await expect(handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    expect(exchange).not.toHaveBeenCalled();
  });
});

describe('RT-358 ReauthHandler — races during the exchange', () => {
  function racing(mutate: (sm: SessionManager, flags: { revoked: boolean }) => void) {
    const sm = session();
    const flags = { revoked: false };
    const ctx = setup({
      sm,
      revoked: () => flags.revoked,
      exchange: () => {
        mutate(sm, flags);
        return Promise.resolve(okClerk('mgr-1'));
      },
    });
    return ctx;
  }

  it.each([
    ['the session ends', (sm: SessionManager) => sm.end('signed_out')],
    [
      'a takeover replaces the session',
      (sm: SessionManager) => {
        sm.end('superseded_by_takeover');
        sm.create({
          operator_id: 'mgr-1',
          display_name: 'Manager',
          role: 'manager',
          tenant_id: 't1',
          branch_id: 'b1',
          backend_session_id: 'be-2',
        });
      },
    ],
    [
      'the session is latched (confirmed revocation, kept until its safe point)',
      (sm: SessionManager) =>
        sm.latchAuthority(sm.getCurrent()?.id ?? '', 'terminal_session_terminated'),
    ],
    [
      'the device is revoked',
      (_sm: SessionManager, flags: { revoked: boolean }) => {
        flags.revoked = true;
      },
    ],
  ])('%s → not_signed_in and neither the JWT nor the mark is stored', async (_l, mutate) => {
    const { handler, jwtHolder } = racing(mutate);
    await expect(handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(jwtHolder.get('be-1')).not.toBe('jwt-fresh');
    expect(jwtHolder.get('be-2')).toBeNull();
    expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(false);
  });

  it('the session locks during the exchange → state_invalid, nothing stored', async () => {
    const { handler, jwtHolder } = racing((sm) => {
      sm.lock('2026-10-11T12:00:00.000Z');
    });
    await expect(handler.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    expect(jwtHolder.get('be-1')).toBe('jwt-stale');
    expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(false);
  });
});

describe('RT-358 shared online gate and lockout (re-auth + manager online unlock)', () => {
  it('two concurrent re-auths: the second is refused rate_limited and sends no exchange', async () => {
    const gate = deferred(okClerk('mgr-1'));
    const { handler, exchange } = setup({ exchange: () => gate.promise });

    const first = handler.reauthenticate(REQ);
    const second = await handler.reauthenticate(REQ);
    gate.release();

    expect(second).toEqual({ kind: 'refused', category: 'rate_limited' });
    await expect(first).resolves.toEqual({ kind: 'reauthenticated' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('a manager online unlock holds the shared gate: a second online attempt sends nothing', async () => {
    const gate = deferred(okClerk('mgr-1'));
    const exchange = vi.fn(() => gate.promise);
    const verifier = new OnlineCredentialVerifier({ clerk: { exchange } });
    const sm = session();
    sm.lock('2026-10-11T12:00:00.000Z');
    const unlock = new SessionUnlockHandler({
      sessionManager: sm,
      verifyCashierPin: () => Promise.resolve(null),
      clerk: { exchange },
      onlineVerifier: verifier,
    });

    const unlocking = unlock.unlock({ method: 'online_credential', ...REQ });
    // Any other caller of the shared verifier (re-auth) is refused at its gate.
    await expect(verifier.verify('mgr-1', REQ.identifier, REQ.password)).resolves.toEqual({
      kind: 'refused',
      category: 'rate_limited',
      stage: 'concurrent',
    });
    gate.release();
    await expect(unlocking).resolves.toEqual({ kind: 'unlocked' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('the lockout is shared: 5 failed re-auths lock out the online unlock too', async () => {
    const exchange = vi.fn(() => Promise.resolve<ClerkExchangeResult>({ kind: 'refused' }));
    const verifier = new OnlineCredentialVerifier({ clerk: { exchange } });
    const sm = session();
    const reauth = new ReauthHandler({
      sessionManager: sm,
      verifier,
      jwtHolder: createJwtHolder(),
      isDeviceRevoked: () => false,
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(reauth.reauthenticate(REQ)).resolves.toEqual({
        kind: 'refused',
        category: 'invalid_input',
      });
    }
    await expect(reauth.reauthenticate(REQ)).resolves.toEqual({
      kind: 'refused',
      category: 'rate_limited',
    });

    sm.lock('2026-10-11T12:00:00.000Z');
    const unlock = new SessionUnlockHandler({
      sessionManager: sm,
      verifyCashierPin: () => Promise.resolve(null),
      clerk: { exchange },
      onlineVerifier: verifier,
    });
    await expect(unlock.unlock({ method: 'online_credential', ...REQ })).resolves.toEqual({
      kind: 'refused',
      category: 'rate_limited',
    });
    expect(exchange).toHaveBeenCalledTimes(5);
  });
});

describe('RT-358 Q2 — the manager online unlock stores its fresh JWT', () => {
  function lockedManager(): SessionManager {
    const sm = session();
    sm.lock('2026-10-11T12:00:00.000Z');
    return sm;
  }

  function unlockWith(opts: {
    sm: SessionManager;
    holder: JwtHolder;
    exchange: ClerkExchanger['exchange'];
    revoked?: () => boolean;
  }): SessionUnlockHandler {
    return new SessionUnlockHandler({
      sessionManager: opts.sm,
      verifyCashierPin: () => Promise.resolve(null),
      clerk: { exchange: opts.exchange },
      jwtHolder: opts.holder,
      isDeviceRevoked: opts.revoked ?? (() => false),
      monoNowMs: () => MONO,
    });
  }

  it('a successful unlock of the still-locked session stores the JWT with the mark', async () => {
    const sm = lockedManager();
    const holder = createJwtHolder();
    holder.set('be-1', 'jwt-stale');
    const res = await unlockWith({
      sm,
      holder,
      exchange: () => Promise.resolve(okClerk('mgr-1')),
    }).unlock({ method: 'online_credential', ...REQ });

    expect(res).toEqual({ kind: 'unlocked' });
    expect(holder.get('be-1')).toBe('jwt-fresh');
    expect(holder.hasFreshMark('be-1', MONO)).toBe(true);
  });

  it.each([
    ['ended', (sm: SessionManager) => sm.end('signed_out'), 'state_invalid'],
    [
      'already unlocked',
      (sm: SessionManager) => {
        sm.unlock('2026-10-11T12:00:01.000Z');
      },
      'state_invalid',
    ],
    [
      'latched',
      (sm: SessionManager) =>
        sm.latchAuthority(sm.getCurrent()?.id ?? '', 'terminal_session_terminated'),
      'not_signed_in',
    ],
  ] as const)(
    'the session was %s during the exchange → refused, nothing stored, not unlocked by us',
    async (_l, mutate, category) => {
      const sm = lockedManager();
      const holder = createJwtHolder();
      holder.set('be-1', 'jwt-stale');
      const res = await unlockWith({
        sm,
        holder,
        exchange: () => {
          mutate(sm);
          return Promise.resolve(okClerk('mgr-1'));
        },
      }).unlock({ method: 'online_credential', ...REQ });

      expect(res).toEqual({ kind: 'refused', category });
      expect(holder.get('be-1')).toBe('jwt-stale');
      expect(holder.hasFreshMark('be-1', MONO)).toBe(false);
    },
  );

  it('a device revoked during the exchange → not_signed_in, still locked, nothing stored', async () => {
    const sm = lockedManager();
    const holder = createJwtHolder();
    holder.set('be-1', 'jwt-stale');
    let revoked = false;
    const res = await unlockWith({
      sm,
      holder,
      revoked: () => revoked,
      exchange: () => {
        revoked = true;
        return Promise.resolve(okClerk('mgr-1'));
      },
    }).unlock({ method: 'online_credential', ...REQ });

    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
    expect(sm.isLocked()).toBe(true);
    expect(holder.get('be-1')).toBe('jwt-stale');
  });
});
