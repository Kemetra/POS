/**
 * RT-17 slice 4 part 2 — a signed-in manager enrols (or replaces) their local
 * PIN (option A, Jira RT-17 comment 10943), over the real store (migration
 * 0044 on sql.js, real Argon2id).
 *
 *   • Only with `POS_PULSE_FEATURE_SHIFT_CASHUP` on, and only an unlocked
 *     manager / admin session whose `users.id` was captured from its online
 *     sign-in. The admission is checked in that order, before anything is
 *     hashed or written.
 *   • The PIN is 6–8 digits; anything else is refused before hashing.
 *   • The record's scope is the paired terminal's (tenant, branch, terminal),
 *     which must be the session's own tenant and branch; the users.id is the
 *     session's, lower-cased. Nothing comes from the caller but the PIN.
 *   • The pairing read and the hashing are awaited, so the admission is
 *     checked again after them — the same session, still unlocked, the flag
 *     still on, and the same pairing (its RT-215 epoch) — before the write.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import {
  createManagerPinEnrollment,
  managerIdentityOf,
  type ManagerIdentity,
  type ManagerPinEnrollment,
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
const NOW = '2026-10-06T08:00:00.000Z';

function manager(over: Partial<ManagerIdentity> = {}): ManagerIdentity {
  return {
    operatorSessionId: 'sess-mgr-1',
    role: 'manager',
    userId: MANAGER_USER,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    ...over,
  };
}

/** A manager session whose sign-in carried no users.id. */
function managerWithoutId(): ManagerIdentity {
  const identity = manager();
  delete identity.userId;
  return identity;
}

interface State {
  enabled: boolean;
  manager: ManagerIdentity | null;
  locked: boolean;
  pairedScope: ManagerPinScope | null;
  epoch: string | null;
  duringPairedScopeRead: () => void;
  duringSeal: () => void;
}

let raw: SqlJsDatabase;
let store: ManagerPinStore;
let state: State;
let enrollment: ManagerPinEnrollment;
let seal: Mock<ManagerPinStore['seal']>;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
  store = createManagerPinStore({ db: handleFor(raw), safeStorage: aeadSafeStorage() });
  state = {
    enabled: true,
    manager: manager(),
    locked: false,
    pairedScope: SCOPE,
    epoch: 'epoch-1',
    duringPairedScopeRead: () => undefined,
    duringSeal: () => undefined,
  };
  seal = vi.fn<ManagerPinStore['seal']>(async (pin) => {
    const sealed = await store.seal(pin);
    state.duringSeal();
    return sealed;
  });
  enrollment = createManagerPinEnrollment({
    isEnabled: () => state.enabled,
    getManager: () => state.manager,
    isSessionLocked: () => state.locked,
    pairedScope: async () => {
      await Promise.resolve();
      state.duringPairedScopeRead();
      return state.pairedScope;
    },
    pairingEpoch: () => state.epoch,
    store: {
      seal,
      save: (input) => {
        store.save(input);
      },
    },
    now: () => NOW,
  });
});

afterEach(() => {
  raw.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ManagerPinRefusedError', reason }) as Error;
}

function records(): unknown[][] {
  return (
    raw.exec(
      `SELECT tenant_id, branch_id, terminal_id, user_id, failed_attempt_count, lockout_until,
              enrolled_at
         FROM manager_pin_records`,
    )[0]?.values ?? []
  );
}

describe('a signed-in manager enrols a PIN', () => {
  it('records it in the paired scope under the session’s users.id', async () => {
    await enrollment.enroll({ managerPin: PIN });
    expect(records()).toEqual([['t1', 'b1', 'term-1', MANAGER_USER, 0, null, NOW]]);
    await expect(store.verify({ scope: SCOPE, pin: PIN })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_USER,
    });
  });

  it('lets an admin enrol too', async () => {
    state.manager = manager({ role: 'admin' });
    await enrollment.enroll({ managerPin: '12345678' });
    expect(records()).toHaveLength(1);
  });

  it('replaces the manager’s PIN on a second enrolment', async () => {
    await enrollment.enroll({ managerPin: PIN });
    await enrollment.enroll({ managerPin: '864201' });
    expect(records()).toHaveLength(1);
    await expect(store.verify({ scope: SCOPE, pin: PIN })).resolves.toEqual({ kind: 'invalid' });
    await expect(store.verify({ scope: SCOPE, pin: '864201' })).resolves.toMatchObject({
      kind: 'verified',
    });
  });
});

