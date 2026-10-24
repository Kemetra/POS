/**
 * RT-861 — the manager PIN record keeps the approver's role (migration 0056).
 *
 *   • enrolment records the enrolling session's role (`manager` | `admin`);
 *   • every online manager / admin sign-in refreshes it, so a record enrolled
 *     before 0056 gains its role without re-enrolment and a promotion or
 *     demotion follows. The role refresh is its own session-start listener,
 *     registered whatever POS_PULSE_FEATURE_SHIFT_CASHUP says (Codex P1 on
 *     PR #826); the flag-gated `last_online_at` refresh leaves the role alone;
 *   • `verify` answers the role with the user id; a record without one (NULL,
 *     written before 0056) answers no role, never a guessed one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import {
  createManagerOnlineRefresh,
  createManagerPinEnrollment,
  createManagerRoleRefresh,
  registerManagerRoleRefresh,
  type ManagerIdentity,
} from '../manager-pin-enrollment.js';
import {
  createManagerPinStore,
  type ManagerPinScope,
  type ManagerPinStore,
} from '../manager-pin-store.js';
import { SessionManager } from '../session-manager.js';

const SCOPE: ManagerPinScope = { tenantId: 't1', branchId: 'b1', terminalId: 'term-1' };
const MANAGER_USER = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const PIN = '246810';
const SIGNED_IN_AT = '2026-10-24T07:59:00.000Z';
const NOW = '2026-10-24T08:00:00.000Z';

let raw: SqlJsDatabase;
let store: ManagerPinStore;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
  store = createManagerPinStore({ db: handleFor(raw), safeStorage: aeadSafeStorage() });
});

afterEach(() => {
  raw.close();
});

function storedRole(): unknown {
  return raw.exec('SELECT role FROM manager_pin_records WHERE user_id = ?', [MANAGER_USER])[0]
    ?.values[0]?.[0];
}

async function enrolDirect(role?: 'manager' | 'admin'): Promise<void> {
  await store.enrol({
    scope: SCOPE,
    userId: MANAGER_USER,
    displayName: 'Mona Manager',
    sealed: await store.seal(PIN),
    now: NOW,
    onlineAt: NOW,
    ...(role === undefined ? {} : { role }),
    guard: () => undefined,
  });
}

function verify(now = NOW): Promise<unknown> {
  const [listed] = store.list({ scope: SCOPE, now });
  return store.verify({ scope: SCOPE, managerRef: listed?.managerRef ?? '', pin: PIN, now });
}

function enrollmentAs(role: ManagerIdentity['role']) {
  const identity: ManagerIdentity = {
    operatorSessionId: 'sess-mgr-1',
    operatorId: 'op-mgr-1',
    role,
    userId: MANAGER_USER,
    displayName: 'Mona Manager',
    signedInAt: SIGNED_IN_AT,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
  };
  return createManagerPinEnrollment({
    isEnabled: () => true,
    getManager: () => identity,
    isSessionLocked: () => false,
    pairedScope: () => Promise.resolve(SCOPE),
    pairingEpoch: () => 'epoch-1',
    store,
    now: () => NOW,
  });
}

/** A new session of `role`; `withId: false` signs in without a captured users.id. */
function signIn(role: ManagerIdentity['role'], withId = true) {
  return new SessionManager().create({
    operator_id: 'clerk-mgr',
    display_name: 'Mona',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'backend-1',
    ...(withId ? { manager_user_id: MANAGER_USER } : {}),
  });
}

describe('RT-861 — enrolment records the session’s role', () => {
  it.each(['manager', 'admin'] as const)(
    'a %s enrols: the record and verify carry it',
    async (role) => {
      await enrollmentAs(role).enroll({ managerPin: PIN });
      expect(storedRole()).toBe(role);
      await expect(verify()).resolves.toEqual({ kind: 'verified', userId: MANAGER_USER, role });
    },
  );

  it('a re-enrolment replaces the role with the enrolling session’s', async () => {
    await enrolDirect('manager');
    await store.enrol({
      scope: SCOPE,
      userId: MANAGER_USER,
      displayName: 'Mona Manager',
      sealed: await store.seal('864201'),
      currentPin: PIN,
      now: NOW,
      onlineAt: NOW,
      role: 'admin',
      guard: () => undefined,
    });
    expect(storedRole()).toBe('admin');
  });
});

describe('RT-861 — a record without a role (pre-0056) is never guessed', () => {
  it('verifies with no role', async () => {
    await enrolDirect();
    expect(storedRole()).toBeNull();
    await expect(verify()).resolves.toEqual({ kind: 'verified', userId: MANAGER_USER });
  });

  it('the last_online_at refresh keeps the record’s role as it is', async () => {
    await enrolDirect('admin');
    store.touchOnline({ scope: SCOPE, userId: MANAGER_USER, at: NOW });
    createManagerOnlineRefresh({ store, currentTerminalId: () => 'term-1' })(signIn('manager'));
    expect(storedRole()).toBe('admin');
  });
});

describe('RT-861 — an online manager / admin sign-in refreshes the role', () => {
  it.each(['manager', 'admin'] as const)('passes the %s role to the store', (role) => {
    const refreshRole = vi.fn();
    createManagerRoleRefresh({ store: { refreshRole }, currentTerminalId: () => 'term-1' })(
      signIn(role),
    );
    expect(refreshRole).toHaveBeenCalledWith({ scope: SCOPE, userId: MANAGER_USER, role });
  });

  it.each<[string, () => ReturnType<typeof signIn>, () => string | null]>([
    ['a session without a manager users.id', () => signIn('manager', false), () => 'term-1'],
    ['a cashier session', () => signIn('cashier'), () => 'term-1'],
    ['an unpaired terminal', () => signIn('manager'), () => null],
  ])('touches nothing for %s', (_name, record, terminal) => {
    const refreshRole = vi.fn();
    createManagerRoleRefresh({ store: { refreshRole }, currentTerminalId: terminal })(record());
    expect(refreshRole).not.toHaveBeenCalled();
  });

  it('fills a pre-0056 record without re-enrolment', async () => {
    await enrolDirect();
    createManagerRoleRefresh({ store, currentTerminalId: () => 'term-1' })(signIn('manager'));
    expect(storedRole()).toBe('manager');
    await expect(verify()).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_USER,
      role: 'manager',
    });
  });

  it('leaves last_online_at alone (that refresh stays with shift cash-up)', async () => {
    await enrolDirect();
    createManagerRoleRefresh({ store, currentTerminalId: () => 'term-1' })(signIn('admin'));
    expect(raw.exec('SELECT last_online_at FROM manager_pin_records')[0]?.values[0]?.[0]).toBe(NOW);
  });

  it('follows a promotion and a demotion', async () => {
    await enrolDirect('manager');
    const refresh = createManagerRoleRefresh({ store, currentTerminalId: () => 'term-1' });
    refresh(signIn('admin'));
    expect(storedRole()).toBe('admin');
    refresh(signIn('manager'));
    expect(storedRole()).toBe('manager');
  });

  it('registers on session start by itself, with shift cash-up off', async () => {
    await enrolDirect();
    const listeners: ((record: ReturnType<typeof signIn>) => void)[] = [];
    registerManagerRoleRefresh({
      onSessionStarted: (listener) => listeners.push(listener),
      store,
      currentTerminalId: () => 'term-1',
    });
    expect(listeners).toHaveLength(1);
    for (const listener of listeners) listener(signIn('admin'));
    expect(storedRole()).toBe('admin');
  });
});
