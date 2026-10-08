import { describe, expect, it, vi } from 'vitest';

import { SignInHandler } from '../sign-in-handler.js';
import { SessionManager } from '../session-manager.js';
import { createJwtHolder } from '../jwt-holder.js';
import {
  createClerkExchanger,
  type ClerkExchanger,
  type ClerkExchangeRequest,
  type ClerkExchangeResult,
} from '../clerk-client.js';
import type { BackendClient, BackendSignInResponse } from '../backend-client.js';
import { ProtoSessionStore } from '../takeover-handler.js';

/**
 * 004-operator-session T026 + T023 + T025 — sign-in handler, manager/admin path.
 *
 * Verifies:
 *  - Wave 1 path (b): password is consumed by the Clerk exchanger and
 *    NEVER reaches the backend client (AD-2 — backend body has no
 *    `password` / `identifier`; Authorization carries the JWT).
 *  - Generic refusal posture: every factor-distinguishable failure
 *    becomes `{ kind: 'refused', category: 'invalid_input' }` except
 *    network unreachability (`no_connection`).
 *  - Successful sign-in creates a SessionManager record and surfaces
 *    only the bridge view to the renderer.
 *  - Cashier-role identities returned by the backend are refused
 *    locally (defence in depth — backend already refuses them on this
 *    endpoint).
 *  - PR-1 redaction: password / identifier / JWT do NOT appear in any
 *    log line (we capture all logger calls and assert no field
 *    contains the secret values).
 */

function fakeClerk(result: ClerkExchangeResult, calls: unknown[] = []): ClerkExchanger {
  return {
    exchange: vi.fn((req) => {
      calls.push(req);
      return Promise.resolve(result);
    }),
  };
}

function fakeBackend(
  signInResult: BackendSignInResponse,
  capture: { lastBody?: unknown; lastJwt?: string } = {},
): BackendClient {
  const signIn: BackendClient['signIn'] = (body, jwt) => {
    capture.lastBody = body;
    capture.lastJwt = jwt;
    return Promise.resolve(signInResult);
  };
  const signOut: BackendClient['signOut'] = () => Promise.resolve({ kind: 'signed_out' as const });
  return {
    signIn: vi.fn(signIn),
    signOut: vi.fn(signOut),
    listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    confirmTakeover: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    getStuckShifts: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
  };
}

/** 016 (D5): the opaque pos_operator envelope DP-2 #559 returns on sign-in. */
const ENVELOPE = 'opaque-pos-operator-envelope-001';