describe('admission, before anything is hashed or written', () => {
  it.each<[string, (s: State) => void, string]>([
    ['the flag off', (s) => (s.enabled = false), 'feature_disabled'],
    ['no session', (s) => (s.manager = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
    ['a cashier session', (s) => (s.manager = manager({ role: 'cashier' })), 'not_manager'],
    [
      'a manager session with no users.id',
      (s) => (s.manager = managerWithoutId()),
      'no_manager_identity',
    ],
    ['an unpaired or revoked terminal (no epoch)', (s) => (s.epoch = null), 'no_session'],
    ['an unpaired terminal (no paired scope)', (s) => (s.pairedScope = null), 'no_session'],
    [
      'a paired scope of another branch',
      (s) => (s.pairedScope = { ...SCOPE, branchId: 'b2' }),
      'no_session',
    ],
    [
      'a paired scope of another tenant',
      (s) => (s.pairedScope = { ...SCOPE, tenantId: 't2' }),
      'no_session',
    ],
  ])('refuses %s', async (_name, arrange, reason) => {
    arrange(state);
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(refusal(reason));
    expect(seal).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it('checks the flag, then the session, then the lock, then the role', async () => {
    state.enabled = false;
    state.manager = null;
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(
      refusal('feature_disabled'),
    );
    state.enabled = true;
    state.locked = true;
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(refusal('no_session'));
    state.manager = manager({ role: 'cashier' });
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(refusal('session_locked'));
  });

  it.each(['12345', '123456789', 'abcdef', ' 123456', '123456 ', '١٢٣٤٥٦', ''])(
    'refuses the PIN %j (6–8 digits only)',
    async (managerPin) => {
      await expect(enrollment.enroll({ managerPin })).rejects.toThrow(refusal('invalid_pin'));
      expect(seal).not.toHaveBeenCalled();
    },
  );

  it('refuses a PIN that is not a string', async () => {
    const managerPin = 246810 as unknown as string;
    await expect(enrollment.enroll({ managerPin })).rejects.toThrow(refusal('invalid_pin'));
  });

  it('never puts the PIN in a refusal', async () => {
    state.locked = true;
    const error = await enrollment.enroll({ managerPin: PIN }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(PIN);
  });
});

describe('re-checked after the awaits, before the write', () => {
  type Race = (s: State) => void;
  const RACES: ReadonlyArray<[string, Race, string]> = [
    ['a sign-out', (s) => (s.manager = null), 'no_session'],
    ['a lock', (s) => (s.locked = true), 'session_locked'],
    ['the flag turned off', (s) => (s.enabled = false), 'feature_disabled'],
    [
      'another session of the same manager',
      (s) => (s.manager = manager({ operatorSessionId: 'sess-mgr-2' })),
      'no_session',
    ],
    [
      'another manager in the same session id',
      (s) => (s.manager = manager({ userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b' })),
      'no_session',
    ],
    ['a revocation', (s) => (s.epoch = null), 'no_session'],
    ['a re-pair (new epoch, same terminal)', (s) => (s.epoch = 'epoch-2'), 'no_session'],
  ];

  it.each(RACES)('refuses when %s lands during the pairing read', async (_n, race, reason) => {
    state.duringPairedScopeRead = () => {
      race(state);
    };
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(refusal(reason));
    expect(records()).toEqual([]);
  });

  it.each(RACES)('refuses when %s lands during the hashing', async (_n, race, reason) => {
    state.duringSeal = () => {
      race(state);
    };
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(refusal(reason));
    expect(records()).toEqual([]);
  });
});

describe('managerIdentityOf — the live session as enrolment sees it', () => {
  it('is null without a session', () => {
    expect(managerIdentityOf(null)).toBeNull();
  });

  it('carries the manager’s captured users.id and scope (main-only)', () => {
    const sessions = new SessionManager();
    const record = sessions.create({
      operator_id: 'clerk-mgr',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'backend-1',
      manager_user_id: MANAGER_USER,
    });
    expect(managerIdentityOf(record)).toEqual({
      operatorSessionId: record.id,
      role: 'manager',
      userId: MANAGER_USER,
      tenantId: 't1',
      branchId: 'b1',
    });
  });

  it('has no users.id for a session without a captured manager id', () => {
    const sessions = new SessionManager();
    const record = sessions.create({
      operator_id: 'clerk-c',
      display_name: 'Cashier',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      cashier_admission: {
        user_id: '0190f5a2-3b4c-7d8e-9f01-00000000000c',
        admission_id: 'adm',
        admission_ttl_seconds: 60,
        offline_grace_seconds: 0,
        admission_generation: 'g',
      },
    });
    expect(managerIdentityOf(record)).toEqual({
      operatorSessionId: record.id,
      role: 'cashier',
      tenantId: 't1',
      branchId: 'b1',
    });
  });
});
