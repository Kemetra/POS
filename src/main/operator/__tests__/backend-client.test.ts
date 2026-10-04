import { describe, expect, it, vi } from 'vitest';

import { createBackendClient } from '../backend-client.js';
import { SignInHandler } from '../sign-in-handler.js';
import { SessionManager } from '../session-manager.js';
import { createJwtHolder } from '../jwt-holder.js';
import { ProtoSessionStore } from '../takeover-handler.js';

/**
 * 004-operator-session — production BackendClient request-shape tests.
 *
 * Load-bearing for Wave 1 path (b): the password and identifier MUST
 * NEVER appear in any backend request. The Clerk JWT travels in
 * `Authorization: Bearer …`. The body of `/sign-in` is exactly
 * `{ kind: 'manager_admin', device_token_attestation }`. The body of
 * `/sign-out` is exactly `{ session_id }`.
 *
 * Resolve-on-reachable / reject-only-on-transport contract: every
 * backend response (including 4xx/5xx) resolves to a typed result;
 * network failures resolve to `{ kind: 'no_connection' }`.
 */

const BASE = 'https://api.example.test';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    return Promise.resolve(response.clone());
  };
  return { fetchImpl, captured };
}

function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyAsString(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body === null || body === undefined) return '';
  // Tests only ever pass strings (URLSearchParams.toString() / JSON.stringify).
  throw new Error('test fixture: body was not a string');
}

