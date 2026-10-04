import { beforeAll, describe, expect, it } from 'vitest';

import { hashPin } from '../../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../../src/main/operator/pin-seal.js';
import {
  CashierSignInHandler,
  type CashierSignInRequest,
} from '../../../../src/main/operator/sign-in-handler.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import { ProtoSessionStore } from '../../../../src/main/operator/takeover-handler.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

import { contractErrors } from './__helpers__/openapi-schema.js';

/**
 * RT-113 P2 — cashier PIN sign-in through the device-authenticated
 * cashier-admissions resource (RT-113 10763 D2, 10844; fixes RT-182).
 *
 * After the local PIN check the handler calls
 * `POST /api/pos/v1/cashier-admissions` `{mode:'online', user_id,
 * takeover:false, idempotency_key}` and maps every outcome. The Clerk-gated
 * `GET /operators/active-session` is gone from this path.
 */

const PIN = '739182';
const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term1';
const CLERK_ID = 'user_clerk_cashier_1';

const PREFIX = Buffer.from('SEALED:', 'utf8');
const ss: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
  decryptString(buf) {
    if (!buf.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('tampered');
    return buf.subarray(PREFIX.length).toString('utf8');
  },
};

interface Row {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  cashier_clerk_user_id: string;
  user_id?: string | null;
  pin_hash: Buffer;
  pin_salt: Buffer;
  failed_attempt_count: number;
  lockout_until: string | null;
}

let row: Row;

beforeAll(async () => {
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, ss);
  row = {
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    cashier_clerk_user_id: CLERK_ID,
    user_id: FAKE_USER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

function makeDb(r: Row | undefined): DatabaseHandle {
  return {
    pragma: () => undefined,
    prepare(sql: string) {
      if (/^\s*SELECT/i.test(sql)) return { get: () => r };
      return { run: () => undefined };
    },
    exec: () => undefined,
    transaction: <T>(fn: T) => fn,
    close: () => undefined,
  } as unknown as DatabaseHandle;
}

const paired: PairingStore = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      terminal_label: 'T1',
      paired_at: 0,
    }),
  persist: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

function request(overrides: Partial<CashierSignInRequest> = {}): CashierSignInRequest {
  return {
    kind: 'cashier',
    cashier_clerk_user_id: CLERK_ID,
    pin: PIN,
    display_name: 'Renderer Name',
    ...overrides,
  };
}

function build(
  result: CashierAdmissionResult = ADMITTED,
  r: Row | undefined = row,
): {
  handler: CashierSignInHandler;
  sessions: SessionManager;
  protoStore: ProtoSessionStore;
  fake: ReturnType<typeof fakeCashierAdmission>;
} {
  const sessions = new SessionManager();
  const protoStore = new ProtoSessionStore();
  const fake = fakeCashierAdmission(result);
  const handler = new CashierSignInHandler({
    db: makeDb(r),
    safeStorage: ss,
    sessionManager: sessions,
    admission: fake.deps,
    pairingStore: paired,
    protoStore,
  });
  return { handler, sessions, protoStore, fake };
}

describe('cashier sign-in — admission request', () => {
  it('after the PIN check, admits online with the pin row user_id and a fresh key', async () => {
    const { handler, fake } = build();
    await handler.signIn(request());
    await handler.signIn(request());

    expect(fake.admitCalls).toHaveLength(2);
    const [first, second] = fake.admitCalls;
    expect(first).toEqual({
      mode: 'online',
      user_id: FAKE_USER_ID,
      takeover: false,
      idempotency_key: 'test-idempotency-key-0001',
    });
    expect(second?.idempotency_key).toBe('test-idempotency-key-0002');
    expect(contractErrors('PosCashierAdmissionRequest', first)).toEqual([]);
    expect(JSON.stringify(fake.admitCalls)).not.toContain(PIN);
  });

  it('a wrong PIN never reaches the admission resource', async () => {
    const { handler, fake } = build();
    const res = await handler.signIn(request({ pin: '000000' }));
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(fake.admitCalls).toHaveLength(0);
  });

  it('a pin row without a user_id is refused without any admission call', async () => {
    const { handler, fake, sessions } = build(ADMITTED, { ...row, user_id: null });
    const res = await handler.signIn(request());
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(fake.admitCalls).toHaveLength(0);
    expect(sessions.getCurrent()).toBeNull();
  });
});

