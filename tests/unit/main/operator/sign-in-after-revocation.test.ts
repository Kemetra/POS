import { beforeAll, describe, expect, it, vi } from 'vitest';

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
import { createJwtHolder } from '../../../../src/main/operator/jwt-holder.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { ClerkExchanger } from '../../../../src/main/operator/clerk-client.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-215 / Codex P1 4181556645 — a sign-in (manager or cashier) or a takeover
 * that is still awaiting the network when the device revocation is confirmed
 * must NOT complete: no session is created, the credential holders stay
 * empty, and the IPC answer is the generic refusal. Likewise when the terminal
 * was re-paired (pairing A → B) while the request was in flight, and for a
 * takeover proto captured under another pairing.
 *
 * The pairing epoch (PairingStore.getPairingEpoch) is captured at request
 * start and re-checked right before `SessionManager.create()`.
 */

const REFUSED = { kind: 'refused', category: 'invalid_input' } as const;
/** The cashier path verifies an argon2 PIN first; under a loaded runner that exceeds 1 s. */
const WAIT = { timeout: 15_000 };
const EPOCH_A = '1|term-A|100';
const EPOCH_B = '3|term-B|200';

/** The pairing epoch as the store reports it; null = revoked (or unpaired). */
function epochSource(initial: string | null = EPOCH_A): {
  read: () => string | null;
  set(v: string | null): void;
} {
  let value = initial;
  return {
    read: () => value,
    set(v) {
      value = v;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const paired: PairingStore = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 't1',
      branch_id: 'b1',
      terminal_id: 'term-A',
      terminal_label: 'T1',
      paired_at: 100,
    }),
  getCurrentTerminalId: () => 'term-A',
  persist: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

const BACKEND_SIGNED_IN = {
  kind: 'signed_in',
  operator: {
    id: 'user_mgr',
    display_name: 'Sara',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: { id: 'bs-1', issued_at: '2026-10-05T09:00:00.000Z' },
  pos_operator_envelope: 'envelope-SENTINEL',
} as const;

/**
 * The best-effort backend sign-out the epoch refusal issues for the session the
 * late success created (Codex P2 4186872826). Defaults to a resolved
 * `signed_out`; a test may make it reject or throw.
 */
function signOutFake(impl: () => unknown = () => Promise.resolve({ kind: 'signed_out' })) {
  return vi.fn<(req: { session_id: string }, jwt: string) => unknown>(impl);
}

function managerHarness(epochs: ReturnType<typeof epochSource>, signOut = signOutFake()) {
  const sessions = new SessionManager();
  const jwt = createJwtHolder();
  const envelope = createJwtHolder();
  const backendAnswer = deferred<unknown>();
  const backend = {
    signIn: vi.fn(() => backendAnswer.promise),
    signOut,
  } as unknown as BackendClient;
  const clerk = {
    exchange: vi.fn(() =>
      Promise.resolve({
        kind: 'ok',
        jwt: 'jwt-SENTINEL',
        operator_id: 'user_mgr',
        display_name: 'Sara',
        role: 'manager',
      }),
    ),
  } as unknown as ClerkExchanger;
  const handler = new SignInHandler({
    clerk,
    backend,
    sessionManager: sessions,
    jwtHolder: jwt,
    envelopeHolder: envelope,
    protoStore: new ProtoSessionStore(),
    deviceTokenAttestation: () => 'att',
    pairingEpoch: epochs.read,
  });
  return { handler, sessions, jwt, envelope, backendAnswer, signOut };
}

describe('manager sign-in in flight when the device is revoked (Codex P1)', () => {
  it('a late backend success is dropped: refused, no session, empty holders, its backend session signed out (Codex P2 4186872826)', async () => {
    const epochs = epochSource();
    const h = managerHarness(epochs);
    const pending = h.handler.signIn({ kind: 'manager_admin', identifier: 'sara', password: 'pw' });
    await vi.waitFor(() => {
      expect(h.backendAnswer).toBeDefined();
    }, WAIT);
    epochs.set(null); // revocation confirmed while the backend call is in flight
    h.backendAnswer.resolve(BACKEND_SIGNED_IN);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.jwt.get('bs-1')).toBeNull();
    expect(h.envelope.get('bs-1')).toBeNull();
    // Best-effort, provider JWT only (operator-identity) — never the device bearer.
    expect(h.signOut.mock.calls).toEqual([[{ session_id: 'bs-1' }, 'jwt-SENTINEL']]);
  });

  it.each<[string, () => unknown]>([
    ['rejects', () => Promise.reject(new Error('down'))],
    [
      'throws',
      () => {
        throw new Error('boom');
      },
    ],
  ])(
    'Codex P2 4186872826: a sign-out that %s is contained (still the refusal)',
    async (_l, impl) => {
      const epochs = epochSource();
      const h = managerHarness(epochs, signOutFake(impl));
      const pending = h.handler.signIn({
        kind: 'manager_admin',
        identifier: 'sara',
        password: 'pw',
      });
      epochs.set(EPOCH_B);
      h.backendAnswer.resolve(BACKEND_SIGNED_IN);
      await expect(pending).resolves.toEqual(REFUSED);
      expect(h.signOut).toHaveBeenCalledTimes(1);
      expect(h.sessions.getCurrent()).toBeNull();
    },
  );

  it('a re-pair to another pairing while in flight also refuses', async () => {
    const epochs = epochSource();
    const h = managerHarness(epochs);
    const pending = h.handler.signIn({ kind: 'manager_admin', identifier: 'sara', password: 'pw' });
    epochs.set(EPOCH_B);
    h.backendAnswer.resolve(BACKEND_SIGNED_IN);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(h.sessions.getCurrent()).toBeNull();
  });

  it('an unchanged pairing still signs in (control)', async () => {
    const h = managerHarness(epochSource());
    const pending = h.handler.signIn({ kind: 'manager_admin', identifier: 'sara', password: 'pw' });
    h.backendAnswer.resolve(BACKEND_SIGNED_IN);
    await expect(pending).resolves.toMatchObject({ kind: 'signed_in' });
    expect(h.jwt.get('bs-1')).toBe('jwt-SENTINEL');
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a revoked device at request start is refused before any session', async () => {
    const h = managerHarness(epochSource(null));
    const pending = h.handler.signIn({ kind: 'manager_admin', identifier: 'sara', password: 'pw' });
    h.backendAnswer.resolve(BACKEND_SIGNED_IN);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(h.sessions.getCurrent()).toBeNull();
  });

  it('a manager takeover_required proto records the pairing epoch it was issued under', async () => {
    const epochs = epochSource();
    const protoStore = new ProtoSessionStore();
    const backend = {
      signIn: vi.fn(() => Promise.resolve({ kind: 'takeover_required' })),
    } as unknown as BackendClient;
    const handler = new SignInHandler({
      clerk: {
        exchange: () =>
          Promise.resolve({
            kind: 'ok',
            jwt: 'j',
            operator_id: 'user_mgr',
            display_name: 'S',
            role: 'manager',
          }),
      } as unknown as ClerkExchanger,
      backend,
      sessionManager: new SessionManager(),
      protoStore,
      deviceTokenAttestation: () => 'att',
      pairingEpoch: epochs.read,
    });
    const res = await handler.signIn({ kind: 'manager_admin', identifier: 's', password: 'p' });
    expect(res.kind).toBe('takeover_required');
    const id = (res as { pending_takeover_id: string }).pending_takeover_id;
    expect(protoStore.get(id)?.pairing_epoch).toBe(EPOCH_A);
  });
});

// ── Cashier sign-in ─────────────────────────────────────────────────────

const PIN = '739182';
const PREFIX = Buffer.from('SEALED:', 'utf8');
const ss: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString: (buf) => buf.subarray(PREFIX.length).toString('utf8'),
};
let pinRow: Record<string, unknown>;

