/**
 * RT-17 slice 4 part 2 — a signed-in manager enrols (or replaces) their local
 * PIN (option A, Jira RT-17 comment 10943), over the real store (migration
 * 0044 on sql.js, real Argon2id).
 *
 *   • Only with `POS_PULSE_FEATURE_SHIFT_CASHUP` on, and only an unlocked
 *     manager / admin session whose `users.id` was captured from its online
 *     sign-in. The admission is checked in that order, before anything is
 *     hashed or written.
 *   • Review round 1 P2-2 (step-up): only within 2 minutes of that online
 *     sign-in (`reauth_required` otherwise), and replacing a PIN needs the
 *     current one (verified with lockout).
 *   • The PIN is 6–8 digits and not a weak one (round 1: same digit,
 *     ascending / descending runs, repeated blocks, a short common list →
 *     `pin_too_weak`); anything else is refused before hashing.
 *   • The record's scope is the paired terminal's (tenant, branch, terminal),
 *     which must be the session's own tenant and branch; the users.id and the
 *     display name are the session's. Nothing comes from the caller but PINs.
 *   • The pairing read and the hashing are awaited, so the admission is
 *     checked again after them, and once more right before the write.
 *   • An online manager sign-in on this terminal refreshes the record's
 *     `last_online_at` (round 1 P2-1).
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
  MANAGER_ENROL_STEP_UP_MS,
  createManagerOnlineRefresh,
  createManagerPinEnrollment,
  isWeakManagerPin,
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
const NEW_PIN = '864201';
const SIGNED_IN_AT = '2026-10-06T07:59:00.000Z';
const NOW = '2026-10-06T08:00:00.000Z';

function manager(over: Partial<ManagerIdentity> = {}): ManagerIdentity {
  return {
    operatorSessionId: 'sess-mgr-1',
    role: 'manager',
    userId: MANAGER_USER,
    displayName: 'Mona Manager',
    signedInAt: SIGNED_IN_AT,
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
  clock: string;
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
    clock: NOW,
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
    store: { seal, enrol: (input) => store.enrol(input) },
    now: () => state.clock,
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
      `SELECT tenant_id, branch_id, terminal_id, user_id, display_name, failed_attempt_count,
              lockout_until, enrolled_at, last_online_at
         FROM manager_pin_records`,
    )[0]?.values ?? []
  );
}

function verify(pin: string): Promise<unknown> {
  const [listed] = store.list({ scope: SCOPE, now: NOW });
  return store.verify({ scope: SCOPE, managerRef: listed?.managerRef ?? '', pin, now: NOW });
}

describe('a signed-in manager enrols a PIN', () => {
  it('records it in the paired scope under the session’s users.id and name', async () => {
    await enrollment.enroll({ managerPin: PIN });
    expect(records()).toEqual([
      ['t1', 'b1', 'term-1', MANAGER_USER, 'Mona Manager', 0, null, NOW, SIGNED_IN_AT],
    ]);
    await expect(verify(PIN)).resolves.toEqual({ kind: 'verified', userId: MANAGER_USER });
  });

  it('lets an admin enrol too', async () => {
    state.manager = manager({ role: 'admin' });
    await enrollment.enroll({ managerPin: '13572468' });
    expect(records()).toHaveLength(1);
  });

  it('replaces the PIN only with the current one (P2-2)', async () => {
    await enrollment.enroll({ managerPin: PIN });
    await expect(enrollment.enroll({ managerPin: NEW_PIN })).rejects.toThrow(
      refusal('current_pin_required'),
    );
    await expect(enrollment.enroll({ managerPin: NEW_PIN, currentPin: '000000' })).rejects.toThrow(
      refusal('current_pin_invalid'),
    );
    await enrollment.enroll({ managerPin: NEW_PIN, currentPin: PIN });
    expect(records()).toHaveLength(1);
    await expect(verify(PIN)).resolves.toEqual({ kind: 'invalid' });
    await expect(verify(NEW_PIN)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('refuses a replacement while the record is locked out', async () => {
    await enrollment.enroll({ managerPin: PIN });
    raw.run('UPDATE manager_pin_records SET lockout_until = ?, failed_attempt_count = 5', [
      new Date(Date.now() + 60_000).toISOString(),
    ]);
    await expect(enrollment.enroll({ managerPin: NEW_PIN, currentPin: PIN })).rejects.toThrow(
      refusal('current_pin_locked'),
    );
  });
});

describe('step-up: within 2 minutes of the online sign-in (P2-2)', () => {
  const at = (ms: number): string => new Date(Date.parse(SIGNED_IN_AT) + ms).toISOString();

  it('is 2 minutes', () => {
    expect(MANAGER_ENROL_STEP_UP_MS).toBe(120_000);
  });

  it('accepts exactly 2 minutes after the sign-in', async () => {
    state.clock = at(MANAGER_ENROL_STEP_UP_MS);
    await enrollment.enroll({ managerPin: PIN });
    expect(records()).toHaveLength(1);
  });

  it.each<[string, () => void]>([
    ['later than 2 minutes', () => (state.clock = at(MANAGER_ENROL_STEP_UP_MS + 1))],
    ['before the sign-in (clock moved back)', () => (state.clock = at(-1))],
    [
      'with no recorded online sign-in',
      () => {
        const identity = manager();
        delete identity.signedInAt;
        state.manager = identity;
      },
    ],
  ])('refuses %s with reauth_required, before hashing', async (_name, arrange) => {
    arrange();
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(
      refusal('reauth_required'),
    );
    expect(seal).not.toHaveBeenCalled();
  });

  it('refuses when the window closes during the hashing', async () => {
    state.duringSeal = () => {
      state.clock = at(MANAGER_ENROL_STEP_UP_MS + 1);
    };
    await expect(enrollment.enroll({ managerPin: PIN })).rejects.toThrow(
      refusal('reauth_required'),
    );
    expect(records()).toEqual([]);
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

  it.each(['12345', '123456789', 'abcdef', ' 246810', '246810 ', '٢٤٦٨١٠', ''])(
    'refuses the PIN %j (6–8 digits only)',
    async (managerPin) => {
      await expect(enrollment.enroll({ managerPin })).rejects.toThrow(refusal('invalid_pin'));
      expect(seal).not.toHaveBeenCalled();
    },
  );

  it.each(['12345', 'abcdef', 246810])('refuses the current PIN %j', async (currentPin) => {
    await expect(
      enrollment.enroll({ managerPin: PIN, currentPin: currentPin as string }),
    ).rejects.toThrow(refusal('invalid_pin'));
    expect(seal).not.toHaveBeenCalled();
  });

  it('refuses a PIN that is not a string', async () => {
    const managerPin = 246810 as unknown as string;
    await expect(enrollment.enroll({ managerPin })).rejects.toThrow(refusal('invalid_pin'));
  });

  it('refuses a weak PIN with pin_too_weak, before hashing', async () => {
    await expect(enrollment.enroll({ managerPin: '123456' })).rejects.toThrow(
      refusal('pin_too_weak'),
    );
    expect(seal).not.toHaveBeenCalled();
  });

  it('never puts a PIN in a refusal', async () => {
    state.locked = true;
    const error = await enrollment.enroll({ managerPin: PIN }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(PIN);
  });
});

describe('isWeakManagerPin — the round 1 denylist', () => {
  it.each([
    '000000',
    '99999999',
    '123456',
    '01234567',
    '234567',
    '654321',
    '98765432',
    '890123',
    '210987',
    '121212',
    '123123',
    '12341234',
    '112233',
    '123321',
    '147258',
    '159753',
    '102030',
  ])('treats %s as weak', (pin) => {
    expect(isWeakManagerPin(pin)).toBe(true);
  });

  it.each(['246810', '864201', '13579135', '13572468', '193746', '27182818'])(
    'accepts %s',
    (pin) => {
      expect(isWeakManagerPin(pin)).toBe(false);
    },
  );
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

  it.each(RACES)('refuses when %s lands during the current-PIN check', async (_n, race, reason) => {
    await enrollment.enroll({ managerPin: PIN });
    const enrol = store.enrol.bind(store);
    enrollment = createManagerPinEnrollment({
      isEnabled: () => state.enabled,
      getManager: () => state.manager,
      isSessionLocked: () => state.locked,
      pairedScope: () => Promise.resolve(state.pairedScope),
      pairingEpoch: () => state.epoch,
      store: {
        seal: (pin) => store.seal(pin),
        enrol: (input) =>
          enrol({
            ...input,
            guard: () => {
              race(state);
              input.guard();
            },
          }),
      },
      now: () => state.clock,
    });
    await expect(enrollment.enroll({ managerPin: NEW_PIN, currentPin: PIN })).rejects.toThrow(
      refusal(reason),
    );
    await expect(verify(PIN)).resolves.toMatchObject({ kind: 'verified' });
  });
});

describe('managerIdentityOf — the live session as enrolment sees it', () => {
  it('is null without a session', () => {
    expect(managerIdentityOf(null)).toBeNull();
  });

  it('carries the manager’s captured users.id, name, sign-in time and scope (main-only)', () => {
    vi.useFakeTimers({ now: new Date(SIGNED_IN_AT) });
    try {
      const record = new SessionManager().create({
        operator_id: 'clerk-mgr',
        display_name: 'Mona Manager',
        role: 'manager',
        tenant_id: 't1',
        branch_id: 'b1',
        backend_session_id: 'backend-1',
        started_at: '2026-10-06T07:00:00.000Z',
        manager_user_id: MANAGER_USER,
      });
      expect(managerIdentityOf(record)).toEqual({
        operatorSessionId: record.id,
        role: 'manager',
        userId: MANAGER_USER,
        displayName: 'Mona Manager',
        signedInAt: SIGNED_IN_AT,
        tenantId: 't1',
        branchId: 'b1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no users.id nor sign-in time for a session without a captured manager id', () => {
    const record = new SessionManager().create({
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
      displayName: 'Cashier',
      tenantId: 't1',
      branchId: 'b1',
    });
  });
});

describe('createManagerOnlineRefresh — an online manager sign-in refreshes the record (P2-1)', () => {
  function signIn(over: { role?: 'manager' | 'cashier'; id?: string } = {}) {
    return new SessionManager().create({
      operator_id: 'clerk-mgr',
      display_name: 'Mona',
      role: over.role ?? 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'backend-1',
      ...(over.id === undefined ? {} : { manager_user_id: over.id }),
    });
  }

  it('touches the manager’s record on the current terminal at the sign-in time', () => {
    const touchOnline = vi.fn();
    const refresh = createManagerOnlineRefresh({
      store: { touchOnline },
      currentTerminalId: () => 'term-1',
    });
    const record = signIn({ id: MANAGER_USER });
    refresh(record);
    expect(touchOnline).toHaveBeenCalledWith({
      scope: SCOPE,
      userId: MANAGER_USER,
      at: record.manager_signed_in_at,
    });
  });

  it.each<[string, () => ReturnType<typeof signIn>, () => string | null]>([
    ['a session without a manager users.id', () => signIn(), () => 'term-1'],
    ['a cashier session', () => signIn({ role: 'cashier', id: MANAGER_USER }), () => 'term-1'],
    ['an unpaired terminal', () => signIn({ id: MANAGER_USER }), () => null],
  ])('touches nothing for %s', (_name, record, terminal) => {
    const touchOnline = vi.fn();
    createManagerOnlineRefresh({ store: { touchOnline }, currentTerminalId: terminal })(record());
    expect(touchOnline).not.toHaveBeenCalled();
  });

  it('refreshes a real record end to end', async () => {
    await enrollment.enroll({ managerPin: PIN });
    const record = signIn({ id: MANAGER_USER });
    createManagerOnlineRefresh({ store, currentTerminalId: () => 'term-1' })(record);
    expect(records()[0]?.[8]).toBe(record.manager_signed_in_at);
  });
});
