import { describe, expect, it, vi } from 'vitest';

import { SignOutHandler } from '../sign-out-handler.js';
import { SessionManager } from '../session-manager.js';
import type { BackendClient, BackendSignOutResponse } from '../backend-client.js';

/**
 * 004-operator-session T027 + T024 — sign-out handler.
 *
 * Sign-out tears down LOCAL state synchronously and returns within
 * 1 s regardless of backend reachability (FR-008 / NFR-007). The
 * backend call is fire-and-forget with a short timeout.
 */

function fakeBackend(result: BackendSignOutResponse, calls: unknown[] = []): BackendClient {
  const signOut: BackendClient['signOut'] = (req, jwt) => {
    calls.push({ req, jwt });
    return Promise.resolve(result);
  };
  return {
    signIn: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    signOut: vi.fn(signOut),
    listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    confirmTakeover: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    getStuckShifts: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
  };
}

function makeFilledManager(): SessionManager {
  const m = new SessionManager();
  m.create({
    operator_id: 'op-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'be-sess-1',
  });
  return m;
}

describe('SignOutHandler', () => {
  it('clears the local session and resolves to signed_out', async () => {
    const sessionManager = makeFilledManager();
    const calls: unknown[] = [];
    const handler = new SignOutHandler({
      backend: fakeBackend({ kind: 'signed_out' }, calls),
      sessionManager,
      jwtFor: () => 'eyJ.fake.jwt',
    });
    const res = await handler.signOut();
    expect(res).toEqual({ kind: 'signed_out' });
    expect(sessionManager.getCurrent()).toBeNull();
  });

  it('is a no-op when no session is active (idempotent)', async () => {
    const sessionManager = new SessionManager();
    const handler = new SignOutHandler({
      backend: fakeBackend({ kind: 'signed_out' }),
      sessionManager,
      jwtFor: () => null,
    });
    const res = await handler.signOut();
    expect(res).toEqual({ kind: 'signed_out' });
  });

  it('returns within 1 s even when backend never resolves (NFR-007)', async () => {
    const sessionManager = makeFilledManager();
    const stuckBackend: BackendClient = {
      signIn: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
      signOut: vi.fn(() => new Promise<BackendSignOutResponse>(() => undefined)), // never resolves
      listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
      confirmTakeover: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
      getStuckShifts: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    };
    const handler = new SignOutHandler({
      backend: stuckBackend,
      sessionManager,
      jwtFor: () => 'eyJ.fake.jwt',
    });
    const start = Date.now();
    const res = await handler.signOut();
    const elapsed = Date.now() - start;
    expect(res).toEqual({ kind: 'signed_out' });
    expect(elapsed).toBeLessThan(1000);
    expect(sessionManager.getCurrent()).toBeNull();
  });

  it('does not call backend when no JWT is held (best-effort)', async () => {
    const sessionManager = makeFilledManager();
    const calls: unknown[] = [];
    const handler = new SignOutHandler({
      backend: fakeBackend({ kind: 'signed_out' }, calls),
      sessionManager,
      jwtFor: () => null,
    });
    await handler.signOut();
    expect(calls).toEqual([]);
  });

  it('calls clearJwt with the ended backend session id (PR-1 — JWT no longer in main memory)', async () => {
    const sessionManager = makeFilledManager();
    const cleared: string[] = [];
    const handler = new SignOutHandler({
      backend: fakeBackend({ kind: 'signed_out' }),
      sessionManager,
      jwtFor: () => 'eyJ.fake.jwt',
      clearJwt: (sessionId) => cleared.push(sessionId),
    });
    await handler.signOut();
    expect(cleared).toEqual(['be-sess-1']);
  });

  it('sends the operator-identity JWT to backend.signOut, NOT the pos_operator envelope (016 review HIGH regression)', async () => {
    // POST /api/pos/v1/operators/sign-out uses the `operator-identity` scheme
    // (pos-operators.openapi.yaml) — the provider JWT, NOT the opaque sale-sync
    // envelope. After 016 split the credential seam, the sign-out binding
    // (`jwtFor`) MUST read the jwt holder. Sending the envelope would 401.
    const JWT = 'eyJhbGciOiJSUzI1NiJ9.identity.jwt';
    const ENVELOPE = 'opaque-pos-operator-envelope-signout-001';
    const sessionManager = makeFilledManager();
    const calls: Array<{ req: unknown; jwt: string }> = [];
    const handler = new SignOutHandler({
      backend: fakeBackend({ kind: 'signed_out' }, calls),
      sessionManager,
      // Production wires `jwtFor` to the JWT holder (operator-identity), never
      // the envelope holder.
      jwtFor: () => JWT,
    });
    await handler.signOut();
    // signOut is fire-and-forget; allow the microtask to land the backend call.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.jwt).toBe(JWT);
    expect(calls[0]?.jwt).not.toBe(ENVELOPE);
  });
});