beforeAll(async () => {
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, ss);
  pinRow = {
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-A',
    cashier_clerk_user_id: 'user_clerk_cashier_1',
    user_id: FAKE_USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

function pinDb(): DatabaseHandle {
  return {
    pragma: () => undefined,
    prepare: (sql: string) =>
      /^\s*SELECT/i.test(sql) ? { get: () => pinRow } : { run: () => undefined },
    exec: () => undefined,
    transaction: <T>(fn: T) => fn,
    close: () => undefined,
  };
}

describe('cashier sign-in in flight when the device is revoked (Codex P1)', () => {
  it('a late admitted is dropped: refused, no session', async () => {
    const epochs = epochSource();
    const answer = deferred<CashierAdmissionResult>();
    const fake = fakeCashierAdmission(() => answer.promise);
    const sessions = new SessionManager();
    const handler = new CashierSignInHandler({
      db: pinDb(),
      safeStorage: ss,
      sessionManager: sessions,
      admission: fake.deps,
      pairingStore: paired,
      protoStore: new ProtoSessionStore(),
      pairingEpoch: epochs.read,
    });
    const pending = handler.signIn({
      kind: 'cashier',
      cashier_clerk_user_id: 'user_clerk_cashier_1',
      pin: PIN,
      display_name: 'Mona',
    });
    await vi.waitFor(() => {
      expect(fake.admitCalls).toHaveLength(1);
    }, WAIT);
    epochs.set(null);
    answer.resolve(ADMITTED);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(sessions.getCurrent()).toBeNull();
  });
});

// ── Takeover ────────────────────────────────────────────────────────────

function takeoverHarness(
  epochs: ReturnType<typeof epochSource>,
  admit?: () => Promise<CashierAdmissionResult>,
) {
  const store = new ProtoSessionStore();
  const sessions = new SessionManager();
  const jwt = createJwtHolder();
  const envelope = createJwtHolder();
  const confirm = deferred<unknown>();
  const signOut = signOutFake();
  const backend = {
    confirmTakeover: vi.fn(() => confirm.promise),
    signOut,
  } as unknown as BackendClient;
  const fake = fakeCashierAdmission(admit ?? ADMITTED);
  const handler = new TakeoverHandler({
    protoStore: store,
    sessionManager: sessions,
    backend,
    jwtHolder: jwt,
    envelopeHolder: envelope,
    auditEmitter: { emit: vi.fn() } as unknown as AuditEmitter,
    pairingStore: paired,
    deviceTokenAttestation: () => 'att',
    cashierAdmission: fake.deps,
    pairingEpoch: epochs.read,
  });
  return { handler, store, sessions, jwt, envelope, confirm, fake, signOut };
}

function managerProto(over: Partial<ProtoSession> = {}): ProtoSession {
  return {
    pending_takeover_id: 'pt-1',
    operator_id: 'user_mgr',
    display_name: 'Sara',
    role: 'manager',
    tenant_id: '',
    branch_id: '',
    jwt: 'jwt-SENTINEL',
    created_at: Date.now(),
    pairing_epoch: EPOCH_A,
    ...over,
  };
}

describe('takeover in flight when the device is revoked (Codex P1)', () => {
  it('manager: a late confirm success is dropped: refused, no session, empty holders, its backend session signed out (Codex P2 4186872826)', async () => {
    const epochs = epochSource();
    const h = takeoverHarness(epochs);
    h.store.set(managerProto());
    const pending = h.handler.confirmTakeover({ pending_takeover_id: 'pt-1' });
    await vi.waitFor(() => {
      expect(h.confirm).toBeDefined();
    }, WAIT);
    epochs.set(null);
    h.confirm.resolve(BACKEND_SIGNED_IN);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.jwt.get('bs-1')).toBeNull();
    expect(h.envelope.get('bs-1')).toBeNull();
    expect(h.signOut.mock.calls).toEqual([[{ session_id: 'bs-1' }, 'jwt-SENTINEL']]);
  });

  it('cashier: a late admitted (takeover:true) is dropped', async () => {
    const epochs = epochSource();
    const answer = deferred<CashierAdmissionResult>();
    const h = takeoverHarness(epochs, () => answer.promise);
    h.store.set(
      managerProto({
        role: 'cashier',
        user_id: FAKE_USER_ID,
        jwt: null,
        tenant_id: 't1',
        branch_id: 'b1',
      }),
    );
    const pending = h.handler.confirmTakeover({ pending_takeover_id: 'pt-1' });
    await vi.waitFor(() => {
      expect(h.fake.admitCalls).toHaveLength(1);
    }, WAIT);
    epochs.set(null);
    answer.resolve(ADMITTED);
    await expect(pending).resolves.toEqual(REFUSED);
    expect(h.sessions.getCurrent()).toBeNull();
  });

  it('a proto issued under pairing A is refused under pairing B, with no backend call', async () => {
    const h = takeoverHarness(epochSource(EPOCH_B));
    h.store.set(managerProto({ pairing_epoch: EPOCH_A }));
    await expect(h.handler.confirmTakeover({ pending_takeover_id: 'pt-1' })).resolves.toEqual(
      REFUSED,
    );
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.store.get('pt-1')).toBeUndefined();
  });

  it('manager: revoked during the takeover audit → the latched session is refused, not signed_in', async () => {
    const epochs = epochSource();
    const h = takeoverHarness(epochs);
    h.store.set(managerProto());
    // The takeover audit awaits the pairing status read: hold it there.
    const statusRead = deferred<Awaited<ReturnType<PairingStore['getStatus']>>>();
    (h.handler as unknown as { deps: { pairingStore: unknown } }).deps.pairingStore = {
      getStatus: () => statusRead.promise,
    };
    const pending = h.handler.confirmTakeover({ pending_takeover_id: 'pt-1' });
    h.confirm.resolve(BACKEND_SIGNED_IN);
    await vi.waitFor(() => {
      expect(h.sessions.getCurrent()).not.toBeNull();
    }, WAIT);
    // The revocation flow latches the session (it ends at its safe point).
    const current = h.sessions.getCurrent();
    if (current !== null) h.sessions.latchAuthority(current.id, 'terminal_session_terminated');
    statusRead.resolve({ kind: 'invalid', reason: 'device_revoked' });
    await expect(pending).resolves.toEqual(REFUSED);
  });
});
