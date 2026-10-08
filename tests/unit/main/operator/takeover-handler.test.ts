import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  TakeoverHandler,
  ProtoSessionStore,
  type ProtoSession,
} from '../../../../src/main/operator/takeover-handler.js';
import type { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { CreateSessionInput } from '../../../../src/main/operator/session-manager.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { JwtHolder } from '../../../../src/main/operator/jwt-holder.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import {
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

// --- helpers ---

function makePairedStore(terminal_id = 'term-1'): PairingStore {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 't1',
        branch_id: 'b1',
        terminal_id,
        terminal_label: 'T1',
        paired_at: 0,
      }),
    ),
    persist: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  };
}

function makeSessionManager(): SessionManager {
  let current: ReturnType<SessionManager['getCurrent']> = null;
  return {
    create: vi.fn((input: CreateSessionInput) => {
      const record = {
        id: randomUUID(),
        operator_id: input.operator_id,
        display_name: input.display_name,
        role: input.role,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        backend_session_id: input.backend_session_id,
        started_at: input.started_at ?? new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      };
      current = record;
      return record;
    }),
    end: vi.fn(() => {
      current = null;
    }),
    getCurrent: vi.fn(() => current),
    getCurrentBridgeView: vi.fn(() => null),
    reportActivity: vi.fn(),
  } as unknown as SessionManager;
}

/** 016 (D5 C-2): the opaque pos_operator envelope DP-2 #559 returns on takeover. */
const TAKEOVER_ENVELOPE = 'opaque-pos-operator-envelope-takeover-002';

function makeBackend(kind: 'signed_in' | 'refused' | 'no_connection' = 'signed_in'): BackendClient {
  const signedInResponse =
    kind === 'signed_in'
      ? {
          kind: 'signed_in' as const,
          operator: {
            id: 'op-mgr-001',
            display_name: 'Manager One',
            role: 'manager' as const,
            tenant_id: 't1',
            branch_id: 'b1',
          },
          operator_session: { id: 'bss-001', issued_at: new Date().toISOString() },
          // 016 (C-2): the takeover-confirm success carries the envelope, exactly
          // like sign-in (BackendTakeoverConfirmResponse is a union over
          // BackendSignInSuccess; the C-1 interpreter fix already preserves it).
          pos_operator_envelope: TAKEOVER_ENVELOPE,
        }
      : null;

  return {
    signIn: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    signOut: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    confirmTakeover: vi.fn(() =>
      Promise.resolve(kind === 'signed_in' ? signedInResponse : { kind }),
    ),
  } as unknown as BackendClient;
}

function makeJwtHolder(): JwtHolder {
  const store = new Map<string, string>();
  return {
    set: vi.fn((id: string, jwt: string) => store.set(id, jwt)),
    get: vi.fn((id: string) => store.get(id) ?? null),
    clear: vi.fn((id: string) => store.delete(id)),
  };
}

function makeAuditEmitter(): { emitter: AuditEmitter; emitFn: ReturnType<typeof vi.fn> } {
  const emitFn = vi.fn();
  const emitter = { emit: emitFn } as unknown as AuditEmitter;
  return { emitter, emitFn };
}

function makeProtoStore(): ProtoSessionStore {
  return new ProtoSessionStore();
}

function buildManagerProto(overrides: Partial<ProtoSession> = {}): ProtoSession {
  return {
    pending_takeover_id: randomUUID(),
    operator_id: 'op-mgr-001',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    jwt: 'clerk-jwt-token',
    created_at: Date.now(),
    ...overrides,
  };
}

function buildCashierProto(overrides: Partial<ProtoSession> = {}): ProtoSession {
  return {
    pending_takeover_id: randomUUID(),
    operator_id: 'cashier-001',
    user_id: FAKE_USER_ID,
    display_name: 'Jane Cashier',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    jwt: null,
    created_at: Date.now(),
    ...overrides,
  };
}

// --- tests ---

