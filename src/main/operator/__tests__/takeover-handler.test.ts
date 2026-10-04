import { describe, expect, it, vi } from 'vitest';

import { TakeoverHandler, ProtoSessionStore } from '../takeover-handler.js';
import { SessionManager } from '../session-manager.js';
import { createJwtHolder } from '../jwt-holder.js';
import type { BackendClient, BackendTakeoverConfirmResponse } from '../backend-client.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import type { PairingStore } from '../../pairing/store.js';

/**
 * 016-operator-envelope-adoption (review HIGH) — takeover-handler credential seam.
 *
 * DP-2 splits POS auth into TWO schemes:
 *   • operator-identity (provider JWT) — the takeover/confirm CALL itself
 *     (`Authorization: Bearer <jwt>`); proto.jwt is the identity proof.
 *   • operatorAuthorization (opaque pos_operator ENVELOPE #559) — authorizes
 *     ONLY the sale-sync routes after the takeover installs the new operator.
 *
 * After confirm:
 *   • the confirmTakeover backend CALL MUST have received proto.jwt (NOT the envelope).
 *   • jwtHolder MUST hold proto.jwt for the new backend session id (operator-identity
 *     continuity for sign-out / stuck-shifts).
 *   • envelopeHolder MUST hold the takeover-confirm success envelope (sale-sync auth).
 */

const PROTO_JWT = 'eyJhbGciOiJSUzI1NiJ9.proto.jwt';
const ENVELOPE = 'opaque-pos-operator-envelope-takeover-001';

const CONFIRM_SUCCESS: BackendTakeoverConfirmResponse = {
  kind: 'signed_in',
  operator: {
    id: 'clerk-user-2',
    user_id: '44444444-4444-7444-8444-444444444444', // DP-2 033 provider-neutral users.id
    display_name: 'Manager Two',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: {
    id: 'be-sess-2',
    issued_at: '2026-06-13T00:00:00.000Z',
  },
  pos_operator_envelope: ENVELOPE,
};

function fakeBackend(
  confirmResult: BackendTakeoverConfirmResponse,
  capture: { lastJwt?: string } = {},
): BackendClient {
  const confirmTakeover: BackendClient['confirmTakeover'] = (_req, jwt) => {
    capture.lastJwt = jwt;
    return Promise.resolve(confirmResult);
  };
  return {
    signIn: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    confirmTakeover: vi.fn(confirmTakeover),
    getStuckShifts: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
  };
}

function fakeAuditEmitter(): AuditEmitter {
  return { emit: vi.fn() } as unknown as AuditEmitter;
}

function fakePairingStore(): PairingStore {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 't1',
        branch_id: 'b1',
        terminal_id: 'term-1',
        terminal_label: 'Lane 1',
        paired_at: '2026-06-01T00:00:00.000Z',
      }),
    ),
    persist: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  } as unknown as PairingStore;
}

function seedProto(protoStore: ProtoSessionStore): string {
  const pending_takeover_id = 'ptid-1';
  protoStore.set({
    pending_takeover_id,
    operator_id: 'clerk-user-2',
    display_name: 'Manager Two',
    role: 'manager',
    tenant_id: '',
    branch_id: '',
    jwt: PROTO_JWT,
    created_at: Date.now(),
  });
  return pending_takeover_id;
}

describe('TakeoverHandler — credential seam (016 review HIGH)', () => {
  it('confirm CALL receives proto.jwt; jwtHolder gets the JWT; envelopeHolder gets the envelope', async () => {
    const protoStore = new ProtoSessionStore();
    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const envelopeHolder = createJwtHolder();
    const capture: { lastJwt?: string } = {};
    const handler = new TakeoverHandler({
      protoStore,
      sessionManager,
      backend: fakeBackend(CONFIRM_SUCCESS, capture),
      jwtHolder,
      envelopeHolder,
      auditEmitter: fakeAuditEmitter(),
      pairingStore: fakePairingStore(),
      deviceTokenAttestation: () => 'attest',
    });

    const pending = seedProto(protoStore);
    const res = await handler.confirmTakeover({ pending_takeover_id: pending });
    expect(res.kind).toBe('signed_in');

    // The confirmTakeover backend CALL is an operator-identity call: it MUST
    // present proto.jwt, NEVER the envelope.
    expect(capture.lastJwt).toBe(PROTO_JWT);
    expect(capture.lastJwt).not.toBe(ENVELOPE);

    // jwtHolder keeps the JWT for the new session (operator-identity continuity).
    expect(jwtHolder.get('be-sess-2')).toBe(PROTO_JWT);
    expect(jwtHolder.get('be-sess-2')).not.toBe(ENVELOPE);

    // envelopeHolder gets the takeover-confirm success envelope (sale-sync auth).
    expect(envelopeHolder.get('be-sess-2')).toBe(ENVELOPE);
    expect(envelopeHolder.get('be-sess-2')).not.toBe(PROTO_JWT);
  });

  it('normalizes an absent envelope to "" in envelopeHolder; jwtHolder keeps the JWT', async () => {
    const protoStore = new ProtoSessionStore();
    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const envelopeHolder = createJwtHolder();
    const { pos_operator_envelope: _drop, ...legacy } = CONFIRM_SUCCESS;
    void _drop;
    const handler = new TakeoverHandler({
      protoStore,
      sessionManager,
      backend: fakeBackend(legacy),
      jwtHolder,
      envelopeHolder,
      auditEmitter: fakeAuditEmitter(),
      pairingStore: fakePairingStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const pending = seedProto(protoStore);
    await handler.confirmTakeover({ pending_takeover_id: pending });
    expect(envelopeHolder.get('be-sess-2')).toBe('');
    expect(jwtHolder.get('be-sess-2')).toBe(PROTO_JWT);
  });
});