describe('cashier sign-in — admitted', () => {
  it('creates the session with user_id, admission and authority online_confirmed', async () => {
    const { handler, sessions } = build();
    const res = await handler.signIn(request());

    expect(res.kind).toBe('signed_in');
    const current = sessions.getCurrent();
    expect(current).toMatchObject({
      operator_id: CLERK_ID,
      role: 'cashier',
      tenant_id: TENANT,
      branch_id: BRANCH,
      backend_session_id: '',
      user_id: FAKE_USER_ID,
      authority: 'online_confirmed',
      admission_id: ADMITTED.admission_id,
      admission_ttl_seconds: ADMITTED.admission_ttl_seconds,
      offline_grace_seconds: ADMITTED.offline_grace_seconds,
      // The server-resolved display name is authoritative.
      display_name: 'Server Name',
    });
    if (res.kind === 'signed_in') {
      expect(res.session.display_name).toBe('Server Name');
      expect(res.session).not.toHaveProperty('admission_id');
      expect(res.session).not.toHaveProperty('user_id');
    }
  });

  it('calls the P1 grant seam onCashierAdmitted exactly once', async () => {
    const { handler, fake } = build();
    await handler.signIn(request());
    expect(fake.admitted).toHaveLength(1);
    expect(fake.admitted[0]).toMatchObject({
      user_id: FAKE_USER_ID,
      operator_id: CLERK_ID,
      admission_id: ADMITTED.admission_id,
      offline_grace_seconds: ADMITTED.offline_grace_seconds,
      server_time: ADMITTED.server_time,
      display_name: 'Server Name',
    });
    expect(fake.invalidated).toEqual([]);
  });
});

describe('cashier sign-in — active_elsewhere', () => {
  it('returns takeover_required and keeps the user_id on the proto-session', async () => {
    const { handler, sessions, protoStore } = build({ kind: 'active_elsewhere' });
    const res = await handler.signIn(request());

    expect(res.kind).toBe('takeover_required');
    expect(sessions.getCurrent()).toBeNull();
    if (res.kind === 'takeover_required') {
      const proto = protoStore.get(res.pending_takeover_id);
      expect(proto).toMatchObject({
        role: 'cashier',
        operator_id: CLERK_ID,
        user_id: FAKE_USER_ID,
        tenant_id: TENANT,
        branch_id: BRANCH,
        jwt: null,
      });
    }
  });
});

describe('cashier sign-in — refusal outcome table', () => {
  it.each([
    [{ kind: 'refused' }, 'invalid_input'],
    [{ kind: 'device_unauthorized' }, 'invalid_input'],
    [{ kind: 'idempotency_conflict' }, 'invalid_input'],
    [{ kind: 'rejected' }, 'invalid_input'],
    [{ kind: 'rate_limited' }, 'rate_limited'],
    [{ kind: 'unavailable' }, 'no_connection'],
    [{ kind: 'no_connection' }, 'no_connection'],
  ] as const)('%o → refused/%s, no session', async (result, category) => {
    const { handler, sessions, fake } = build(result as CashierAdmissionResult);
    const res = await handler.signIn(request());
    expect(res).toEqual({ kind: 'refused', category });
    expect(sessions.getCurrent()).toBeNull();
    expect(fake.admitted).toEqual([]);
  });

  it('403 refused invalidates that user’s offline grant (P1 seam) and nothing else', async () => {
    const { handler, fake } = build({ kind: 'refused' });
    await handler.signIn(request());
    expect(fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
    expect(fake.deviceRevoked).not.toHaveBeenCalled();
  });

  it('device 401 runs the device-revoked handling and invalidates every grant (P1 seam)', async () => {
    const { handler, fake } = build({ kind: 'device_unauthorized' });
    await handler.signIn(request());
    expect(fake.deviceRevoked).toHaveBeenCalledOnce();
    expect(fake.invalidated).toEqual([{ reason: 'device_unauthorized' }]);
  });

  it('a network failure keeps today’s behaviour: offline sign-in is refused no_connection', async () => {
    const { handler, fake } = build({ kind: 'no_connection' });
    const res = await handler.signIn(request());
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(fake.invalidated).toEqual([]);
    expect(fake.deviceRevoked).not.toHaveBeenCalled();
  });
});