describe('TakeoverHandler — confirmTakeover: invalid/missing pending_takeover_id', () => {
  it('returns refused/invalid_input for empty string id', async () => {
    const store = makeProtoStore();
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({ pending_takeover_id: '' });
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns refused/invalid_input when id not in store', async () => {
    const store = makeProtoStore();
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({ pending_takeover_id: randomUUID() });
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns refused/invalid_input for expired proto-session', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto({ created_at: Date.now() - 61_000 }); // expired
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('TakeoverHandler — confirmTakeover: manager/admin path (backend called)', () => {
  it('returns signed_in with correct session shape on backend success', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const sm = makeSessionManager();
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: sm,
      backend: makeBackend('signed_in'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result.kind).toBe('signed_in');
    if (result.kind !== 'signed_in') return;
    expect(result.session.role).toBe('manager');
    expect(result.session.operator_id).toBe('op-mgr-001');
  });

  it('splits the credential seam post-takeover: JWT in jwtHolder, envelope in envelopeHolder (016 review HIGH)', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto(); // proto.jwt === 'clerk-jwt-token'
    store.set(proto);
    const jwtHolder = makeJwtHolder();
    const envelopeHolder = makeJwtHolder();
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('signed_in'),
      jwtHolder,
      envelopeHolder,
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    // 016 (review HIGH): DP-2 splits POS auth. A manager/admin takeover installs
    // the NEW operator's authority, so re-key BOTH holders on the new backend
    // session id ('bss-001'):
    //   • jwtHolder ← proto.jwt — the NEW operator's provider JWT (operator-identity).
    //     This is the SAME JWT the confirm CALL used; sign-out + stuck-shifts read it
    //     (028 §6 CM-1). If it held the envelope, those routes would 401.
    //   • envelopeHolder ← the opaque pos_operator envelope from the confirm success
    //     (operatorAuthorization) — authorizes ONLY the sale-sync POSTs.
    expect(jwtHolder.get('bss-001')).toBe(proto.jwt);
    expect(jwtHolder.get('bss-001')).not.toBe(TAKEOVER_ENVELOPE);
    expect(jwtHolder.get('bss-001')).not.toBe('');
    expect(envelopeHolder.get('bss-001')).toBe(TAKEOVER_ENVELOPE);
    expect(envelopeHolder.get('bss-001')).not.toBe(proto.jwt);
  });

  it('emits operator.session.takeover audit event on success', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter, emitFn } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('signed_in'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(emitFn).toHaveBeenCalledOnce();
    const [emittedEvent] = emitFn.mock.calls[0] as [AuditEvent];
    expect(emittedEvent.action_category).toBe('operator.session.takeover');
  });

  it('discards proto-session after successful confirm (idempotency: second call returns invalid_input)', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('signed_in'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    const second = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(second).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns refused/no_connection and retains proto-session on backend no_connection', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('no_connection'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result).toEqual({ kind: 'refused', category: 'no_connection' });
    // Proto-session retained → retry is possible
    const retry = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    // retry still hits backend (backend still returns no_connection in this test)
    expect(retry).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it('returns refused/invalid_input and discards proto-session on backend refused', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('refused'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result).toEqual({ kind: 'refused', category: 'invalid_input' });
    // Proto discarded → second call also invalid_input
    expect(store.get(proto.pending_takeover_id)).toBeUndefined();
  });
});

describe('TakeoverHandler — confirmTakeover: cashier path (Clerk takeover/confirm skipped; RT-113 P2 admits via takeover:true)', () => {
  it('returns signed_in without calling backend.confirmTakeover for cashier role', async () => {
    const store = makeProtoStore();
    const proto = buildCashierProto();
    store.set(proto);
    const backend = makeBackend('signed_in');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const confirmTakeoverFn = backend.confirmTakeover as ReturnType<typeof vi.fn>;
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend,
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result.kind).toBe('signed_in');
    expect(confirmTakeoverFn).not.toHaveBeenCalled();
  });

  it('emits audit event for cashier takeover confirm', async () => {
    const store = makeProtoStore();
    const proto = buildCashierProto();
    store.set(proto);
    const { emitter, emitFn } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.confirmTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(emitFn).toHaveBeenCalledOnce();
    const [emittedEvent] = emitFn.mock.calls[0] as [AuditEvent];
    expect(emittedEvent.action_category).toBe('operator.session.takeover');
  });
});

describe('TakeoverHandler — audit failure is best-effort', () => {
  it('still returns signed_in for manager path even when auditEmitter.emit throws', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const throwingEmitter = {
      emit: vi.fn(() => {
        throw new Error('DB write failed');
      }),
    } as unknown as AuditEmitter;
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend('signed_in'),
      jwtHolder: makeJwtHolder(),
      auditEmitter: throwingEmitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    // Audit failure must not abort the sign-in flow (best-effort per class-level JSDoc).
    expect(result.kind).toBe('signed_in');
  });

  it('still returns signed_in for cashier path even when auditEmitter.emit throws', async () => {
    const store = makeProtoStore();
    const proto = buildCashierProto();
    store.set(proto);
    const throwingEmitter = {
      emit: vi.fn(() => {
        throw new Error('DB write failed');
      }),
    } as unknown as AuditEmitter;
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: throwingEmitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.confirmTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result.kind).toBe('signed_in');
  });
});

describe('TakeoverHandler — cancelTakeover', () => {
  it('returns { kind: "cancelled" } for a valid pending id', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.cancelTakeover({
      pending_takeover_id: proto.pending_takeover_id,
    });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('returns { kind: "cancelled" } idempotently for an unknown id (already cancelled or never existed)', async () => {
    const store = makeProtoStore();
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    const result = await handler.cancelTakeover({ pending_takeover_id: randomUUID() });
    expect(result).toEqual({ kind: 'cancelled' });
  });

  it('discards the proto-session on cancel (store is empty after cancel)', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.cancelTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(store.get(proto.pending_takeover_id)).toBeUndefined();
  });

  it('does not emit an audit event on cancel', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const { emitter, emitFn } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: makeSessionManager(),
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.cancelTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('does not change the active session on cancel', async () => {
    const store = makeProtoStore();
    const proto = buildManagerProto();
    store.set(proto);
    const sm = makeSessionManager();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const createFn = sm.create as ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const endFn = sm.end as ReturnType<typeof vi.fn>;
    const { emitter } = makeAuditEmitter();
    const handler = new TakeoverHandler({
      protoStore: store,
      sessionManager: sm,
      backend: makeBackend(),
      jwtHolder: makeJwtHolder(),
      auditEmitter: emitter,
      pairingStore: makePairedStore(),
      deviceTokenAttestation: () => 'att-token',
      cashierAdmission: fakeCashierAdmission().deps,
    });
    await handler.cancelTakeover({ pending_takeover_id: proto.pending_takeover_id });
    expect(createFn).not.toHaveBeenCalled();
    expect(endFn).not.toHaveBeenCalled();
  });
});