const HAPPY_SIGN_IN_BODY = {
  kind: 'signed_in',
  operator: {
    id: 'clerk-user-1',
    // DP-2 033: provider-neutral users.id, distinct from the Clerk-subject `id`.
    user_id: '33333333-3333-7333-8333-333333333333',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: {
    id: 'be-sess-1',
    issued_at: '2026-05-06T00:00:00.000Z',
  },
};

describe('createBackendClient — sign-in request shape', () => {
  it('POSTs to /api/pos/v1/operators/sign-in with Authorization Bearer and the locked body', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_SIGN_IN_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.signIn(
      { kind: 'manager_admin', device_token_attestation: 'attest-123' },
      'eyJ.fake.jwt',
    );

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE}/api/pos/v1/operators/sign-in`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJ.fake.jwt');
    expect(headers['Content-Type']).toBe('application/json');
    // Body MUST be exactly { kind, device_token_attestation } — nothing else.
    const body = JSON.parse(bodyAsString(call?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ kind: 'manager_admin', device_token_attestation: 'attest-123' });
  });

  it('NEVER includes password / identifier / pin in the request body or headers', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_SIGN_IN_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.signIn({ kind: 'manager_admin', device_token_attestation: 'attest' }, 'jwt-1');
    const call = captured[0];
    const serialized = JSON.stringify({ headers: call?.init.headers, body: call?.init.body });
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('identifier');
    expect(serialized).not.toContain('pin');
  });

  it('strips trailing slash from baseUrl when constructing the URL', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_SIGN_IN_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: `${BASE}/`, fetch: fetchImpl });
    await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(captured[0]?.url).toBe(`${BASE}/api/pos/v1/operators/sign-in`);
  });

  it('parses signed_in response and surfaces operator + session', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_SIGN_IN_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.operator.id).toBe('clerk-user-1');
      // DP-2 033: the provider-neutral user_id is read through (distinct from `id`).
      expect(res.operator.user_id).toBe('33333333-3333-7333-8333-333333333333');
      expect(res.operator.role).toBe('manager');
      expect(res.operator_session.id).toBe('be-sess-1');
    }
  });

  it('surfaces takeover_required from the body', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ kind: 'takeover_required' }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('takeover_required');
  });

  it('collapses any 4xx/5xx to refused', async () => {
    for (const status of [400, 401, 403, 409, 422, 500]) {
      const { fetchImpl } = captureFetch(new Response('{}', { status }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.signIn(
        { kind: 'manager_admin', device_token_attestation: 'a' },
        'j',
      );
      expect(res.kind).toBe('refused');
    }
  });

  it('returns no_connection on network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('no_connection');
  });

  it('returns refused on malformed JSON body', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('refused');
  });

  it('returns refused on missing operator/operator_session/role-shape fields', async () => {
    const cases: unknown[] = [
      { kind: 'signed_in' },
      { kind: 'signed_in', operator: { id: 'x' } },
      {
        kind: 'signed_in',
        operator: { id: 'x', display_name: 'd', role: 'owner', tenant_id: 't', branch_id: 'b' },
        operator_session: { id: 's', issued_at: 'i' },
      },
      {
        kind: 'signed_in',
        operator: HAPPY_SIGN_IN_BODY.operator,
        operator_session: { id: 'x' },
      },
    ];
    for (const body of cases) {
      const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.signIn(
        { kind: 'manager_admin', device_token_attestation: 'a' },
        'j',
      );
      expect(res.kind).toBe('refused');
    }
  });
});

describe('016 C-1 — interpreter preserves the operator-authorization envelope (D5)', () => {
  // The interpreter hand-builds its return via an allowlist (operator +
  // operator_session only) and silently drops unknown fields. The D5 swap is a
  // no-op unless the interpreter explicitly reads the envelope. These tests pin
  // that preservation at the response boundary (both sign-in AND the
  // takeover-confirm path, which delegates to the same interpreter).
  //
  // AD-SALE-CAPTURE-2: DP-2 returns the envelope NESTED at
  // `operator_session.envelope` (canonical contract pos-operators.openapi.yaml
  // PosOperatorSessionSummary; a top-level `pos_operator_envelope` is
  // contract-illegal under additionalProperties:false). The interpreter reads
  // it from there and FLATTENS it onto its own top-level `pos_operator_envelope`
  // (POS's internal `BackendSignInSuccess` shape) — so the INPUT fixture is
  // nested (wire-true) while the OUTPUT assertion stays top-level (interpreted).
  const withEnvelope = (envelope: unknown): Record<string, unknown> => ({
    ...HAPPY_SIGN_IN_BODY,
    operator_session: {
      ...HAPPY_SIGN_IN_BODY.operator_session,
      envelope,
    },
  });

  it('carries a string pos_operator_envelope verbatim on signed_in', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(withEnvelope('opaque-envelope-xyz')), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.pos_operator_envelope).toBe('opaque-envelope-xyz');
    }
  });

  it('carries a null pos_operator_envelope (replayed sign-in) as null', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(withEnvelope(null)), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.pos_operator_envelope).toBeNull();
    }
  });

  it('treats an absent pos_operator_envelope as undefined/null (not a throw)', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_SIGN_IN_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signIn({ kind: 'manager_admin', device_token_attestation: 'a' }, 'j');
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.pos_operator_envelope ?? null).toBeNull();
    }
  });

  it('refuses a non-string/non-null pos_operator_envelope (allowlist posture)', async () => {
    for (const bad of [123, true, { not: 'a string' }, ['array']]) {
      const { fetchImpl } = captureFetch(
        new Response(JSON.stringify(withEnvelope(bad)), { status: 200 }),
      );
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.signIn(
        { kind: 'manager_admin', device_token_attestation: 'a' },
        'j',
      );
      expect(res.kind).toBe('refused');
    }
  });

  it('takeover-confirm inherits the same preservation (delegates to the sign-in interpreter)', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(withEnvelope('takeover-envelope-abc')), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.pos_operator_envelope).toBe('takeover-envelope-abc');
    }
  });
});

describe('AD-SALE-CAPTURE-2 — envelope survives wire→interpreter→handler→holder (FR-3 regression lock)', () => {
  // The bug that produced "0 POSTs all session": DP-2 returns the envelope nested
  // at `operator_session.envelope`, but the interpreter read a contract-illegal
  // top-level `pos_operator_envelope` → undefined → SignInHandler stored '' →
  // sale-sync FR-3 gate closed for every role. This test wires the REAL
  // createBackendClient (+ mocked fetch returning DP-2's real nested wire JSON)
  // through the REAL SignInHandler into a REAL envelopeHolder — i.e. the exact
  // seam that broke — and asserts the live operator credential lands in the
  // holder the sale-sync drain reads. A fake BackendClient would bypass the
  // interpreter and prove nothing, so we deliberately use the production client.
  it('a manager sign-in over the real nested wire lands the envelope in envelopeHolder (not "")', async () => {
    const WIRE_ENVELOPE = 'opaque-pos-operator-envelope-e2e';
    // DP-2's REAL response shape (nested envelope) — pos-operators.openapi.yaml.
    const wireBody = {
      ...HAPPY_SIGN_IN_BODY,
      operator_session: {
        ...HAPPY_SIGN_IN_BODY.operator_session,
        envelope: WIRE_ENVELOPE,
      },
    };
    const { fetchImpl } = captureFetch(new Response(JSON.stringify(wireBody), { status: 200 }));
    const backend = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });

    const sessionManager = new SessionManager();
    const jwtHolder = createJwtHolder();
    const envelopeHolder = createJwtHolder();
    const handler = new SignInHandler({
      clerk: {
        exchange: vi.fn(() =>
          Promise.resolve({
            kind: 'ok' as const,
            jwt: 'eyJ.fake.jwt',
            operator_id: 'clerk-user-1',
            display_name: 'Manager One',
            role: 'manager' as const,
          }),
        ),
      },
      backend,
      sessionManager,
      jwtHolder,
      envelopeHolder,
      protoStore: new ProtoSessionStore(),
      deviceTokenAttestation: () => 'attest-123',
    });

    const res = await handler.signIn({
      kind: 'manager_admin',
      identifier: 'm@x.test',
      password: 'p',
    });

    expect(res.kind).toBe('signed_in');
    // The sale-sync drain reads envelopeHolder.get(backend_session_id); it MUST
    // hold the live envelope, not the '' absent-sentinel that closed the gate.
    expect(envelopeHolder.get('be-sess-1')).toBe(WIRE_ENVELOPE);
    expect(envelopeHolder.get('be-sess-1')).not.toBe('');
  });
});

describe('createBackendClient — sign-out request shape', () => {
  it('POSTs to /api/pos/v1/operators/sign-out with Authorization Bearer and the locked body', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify({ kind: 'signed_out' }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.signOut({ session_id: 'be-sess-1' }, 'eyJ.fake.jwt');

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE}/api/pos/v1/operators/sign-out`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJ.fake.jwt');
    const body = JSON.parse(bodyAsString(call?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ session_id: 'be-sess-1' });
  });

  it('returns signed_out on 2xx (idempotent — body shape ignored)', async () => {
    const { fetchImpl } = captureFetch(new Response('{}', { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signOut({ session_id: 's' }, 'j');
    expect(res).toEqual({ kind: 'signed_out' });
  });

  it('collapses 4xx/5xx to refused', async () => {
    const { fetchImpl } = captureFetch(new Response('{}', { status: 401 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signOut({ session_id: 's' }, 'j');
    expect(res).toEqual({ kind: 'refused' });
  });

  it('returns no_connection on network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ETIMEDOUT')));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.signOut({ session_id: 's' }, 'j');
    expect(res).toEqual({ kind: 'no_connection' });
  });
});

describe('createBackendClient — roster request shape', () => {
  const HAPPY_ROSTER_BODY = {
    kind: 'roster',
    cashiers: [
      { id: 'c-1', display_name: 'Cashier One', role: 'cashier' },
      { id: 'c-2', display_name: 'Cashier Two', role: 'cashier' },
    ],
  };

  it('GETs /api/pos/v1/operators/roster with branch_id query param', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.listRoster('branch-abc');

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE}/api/pos/v1/operators/roster?branch_id=branch-abc`);
    expect(call?.init.method).toBe('GET');
  });

  it('encodes special characters in branch_id', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.listRoster('branch/with spaces&special');
    expect(captured[0]?.url).toContain(encodeURIComponent('branch/with spaces&special'));
  });

  it('NEVER includes an Authorization header (no JWT on roster path)', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.listRoster('b1');
    const headers = captured[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
    expect(headers?.['authorization']).toBeUndefined();
  });

  it('NEVER includes pin / password in the request', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.listRoster('b1');
    const serialized = JSON.stringify({
      url: captured[0]?.url,
      headers: captured[0]?.init.headers,
    });
    expect(serialized).not.toContain('pin');
    expect(serialized).not.toContain('password');
  });

  it('parses roster response and surfaces cashiers array', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('roster');
    if (res.kind === 'roster') {
      expect(res.cashiers).toHaveLength(2);
      expect(res.cashiers[0]).toEqual({ id: 'c-1', display_name: 'Cashier One', role: 'cashier' });
    }
  });

  it('strips extra fields from each cashier entry (allowlist defence-in-depth)', async () => {
    const body = {
      kind: 'roster',
      cashiers: [
        {
          id: 'c-1',
          display_name: 'Cashier One',
          role: 'cashier',
          email: 'secret@example.com',
          phone: '+1234567890',
          password_hash: 'should-not-appear',
        },
      ],
    };
    const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('roster');
    if (res.kind === 'roster') {
      const cashier = res.cashiers[0];
      expect(cashier).toEqual({ id: 'c-1', display_name: 'Cashier One', role: 'cashier' });
      expect(JSON.stringify(cashier)).not.toContain('email');
      expect(JSON.stringify(cashier)).not.toContain('password_hash');
    }
  });

  // ─── 019 T020 — roster allowlist threads the held DP-2 `user_id` field ───────

  it('019 T020: threads the provider-neutral user_id through when the backend supplies it', async () => {
    const body = {
      kind: 'roster',
      cashiers: [
        {
          id: 'c-1',
          user_id: 'neutral-uuid-123', // DP-2 held field (028 §16)
          display_name: 'Cashier One',
          role: 'cashier',
          email: 'secret@example.com', // still stripped (not allowlisted)
        },
      ],
    };
    const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('roster');
    if (res.kind === 'roster') {
      const cashier = res.cashiers[0];
      expect(cashier).toEqual({
        id: 'c-1',
        user_id: 'neutral-uuid-123',
        display_name: 'Cashier One',
        role: 'cashier',
      });
      // Secrets are NOT allowlisted even alongside user_id.
      expect(JSON.stringify(cashier)).not.toContain('email');
    }
  });

  it('019 T020: roster path still succeeds when user_id is absent (optional on wire, pre-DP-2)', async () => {
    // HAPPY_ROSTER_BODY carries NO user_id — the path must not break or invent one.
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_ROSTER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('roster');
    if (res.kind === 'roster') {
      const cashier = res.cashiers[0];
      expect(cashier).toEqual({ id: 'c-1', display_name: 'Cashier One', role: 'cashier' });
      expect(cashier).not.toHaveProperty('user_id');
    }
  });

  it('returns refused when any cashier entry has a non-cashier role', async () => {
    const body = {
      kind: 'roster',
      cashiers: [{ id: 'm-1', display_name: 'Manager', role: 'manager' }],
    };
    const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('refused');
  });

  it('accepts an empty cashiers array', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ kind: 'roster', cashiers: [] }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res).toEqual({ kind: 'roster', cashiers: [] });
  });

  it('collapses 4xx/5xx to refused', async () => {
    for (const status of [400, 401, 403, 500]) {
      const { fetchImpl } = captureFetch(new Response('{}', { status }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.listRoster('b1');
      expect(res.kind).toBe('refused');
    }
  });

  it('returns no_connection on network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('no_connection');
  });

  it('returns refused on malformed JSON body', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.listRoster('b1');
    expect(res.kind).toBe('refused');
  });
});

describe('createBackendClient — takeover-confirm request shape', () => {
  const HAPPY_TAKEOVER_BODY = {
    kind: 'signed_in',
    operator: {
      id: 'clerk-user-2',
      // DP-2 033: provider-neutral user_id, present on the takeover-confirm
      // signed_in response too (it reuses interpretSignInResponse).
      user_id: '44444444-4444-7444-8444-444444444444',
      display_name: 'Manager Two',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
    },
    operator_session: {
      id: 'be-sess-2',
      issued_at: '2026-05-08T00:00:00.000Z',
    },
  };

  it('POSTs to /api/pos/v1/operators/takeover/confirm with Authorization Bearer and exact body', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_TAKEOVER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.confirmTakeover(
      {
        event_id: 'uuid-v4-123',
        operator_id: 'clerk-user-2',
        device_token_attestation: 'attest-456',
      },
      'eyJ.takeover.jwt',
    );

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE}/api/pos/v1/operators/takeover/confirm`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJ.takeover.jwt');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(bodyAsString(call?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      event_id: 'uuid-v4-123',
      operator_id: 'clerk-user-2',
      device_token_attestation: 'attest-456',
    });
  });

  it('NEVER includes pin / password in the request body or headers', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_TAKEOVER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    const serialized = JSON.stringify({
      headers: captured[0]?.init.headers,
      body: captured[0]?.init.body,
    });
    expect(serialized).not.toContain('pin');
    expect(serialized).not.toContain('password');
  });

  it('parses signed_in response and surfaces operator + session', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_TAKEOVER_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    expect(res.kind).toBe('signed_in');
    if (res.kind === 'signed_in') {
      expect(res.operator.id).toBe('clerk-user-2');
      expect(res.operator_session.id).toBe('be-sess-2');
    }
  });

  it('maps takeover_required from backend to refused (not a valid confirm outcome)', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ kind: 'takeover_required' }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    expect(res.kind).toBe('refused');
  });

  it('collapses 4xx/5xx to refused', async () => {
    for (const status of [400, 401, 403, 409, 500]) {
      const { fetchImpl } = captureFetch(new Response('{}', { status }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.confirmTakeover(
        { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
        'jwt-1',
      );
      expect(res.kind).toBe('refused');
    }
  });

  it('returns no_connection on network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    expect(res.kind).toBe('no_connection');
  });

  it('returns refused on malformed JSON body', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.confirmTakeover(
      { event_id: 'e1', operator_id: 'op1', device_token_attestation: 'a' },
      'jwt-1',
    );
    expect(res.kind).toBe('refused');
  });
});

