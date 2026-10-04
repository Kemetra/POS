import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  ProtoSessionStore,
  TakeoverHandler,
  type ProtoSession,
} from '../../../../src/main/operator/takeover-handler.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

import { contractErrors } from './__helpers__/openapi-schema.js';

/**
 * RT-113 P2 — the existing "signed in on another till" takeover UX, routed
 * through `POST /api/pos/v1/cashier-admissions` with `takeover: true`
 * (10763 D9 "take over here"). The server ends the other device's admission.
 */

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

function cashierProto(overrides: Partial<ProtoSession> = {}): ProtoSession {
  return {
    pending_takeover_id: randomUUID(),
    operator_id: 'user_clerk_1',
    user_id: FAKE_USER_ID,
    display_name: 'Renderer Name',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    jwt: null,
    created_at: Date.now(),
    ...overrides,
  };
}

function build(result: CashierAdmissionResult = ADMITTED): {
  handler: TakeoverHandler;
  store: ProtoSessionStore;
  sessions: SessionManager;
  fake: ReturnType<typeof fakeCashierAdmission>;
  backend: BackendClient;
  emit: ReturnType<typeof vi.fn>;
} {
  const store = new ProtoSessionStore();
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission(result);
  const emit = vi.fn();
  const backend = {
    confirmTakeover: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    listRoster: vi.fn(),
    getStuckShifts: vi.fn(),
  } as unknown as BackendClient;
  const handler = new TakeoverHandler({
    protoStore: store,
    sessionManager: sessions,
    backend,
    jwtHolder: { set: vi.fn(), get: vi.fn(() => null), clear: vi.fn() },
    auditEmitter: { emit } as unknown as AuditEmitter,
    pairingStore: paired,
    deviceTokenAttestation: () => 'att',
    cashierAdmission: fake.deps,
  });
  return { handler, store, sessions, fake, backend, emit };
}

describe('cashier takeover via takeover:true', () => {
  it('admits with takeover:true for the proto user, creates the session and audits', async () => {
    const { handler, store, sessions, fake, backend, emit } = build();
    const proto = cashierProto();
    store.set(proto);

    const res = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });

    expect(res.kind).toBe('signed_in');
    expect(fake.admitCalls).toHaveLength(1);
    expect(fake.admitCalls[0]).toEqual({
      mode: 'online',
      user_id: FAKE_USER_ID,
      takeover: true,
      idempotency_key: 'test-idempotency-key-0001',
    });
    expect(contractErrors('PosCashierAdmissionRequest', fake.admitCalls[0])).toEqual([]);
    // The Clerk-gated takeover/confirm route is never used for a cashier.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(backend.confirmTakeover).not.toHaveBeenCalled();
    expect(sessions.getCurrent()).toMatchObject({
      operator_id: 'user_clerk_1',
      user_id: FAKE_USER_ID,
      authority: 'online_confirmed',
      admission_id: ADMITTED.admission_id,
      display_name: 'Server Name',
      backend_session_id: '',
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(store.get(proto.pending_takeover_id)).toBeUndefined();
    expect(fake.admitted).toHaveLength(1);
  });

  it('no_connection keeps the proto-session and retries with the SAME idempotency key', async () => {
    const { handler, store, fake, sessions } = build({ kind: 'no_connection' });
    const proto = cashierProto();
    store.set(proto);

    const first = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(first).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(store.get(proto.pending_takeover_id)).toBeDefined();
    expect(sessions.getCurrent()).toBeNull();

    fake.setAdmit(ADMITTED);
    const second = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(second.kind).toBe('signed_in');
    expect(fake.admitCalls).toHaveLength(2);
    expect(fake.admitCalls[1]?.idempotency_key).toBe(fake.admitCalls[0]?.idempotency_key);
  });

  it('unavailable (5xx) also keeps the proto-session for a retry', async () => {
    const { handler, store } = build({ kind: 'unavailable' });
    const proto = cashierProto();
    store.set(proto);
    const res = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
    expect(store.get(proto.pending_takeover_id)).toBeDefined();
  });

  it.each([
    [{ kind: 'refused' }, 'invalid_input'],
    [{ kind: 'device_unauthorized' }, 'invalid_input'],
    [{ kind: 'active_elsewhere' }, 'invalid_input'],
    [{ kind: 'idempotency_conflict' }, 'invalid_input'],
    [{ kind: 'rejected' }, 'invalid_input'],
    [{ kind: 'rate_limited' }, 'rate_limited'],
  ] as const)('%o → refused/%s, proto discarded, no session', async (result, category) => {
    const { handler, store, sessions, emit } = build(result as CashierAdmissionResult);
    const proto = cashierProto();
    store.set(proto);
    const res = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(res).toEqual({ kind: 'refused', category });
    expect(store.get(proto.pending_takeover_id)).toBeUndefined();
    expect(sessions.getCurrent()).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('403 invalidates the grant; 401 runs the device-revoked handling', async () => {
    const refused = build({ kind: 'refused' });
    const p1 = cashierProto();
    refused.store.set(p1);
    await refused.handler.confirmTakeover({ pending_takeover_id: p1.pending_takeover_id });
    expect(refused.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);

    const revoked = build({ kind: 'device_unauthorized' });
    const p2 = cashierProto();
    revoked.store.set(p2);
    await revoked.handler.confirmTakeover({ pending_takeover_id: p2.pending_takeover_id });
    expect(revoked.fake.deviceRevoked).toHaveBeenCalledOnce();
    expect(revoked.fake.invalidated).toEqual([{ reason: 'device_unauthorized' }]);
  });

  it('a cashier proto without a user_id is refused without any admission call', async () => {
    const { handler, store, fake } = build();
    const proto = cashierProto({ user_id: undefined });
    store.set(proto);
    const res = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(fake.admitCalls).toHaveLength(0);
  });

  it('without the cashier admission dependency the cashier path fails closed', async () => {
    const store = new ProtoSessionStore();
    const sessions = new SessionManager();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: sessions,
      backend: {} as BackendClient,
      jwtHolder: { set: vi.fn(), get: vi.fn(() => null), clear: vi.fn() },
      auditEmitter: { emit: vi.fn() } as unknown as AuditEmitter,
      pairingStore: paired,
      deviceTokenAttestation: () => 'att',
    });
    const proto = cashierProto();
    store.set(proto);
    const res = await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(sessions.getCurrent()).toBeNull();
  });
});
