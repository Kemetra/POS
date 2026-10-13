/* eslint-disable @typescript-eslint/unbound-method -- vi.fn() spies asserted through their owners */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import {
  CashierSignInHandler,
  SignInHandler,
} from '../../../../src/main/operator/sign-in-handler.js';
import {
  ProtoSessionStore,
  TakeoverHandler,
  type ProtoSession,
} from '../../../../src/main/operator/takeover-handler.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import {
  createSessionAdmission,
  type AdmissionVerdict,
  type SessionAdmission,
} from '../../../../src/main/operator/session-admission.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { ClerkExchanger } from '../../../../src/main/operator/clerk-client.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-444 (RT-116 S3) — every sign-in path asks the §4 guard twice: before its
 * network call (`check`) and right before `create()` (`admit`, which ends a
 * locked session `superseded_at_lock`). Per path:
 *   • end() precedes create(): onEnded(superseded_at_lock) fires before onStarted;
 *   • a refused `check` makes no network call and leaves the locked session;
 *   • a refused `admit` cleans up what the network call created.
 */

const PIN = '739182';
const LOCKED_OPERATOR = 'op-locked';
const NEW_CASHIER = 'user_clerk_cashier_2';
const NEW_MANAGER = 'clerk-manager-2';
const NOW = '2026-10-13T10:00:00.000Z';
const REFUSED: AdmissionVerdict = {
  kind: 'refused',
  refusal: { kind: 'refused', category: 'terminal_has_unresolved_payment' },
};

const PREFIX = Buffer.from('SEALED:', 'utf8');
const ss: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => buf.subarray(PREFIX.length).toString('utf8'),
};