const SUCCESS_BACKEND_RESPONSE: BackendSignInResponse = {
  kind: 'signed_in',
  operator: {
    id: 'clerk-user-1',
    user_id: '33333333-3333-7333-8333-333333333333', // DP-2 033 provider-neutral users.id
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: {
    id: 'be-sess-1',
    issued_at: '2026-05-06T00:00:00.000Z',
  },
  pos_operator_envelope: ENVELOPE,
};

const HAPPY_JWT = 'eyJhbGciOiJSUzI1NiJ9.fake.jwt';
const HAPPY_CLERK_RESULT: ClerkExchangeResult = {
  kind: 'ok',
  jwt: HAPPY_JWT,
  operator_id: 'clerk-user-1',
  display_name: 'Manager One',
  role: 'manager',
};

describe('SignInHandler — manager/admin path', () => {
  it('happy path: returns signed_in with bridge view', async () => {
    const sessionManager = new SessionManager();
    const clerk = fakeClerk(HAPPY_CLERK_RESULT);
    const captured: { lastBody?: unknown; lastJwt?: string } = {};
    const backend = fakeBackend(SUCCESS_BACKEND_RESPONSE, captured);

    const handler = new SignInHandler({
      clerk,
      backend,
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest-123',
    });

    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'manager@pharmacy.test',
      password: 'correct-horse-battery-staple',
    });

    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.session.role).toBe('manager');
      expect(res.session.operator_id).toBe('clerk-user-1');
      expect(res.session).not.toHaveProperty('backend_session_id');
    }
    expect(sessionManager.getCurrent()?.operator_id).toBe('clerk-user-1');
    // RT-17 slice 4 part 2: the manager's users.id is kept main-side, for the
    // local manager PIN enrolment, and never reaches the renderer.
    expect(sessionManager.getCurrent()?.manager_user_id).toBe(
      '33333333-3333-7333-8333-333333333333',
    );
    expect(JSON.stringify(res)).not.toContain('33333333-3333-7333-8333-333333333333');
  });

  it('splits the credential seam: JWT in jwtHolder (operator-identity routes) AND envelope in envelopeHolder (sale-sync) — 016 review HIGH', async () => {
    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const envelopeHolder = createJwtHolder();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend(SUCCESS_BACKEND_RESPONSE),
      sessionManager,
      jwtHolder,
      envelopeHolder,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    await handler.signIn({
      kind: 'manager_admin',
      identifier: 'm@x.test',
      password: 'p',
    });
    // 016 (review HIGH): DP-2 splits POS auth into TWO schemes. The provider
    // JWT (operator-identity) is identity proof at sign-in AND subsequent
    // operator-identity calls (sign-out, stuck-shifts) — 028 §6 CM-1. The
    // opaque pos_operator ENVELOPE (#559) authorizes ONLY the sale-sync routes
    // (captureSale / recordVoid / recordRefund). Both held in main-process
    // memory only — NEVER cross the bridge to the renderer.
    //
    // jwtHolder MUST keep the JWT (so sign-out / stuck-shifts keep working).
    expect(jwtHolder.get('be-sess-1')).toBe(HAPPY_JWT);
    expect(jwtHolder.get('be-sess-1')).not.toBe(ENVELOPE);
    // envelopeHolder MUST hold the ENVELOPE (so the sale-sync POST is authorized).
    expect(envelopeHolder.get('be-sess-1')).toBe(ENVELOPE);
    expect(envelopeHolder.get('be-sess-1')).not.toBe(HAPPY_JWT);
  });

  it('normalizes an absent envelope to "" in envelopeHolder while jwtHolder keeps the JWT (M-1 gate sees absent)', async () => {
    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const envelopeHolder = createJwtHolder();
    // Legacy / older backend: no pos_operator_envelope in the success body.
    const { pos_operator_envelope: _drop, ...legacy } = SUCCESS_BACKEND_RESPONSE;
    void _drop;
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend(legacy),
      sessionManager,
      jwtHolder,
      envelopeHolder,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    await handler.signIn({ kind: 'manager_admin', identifier: 'm@x.test', password: 'p' });
    // M-1: '' is the absent sentinel the sale-sync envelope-present gate treats
    // as ABSENT (pauses the drain). The JWT still works for operator-identity.
    expect(envelopeHolder.get('be-sess-1')).toBe('');
    expect(jwtHolder.get('be-sess-1')).toBe(HAPPY_JWT);
  });

  it('does NOT record the JWT on takeover_required (no local session created)', async () => {
    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend({ kind: 'takeover_required' }),
      sessionManager,
      jwtHolder,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    await handler.signIn({
      kind: 'manager_admin',
      identifier: 'm@x.test',
      password: 'p',
    });
    // No backend session id was returned; nothing to key the JWT
    // against. The jwtHolder remains empty.
    expect(jwtHolder.get('be-sess-1')).toBeNull();
  });

  it('Wave 1 path (b): password NEVER appears in the backend body', async () => {
    const sessionManager = new SessionManager();
    const clerk = fakeClerk(HAPPY_CLERK_RESULT);
    const captured: { lastBody?: unknown; lastJwt?: string } = {};
    const backend = fakeBackend(SUCCESS_BACKEND_RESPONSE, captured);

    const handler = new SignInHandler({
      clerk,
      backend,
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest-123',
    });

    await handler.signIn({
      kind: 'manager_admin',
      identifier: 'm@x.test',
      password: 'never-leaks',
    });

    // The body MUST contain only `kind` and `device_token_attestation`.
    expect(captured.lastBody).toEqual({
      kind: 'manager_admin',
      device_token_attestation: 'attest-123',
    });
    // The JWT travels in Authorization (Bearer), not in the body.
    expect(captured.lastJwt).toBe(HAPPY_JWT);
    // Defence in depth: serialize the body and assert the password
    // string does not appear anywhere in it.
    const bodyJson = JSON.stringify(captured.lastBody);
    expect(bodyJson).not.toContain('never-leaks');
    expect(bodyJson).not.toContain('m@x.test');
    expect(bodyJson).not.toContain('password');
    expect(bodyJson).not.toContain('identifier');
  });

  it('refuses generically on empty identifier or password', async () => {
    const sessionManager = new SessionManager();
    const clerk = fakeClerk(HAPPY_CLERK_RESULT);
    const backend = fakeBackend(SUCCESS_BACKEND_RESPONSE);
    const handler = new SignInHandler({
      clerk,
      backend,
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });

    for (const bad of [
      { identifier: '', password: 'p' },
      { identifier: 'i', password: '' },
    ]) {
      const res = await handler.signIn({ kind: 'manager_admin', ...bad });
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
    expect(sessionManager.getCurrent()).toBeNull();
  });

  it('refuses generically when Clerk refuses', async () => {
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk({ kind: 'refused' }),
      backend: fakeBackend(SUCCESS_BACKEND_RESPONSE),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns no_connection when Clerk is unreachable', async () => {
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk({ kind: 'no_connection' }),
      backend: fakeBackend(SUCCESS_BACKEND_RESPONSE),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it('returns no_connection when backend is unreachable', async () => {
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend({ kind: 'no_connection' }),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it('refuses generically when backend rejects (any cause)', async () => {
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend({ kind: 'refused' }),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('surfaces takeover_required with capability token, no identifying detail (FR-013)', async () => {
    const sessionManager = new SessionManager();
    const protoStore = new ProtoSessionStore();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend({ kind: 'takeover_required' }),
      sessionManager,
      protoStore,
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res.kind).toBe('takeover_required');
    if (res.kind !== 'takeover_required') return;
    // pending_takeover_id is an opaque token; verify shape only.
    expect(typeof res.pending_takeover_id).toBe('string');
    expect(res.pending_takeover_id.length).toBeGreaterThan(0);
    // FR-013: no operator identity, no prior-terminal id in the response.
    expect(res).not.toHaveProperty('operator_id');
    expect(res).not.toHaveProperty('tenant_id');
    // No new session was created; the prompt UX (S4) must run before confirmation.
    expect(sessionManager.getCurrent()).toBeNull();
  });

  it('refuses generically when backend returns cashier role (defence in depth)', async () => {
    // The backend already refuses cashier-role identities on this
    // endpoint, but local defence in depth keeps the trust boundary
    // explicit.
    const cashierBackend: BackendSignInResponse = {
      ...SUCCESS_BACKEND_RESPONSE,
      operator: { ...SUCCESS_BACKEND_RESPONSE.operator, role: 'cashier' },
    };
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend(cashierBackend),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(sessionManager.getCurrent()).toBeNull();
  });

  it('PR-1 redaction: logger never receives the password / identifier / JWT', async () => {
    const calls: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => calls.push(...args),
      warn: (...args: unknown[]) => calls.push(...args),
      error: (...args: unknown[]) => calls.push(...args),
      debug: (...args: unknown[]) => calls.push(...args),
      trace: (...args: unknown[]) => calls.push(...args),
      fatal: (...args: unknown[]) => calls.push(...args),
      child: () =>
        ({
          info: () => undefined,
          warn: () => undefined,
        }) as unknown,
    } as unknown as NonNullable<ConstructorParameters<typeof SignInHandler>[0]['logger']>;
    const sessionManager = new SessionManager();
    const handler = new SignInHandler({
      clerk: fakeClerk(HAPPY_CLERK_RESULT),
      backend: fakeBackend(SUCCESS_BACKEND_RESPONSE),
      sessionManager,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
      logger,
    });
    await handler.signIn({
      kind: 'manager_admin',
      identifier: 'leaky@example.com',
      password: 'this-must-not-appear',
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('this-must-not-appear');
    expect(serialized).not.toContain('leaky@example.com');
    expect(serialized).not.toContain('eyJhbGciOiJSUzI1NiJ9.fake.jwt');
  });
});

/**
 * RT-42 — the manager/admin identifier is trimmed in the main-process sign-in
 * path before the Clerk exchange; the password is passed through byte-for-byte.
 */
describe('SignInHandler — RT-42 identifier trimming', () => {
  function handlerWith(clerk: ClerkExchanger): SignInHandler {
    return new SignInHandler({
      clerk,
      backend: fakeBackend(SUCCESS_BACKEND_RESPONSE),
      sessionManager: new SessionManager(),
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest',
    });
  }

  it.each([
    ['trailing space', 'manager@pharmacy.test '],
    ['leading space', ' manager@pharmacy.test'],
    ['both sides, mixed whitespace', ' \t manager@pharmacy.test \n '],
  ])('sends the trimmed identifier to Clerk (%s) and signs in', async (_label, raw) => {
    const calls: ClerkExchangeRequest[] = [];
    const handler = handlerWith(fakeClerk(HAPPY_CLERK_RESULT, calls));

    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: raw,
      password: 'correct-horse-battery-staple',
    });

    expect(res.kind).toBe('signed_in');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.identifier).toBe('manager@pharmacy.test');
  });

  it('never trims or transforms the password (surrounding spaces preserved)', async () => {
    const calls: ClerkExchangeRequest[] = [];
    const handler = handlerWith(fakeClerk(HAPPY_CLERK_RESULT, calls));
    const password = '  p@ss word\t ';

    await handler.signIn({
      kind: 'manager_admin',
      identifier: ' manager@pharmacy.test ',
      password,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.password).toBe(password);
    expect(calls[0]?.password).toHaveLength(password.length);
  });

  it('a whitespace-only password is passed through unchanged (not treated as empty)', async () => {
    const calls: ClerkExchangeRequest[] = [];
    const handler = handlerWith(fakeClerk(HAPPY_CLERK_RESULT, calls));

    await handler.signIn({ kind: 'manager_admin', identifier: 'm@x.test', password: '   ' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.password).toBe('   ');
  });

  it('a whitespace-only identifier is refused generically without calling Clerk', async () => {
    const calls: ClerkExchangeRequest[] = [];
    const handler = handlerWith(fakeClerk(HAPPY_CLERK_RESULT, calls));

    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: ' \t ',
      password: 'p',
    });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('wire level: the real Clerk exchanger posts the trimmed identifier and the exact password', async () => {
    const bodies: string[] = [];
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      // Refuse the attempt — only the outbound sign_ins body matters here.
      return Promise.resolve(new Response('{}', { status: 422 }));
    };
    const clerk = createClerkExchanger({
      fetch: fetchImpl,
      frontendApiBaseUrl: 'https://clerk.example.com',
    });
    const password = ' secret with spaces ';

    const res = await handlerWith(clerk).signIn({
      kind: 'manager_admin',
      identifier: '  manager@pharmacy.test ',
      password,
    });

    // Clerk refusal disclosure is unchanged: still the single generic category.
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(bodies).toHaveLength(1);
    const form = new URLSearchParams(bodies[0]);
    expect(form.get('identifier')).toBe('manager@pharmacy.test');
    expect(form.get('password')).toBe(password);
  });
});