describe('createBackendClient — getStuckShifts request shape (Wave 4.1 Endpoint 7)', () => {
  const HAPPY_STUCK_BODY = {
    kind: 'ok',
    shifts: [
      {
        shift_id: 'shift-uuid-1',
        cashier_display_name: 'Cashier One',
        terminal_label: 'Terminal A',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 42,
      },
    ],
  };

  it('GETs /api/pos/v1/shifts/stuck with branch_id query param and Authorization Bearer', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_STUCK_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.getStuckShifts('branch-xyz', 'eyJ.manager.jwt');

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE}/api/pos/v1/shifts/stuck?branch_id=branch-xyz`);
    expect(call?.init.method).toBe('GET');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer eyJ.manager.jwt');
  });

  it('encodes special characters in branch_id', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_STUCK_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.getStuckShifts('branch/with spaces&special', 'jwt');
    expect(captured[0]?.url).toContain(encodeURIComponent('branch/with spaces&special'));
  });

  it('NEVER includes pin / password in the request (AD-2 — cashier path must not reach this endpoint)', async () => {
    const { fetchImpl, captured } = captureFetch(
      new Response(JSON.stringify(HAPPY_STUCK_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    await client.getStuckShifts('b1', 'jwt');
    const serialized = JSON.stringify({
      url: captured[0]?.url,
      headers: captured[0]?.init.headers,
    });
    expect(serialized).not.toContain('pin');
    expect(serialized).not.toContain('password');
  });

  it('parses ok response and surfaces shifts array', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify(HAPPY_STUCK_BODY), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.shifts).toHaveLength(1);
      expect(res.shifts[0]).toEqual({
        shift_id: 'shift-uuid-1',
        cashier_display_name: 'Cashier One',
        terminal_label: 'Terminal A',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 42,
      });
    }
  });

  it('accepts an empty shifts array (no stuck shifts on branch)', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ kind: 'ok', shifts: [] }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res).toEqual({ kind: 'ok', shifts: [] });
  });

  it('strips extra fields from each shift entry (allowlist — FR-032)', async () => {
    const body = {
      kind: 'ok',
      shifts: [
        {
          shift_id: 'shift-1',
          cashier_display_name: 'Cashier',
          terminal_label: 'Term A',
          opened_at: '2026-05-12T08:00:00.000Z',
          duration_minutes: 10,
          clerk_user_id: 'should-not-surface',
          email: 'secret@example.com',
        },
      ],
    };
    const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      const shift = res.shifts[0];
      expect(shift).toEqual({
        shift_id: 'shift-1',
        cashier_display_name: 'Cashier',
        terminal_label: 'Term A',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 10,
      });
      expect(JSON.stringify(shift)).not.toContain('clerk_user_id');
      expect(JSON.stringify(shift)).not.toContain('email');
    }
  });

  it('returns refused when a shift entry is missing a required field', async () => {
    const cases = [
      {
        kind: 'ok',
        shifts: [
          { cashier_display_name: 'C', terminal_label: 'T', opened_at: 'ts', duration_minutes: 5 },
        ],
      },
      {
        kind: 'ok',
        shifts: [{ shift_id: 's', terminal_label: 'T', opened_at: 'ts', duration_minutes: 5 }],
      },
      {
        kind: 'ok',
        shifts: [
          { shift_id: 's', cashier_display_name: 'C', opened_at: 'ts', duration_minutes: 5 },
        ],
      },
      {
        kind: 'ok',
        shifts: [
          { shift_id: 's', cashier_display_name: 'C', terminal_label: 'T', duration_minutes: 5 },
        ],
      },
      {
        kind: 'ok',
        shifts: [
          { shift_id: 's', cashier_display_name: 'C', terminal_label: 'T', opened_at: 'ts' },
        ],
      },
    ];
    for (const body of cases) {
      const { fetchImpl } = captureFetch(new Response(JSON.stringify(body), { status: 200 }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.getStuckShifts('b1', 'jwt');
      expect(res.kind).toBe('refused');
    }
  });

  it('returns refused when kind is not ok', async () => {
    const { fetchImpl } = captureFetch(
      new Response(JSON.stringify({ kind: 'error', message: 'something failed' }), { status: 200 }),
    );
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res.kind).toBe('refused');
  });

  it('collapses 4xx/5xx to refused', async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      const { fetchImpl } = captureFetch(new Response('{}', { status }));
      const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
      const res = await client.getStuckShifts('b1', 'jwt');
      expect(res.kind).toBe('refused');
    }
  });

  it('returns no_connection on network failure', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res.kind).toBe('no_connection');
  });

  it('returns refused on malformed JSON body', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const client = createBackendClient({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.getStuckShifts('b1', 'jwt');
    expect(res.kind).toBe('refused');
  });
});