let pinRow: Record<string, unknown>;
beforeAll(async () => {
  const sealed = sealPinMaterial(await hashPin(PIN), ss);
  pinRow = {
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-1',
    cashier_clerk_user_id: NEW_CASHIER,
    user_id: FAKE_USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

/** Any SELECT answers `row`; writes are no-ops. */
function stubDb(row: unknown): DatabaseHandle {
  return {
    pragma: () => undefined,
    prepare: (sql: string) =>
      /^\s*SELECT/i.test(sql) ? { get: () => row } : { run: () => ({ changes: 0 }) },
    exec: () => undefined,
    transaction: <T>(fn: T) => fn,
    close: () => undefined,
  };
}

const paired: PairingStore = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 't1',
      branch_id: 'b1',
      terminal_id: 'term-1',
      terminal_label: 'T1',
      paired_at: 0,
    }),
  persist: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

const signedInBackend = (operator_id: string) => ({
  kind: 'signed_in' as const,
  operator: {
    id: operator_id,
    user_id: '33333333-3333-7333-8333-333333333333',
    display_name: 'Manager Two',
    role: 'manager' as const,
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: { id: 'be-sess-2', issued_at: NOW },
  pos_operator_envelope: 'env',
});

function fakeBackend(): BackendClient {
  return {
    signIn: vi.fn(() => Promise.resolve(signedInBackend(NEW_MANAGER))),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    listRoster: vi.fn(),
    confirmTakeover: vi.fn(() => Promise.resolve(signedInBackend(NEW_MANAGER))),
    getStuckShifts: vi.fn(),
  };
}

const clerk: ClerkExchanger = {
  exchange: vi.fn(() =>
    Promise.resolve({
      kind: 'ok' as const,
      jwt: 'jwt-2',
      operator_id: NEW_MANAGER,
      display_name: 'Manager Two',
      role: 'manager' as const,
    }),
  ),
};

/** A session manager holding a LOCKED cashier session, recording lifecycle order. */
function lockedTerminal(): { sm: SessionManager; order: string[]; lockedId: string } {
  const sm = new SessionManager();
  const order: string[] = [];
  const locked = sm.create({
    operator_id: LOCKED_OPERATOR,
    display_name: 'Locked One',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    started_at: NOW,
  });
  sm.lock(NOW);
  sm.onEnded((r, cause) => order.push(`ended:${r.operator_id}:${String(cause)}`));
  sm.onStarted((r) => order.push(`started:${r.operator_id}`));
  return { sm, order, lockedId: locked.id };
}

/** The real guard over a terminal with no unresolved payment. */
function realGuard(sm: SessionManager): SessionAdmission {
  return createSessionAdmission({
    db: stubDb(undefined),
    sessionManager: sm,
    resolveTerminalId: () => 'term-1',
    auditEmitter: { emit: vi.fn() },
  });
}

function scriptedGuard(check: AdmissionVerdict, admit: AdmissionVerdict): SessionAdmission {
  return { check: vi.fn(() => check), admit: vi.fn(() => admit) };
}

function managerHandler(sm: SessionManager, guard: SessionAdmission, backend = fakeBackend()) {
  return {
    backend,
    handler: new SignInHandler({
      clerk,
      backend,
      sessionManager: sm,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'att',
      sessionAdmission: guard,
    }),
  };
}

function cashierHandler(sm: SessionManager, guard: SessionAdmission) {
  const fake = fakeCashierAdmission(ADMITTED);
  return {
    fake,
    handler: new CashierSignInHandler({
      db: stubDb(pinRow),
      safeStorage: ss,
      sessionManager: sm,
      admission: fake.deps,
      pairingStore: paired,
      protoStore: new ProtoSessionStore(),
      sessionAdmission: guard,
    }),
  };
}

function takeoverHandler(sm: SessionManager, guard: SessionAdmission) {
  const fake = fakeCashierAdmission(ADMITTED);
  const backend = fakeBackend();
  const store = new ProtoSessionStore();
  const handler = new TakeoverHandler({
    protoStore: store,
    sessionManager: sm,
    backend,
    jwtHolder: { set: vi.fn(), get: vi.fn(() => null), clear: vi.fn() },
    auditEmitter: { emit: vi.fn() } as unknown as AuditEmitter,
    pairingStore: paired,
    deviceTokenAttestation: () => 'att',
    cashierAdmission: fake.deps,
    sessionAdmission: guard,
  });
  return { fake, backend, store, handler };
}

function proto(role: 'cashier' | 'manager'): ProtoSession {
  return {
    pending_takeover_id: randomUUID(),
    operator_id: role === 'cashier' ? NEW_CASHIER : NEW_MANAGER,
    ...(role === 'cashier' ? { user_id: FAKE_USER_ID } : {}),
    display_name: 'New',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    jwt: role === 'cashier' ? null : 'jwt-2',
    created_at: Date.now(),
  };
}

type Path = 'manager sign-in' | 'cashier sign-in' | 'cashier takeover' | 'manager takeover';
const PATHS: Path[] = [
  'manager sign-in',
  'cashier sign-in',
  'cashier takeover',
  'manager takeover',
];

async function run(path: Path, sm: SessionManager, guard: SessionAdmission) {
  if (path === 'manager sign-in') {
    const m = managerHandler(sm, guard);
    const res = await m.handler.signIn({
      kind: 'manager_admin',
      identifier: 'm2@pharmacy.test',
      password: 'pw',
    });
    return { res, backend: m.backend, fake: null };
  }
  if (path === 'cashier sign-in') {
    const c = cashierHandler(sm, guard);
    const res = await c.handler.signIn({
      kind: 'cashier',
      cashier_clerk_user_id: NEW_CASHIER,
      pin: PIN,
      display_name: 'New',
    });
    return { res, backend: null, fake: c.fake };
  }
  const t = takeoverHandler(sm, guard);
  const p = proto(path === 'cashier takeover' ? 'cashier' : 'manager');
  t.store.set(p);
  const res = await t.handler.confirmTakeover({ pending_takeover_id: p.pending_takeover_id });
  return { res, backend: t.backend, fake: t.fake, store: t.store, p };
}

const newOperatorOf = (path: Path): string =>
  path.startsWith('cashier') ? NEW_CASHIER : NEW_MANAGER;

describe('RT-444 — end() precedes create() on every sign-in path', () => {
  it.each(PATHS)(
    '%s: the locked session ends superseded_at_lock, then the new one starts',
    async (path) => {
      const { sm, order } = lockedTerminal();
      const { res } = await run(path, sm, realGuard(sm));

      expect(res.kind).toBe('signed_in');
      expect(order).toEqual([
        `ended:${LOCKED_OPERATOR}:superseded_at_lock`,
        `started:${newOperatorOf(path)}`,
      ]);
      expect(sm.getCurrent()?.operator_id).toBe(newOperatorOf(path));
    },
  );
});

describe('RT-444 — a refused check makes no network call', () => {
  it.each(PATHS)('%s: refused, nothing created, the locked session untouched', async (path) => {
    const { sm, order, lockedId } = lockedTerminal();
    const guard = scriptedGuard(REFUSED, { kind: 'admitted' });
    const { res, backend, fake } = await run(path, sm, guard);

    expect(res).toEqual({ kind: 'refused', category: 'terminal_has_unresolved_payment' });
    expect(guard.admit).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(sm.getCurrent()?.id).toBe(lockedId);
    expect(sm.getCurrent()?.lock_state).toBe('locked');
    if (backend !== null) {
      expect(backend.signIn).not.toHaveBeenCalled();
      expect(backend.confirmTakeover).not.toHaveBeenCalled();
    }
    if (fake !== null) expect(fake.admitCalls).toHaveLength(0);
  });

  it('a cashier is checked only after the PIN matches', async () => {
    const { sm } = lockedTerminal();
    const guard = scriptedGuard(REFUSED, { kind: 'admitted' });
    const c = cashierHandler(sm, guard);
    const res = await c.handler.signIn({
      kind: 'cashier',
      cashier_clerk_user_id: NEW_CASHIER,
      pin: '864297',
      display_name: 'New',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(guard.check).not.toHaveBeenCalled();
  });

  it('a takeover refused at check keeps its proto for a later retry', async () => {
    const { sm } = lockedTerminal();
    const t = takeoverHandler(sm, scriptedGuard(REFUSED, { kind: 'admitted' }));
    const p = proto('cashier');
    t.store.set(p);
    await t.handler.confirmTakeover({ pending_takeover_id: p.pending_takeover_id });
    expect(t.store.get(p.pending_takeover_id)).toBeDefined();
  });
});

describe('RT-444 — a refusal at create cleans up what the network call made', () => {
  const lateRefusal = (): SessionAdmission => scriptedGuard({ kind: 'admitted' }, REFUSED);

  it.each<Path>(['manager sign-in', 'manager takeover'])(
    '%s: signs the new backend session out',
    async (path) => {
      const { sm, lockedId } = lockedTerminal();
      const { res, backend } = await run(path, sm, lateRefusal());
      expect(res).toEqual({ kind: 'refused', category: 'terminal_has_unresolved_payment' });
      expect(backend?.signOut).toHaveBeenCalledWith({ session_id: 'be-sess-2' }, 'jwt-2');
      expect(sm.getCurrent()?.id).toBe(lockedId);
    },
  );

  it.each<Path>(['cashier sign-in', 'cashier takeover'])(
    '%s: ends the new admission',
    async (path) => {
      const { sm, lockedId } = lockedTerminal();
      const { res, fake } = await run(path, sm, lateRefusal());
      expect(res).toEqual({ kind: 'refused', category: 'terminal_has_unresolved_payment' });
      expect(fake?.endCalls).toEqual([FAKE_ADMISSION_ID]);
      expect(sm.getCurrent()?.id).toBe(lockedId);
    },
  );
});

describe('RT-441 — a manager is admitted in recovery mode over a stuck payment', () => {
  /** The real guard over a terminal holding another operator's live tender. */
  function stuckGuard(sm: SessionManager): SessionAdmission {
    return createSessionAdmission({
      db: stubDb({
        payment_attempt_id: 'att-stuck',
        tenant_id: 't1',
        branch_id: 'b1',
        terminal_id: 'term-1',
        acting_operator_id: LOCKED_OPERATOR,
      }),
      sessionManager: sm,
      resolveTerminalId: () => 'term-1',
      auditEmitter: { emit: vi.fn() },
    });
  }

  it.each<Path>(['manager sign-in', 'manager takeover'])(
    '%s: the new session carries recovery_of, after the locked one ended',
    async (path) => {
      const { sm, order } = lockedTerminal();
      const { res } = await run(path, sm, stuckGuard(sm));
      expect(res.kind).toBe('signed_in');
      expect(sm.getCurrent()?.recovery_of).toBe('att-stuck');
      expect(order[0]).toBe(`ended:${LOCKED_OPERATOR}:superseded_at_lock`);
    },
  );

  it.each<Path>(['cashier sign-in', 'cashier takeover'])('%s: still refused', async (path) => {
    const { sm, lockedId } = lockedTerminal();
    const { res } = await run(path, sm, stuckGuard(sm));
    expect(res).toEqual({ kind: 'refused', category: 'terminal_has_unresolved_payment' });
    expect(sm.getCurrent()?.id).toBe(lockedId);
  });
});
