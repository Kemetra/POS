import { describe, expect, it, vi } from 'vitest';

import {
  createCashierAdmissionClient,
  type CashierAdmissionClient,
} from '../../../../src/main/operator/cashier-admission-client.js';

import { cashierAdmissionsContract, contractErrors } from './__helpers__/openapi-schema.js';

/**
 * RT-113 P2 — the device-authenticated cashier-admissions client
 * (Backend-Core contract `pos-cashier-admissions.openapi.yaml`, BC1 #696 /
 * BC2 #697). Every call carries the paired terminal's device token as
 * `Authorization: Bearer <device_token>` and nothing else; request bodies and
 * the fixtures below are validated against the pinned contract.
 */

const BASE = 'https://api.example.test';
const DEVICE_TOKEN = 'device-token-SECRET-abc123';
const USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const KEY = 'pos-cashier-adm-1f0e3c1e-61a4-4c84-a3b1-9d0b2c7c8e11';

const ADMITTED = {
  kind: 'admitted',
  admission_id: ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: 43_200,
  server_time: '2026-10-04T10:00:00.000Z',
  display_name: 'Mona',
} as const;

interface Recorded {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorBody(code: string): unknown {
  return { error: { code, message: 'generic', request_id: 'req-1' } };
}

function makeClient(
  respond: (url: string) => Response | Promise<Response>,
  opts: { token?: string | null; tokenThrows?: boolean } = {},
): { client: CashierAdmissionClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url));
  });
  const client = createCashierAdmissionClient({
    baseUrl: `${BASE}/`,
    fetch: fetchImpl,
    getDeviceToken: () => {
      if (opts.tokenThrows === true) throw new Error('secret store unavailable');
      return Promise.resolve(opts.token === undefined ? DEVICE_TOKEN : opts.token);
    },
  });
  return { client, calls };
}

/** Header names lower-cased (happy-dom's `Headers` keeps the original case). */
function headersOf(rec: Recorded): Record<string, string> {
  return Object.fromEntries(
    Object.entries((rec.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
}

const ONLINE_REQ = {
  mode: 'online' as const,
  user_id: USER_ID,
  takeover: false,
  idempotency_key: KEY,
};

describe('contract fixtures', () => {
  it('validates against the vendored Backend-Core contract of record (1.0.0-draft)', () => {
    expect(cashierAdmissionsContract.info.version).toBe('1.0.0-draft');
    expect(Object.keys(cashierAdmissionsContract.paths).sort()).toEqual([
      '/api/pos/v1/cashier-admissions',
      '/api/pos/v1/cashier-admissions/roster',
      '/api/pos/v1/cashier-admissions/{admission_id}/end',
    ]);
  });

  it('the fixtures used here are valid against the pinned contract', () => {
    expect(contractErrors('PosCashierAdmissionResponse', ADMITTED)).toEqual([]);
    expect(contractErrors('PosCashierAdmissionResponse', { kind: 'active_elsewhere' })).toEqual([]);
    expect(contractErrors('RefusedError', errorBody('refused'))).toEqual([]);
    expect(contractErrors('PosCashierAdmissionEnded', { kind: 'ended' })).toEqual([]);
    expect(contractErrors('PosCashierAdmissionOnlineRequest', ONLINE_REQ)).toEqual([]);
  });
});

describe('admit — request', () => {
  it('POSTs the online body to /api/pos/v1/cashier-admissions with the device bearer only', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, ADMITTED));
    await client.admit(ONLINE_REQ);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${BASE}/api/pos/v1/cashier-admissions`);
    expect(call?.init.method).toBe('POST');
    const headers = headersOf(call ?? { url: '', init: {} });
    expect(headers['authorization']).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type']);
    const body = JSON.parse(call?.init.body as string) as unknown;
    expect(body).toEqual(ONLINE_REQ);
    expect(contractErrors('PosCashierAdmissionRequest', body)).toEqual([]);
    // The device token never travels in the body.
    expect(call?.init.body as string).not.toContain(DEVICE_TOKEN);
  });

  it('review F8: sends nothing and answers no_token (not device_unauthorized) when no device token is held', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, ADMITTED), { token: null });
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'no_token' });
    expect(calls).toHaveLength(0);
  });
});

describe('admit — outcome mapping', () => {
  it('200 admitted → admitted, allowlisted fields only', async () => {
    const { client } = makeClient(() => jsonResponse(200, { ...ADMITTED, extra: 'x' }));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual(ADMITTED);
  });

  it('200 active_elsewhere → active_elsewhere', async () => {
    const { client } = makeClient(() => jsonResponse(200, { kind: 'active_elsewhere' }));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'active_elsewhere' });
  });

  it.each([
    [403, errorBody('refused'), 'refused'],
    [401, errorBody('unauthorized'), 'device_unauthorized'],
    [409, errorBody('idempotency_key_conflict'), 'idempotency_conflict'],
    [429, errorBody('rate_limited'), 'rate_limited'],
    [400, errorBody('validation_error'), 'rejected'],
    [404, errorBody('not_found'), 'rejected'],
    [500, errorBody('internal'), 'unavailable'],
    [503, 'not json', 'unavailable'],
  ])('HTTP %i → %s', async (status, body, kind) => {
    const { client } = makeClient(() => jsonResponse(status, body));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind });
  });

  it('a transport failure → no_connection', async () => {
    const { client } = makeClient(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'no_connection' });
  });

  it.each([
    ['unknown kind', { kind: 'granted' }],
    ['missing ttl', { ...ADMITTED, admission_ttl_seconds: undefined }],
    ['ttl below 1', { ...ADMITTED, admission_ttl_seconds: 0 }],
    ['fractional ttl', { ...ADMITTED, admission_ttl_seconds: 1.5 }],
    ['negative grace', { ...ADMITTED, offline_grace_seconds: -1 }],
    ['empty admission id', { ...ADMITTED, admission_id: '' }],
    ['non-uuid admission id (review F9)', { ...ADMITTED, admission_id: 'not-a-uuid' }],
    ['non-string display name', { ...ADMITTED, display_name: 7 }],
    ['non-string server time', { ...ADMITTED, server_time: null }],
    ['array body', [ADMITTED]],
  ])('a malformed 200 (%s) → rejected', async (_label, body) => {
    const { client } = makeClient(() => jsonResponse(200, body));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'rejected' });
  });

  it('a 200 that is not JSON → rejected', async () => {
    const { client } = makeClient(() => new Response('<html>', { status: 200 }));
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'rejected' });
  });
});

describe('end', () => {
  it('POSTs to …/{admission_id}/end with the device bearer and no body', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { kind: 'ended' }));
    await expect(client.end(ADMISSION_ID)).resolves.toEqual({ kind: 'ended' });
    expect(calls[0]?.url).toBe(`${BASE}/api/pos/v1/cashier-admissions/${ADMISSION_ID}/end`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(headersOf(calls[0] ?? { url: '', init: {} })).toEqual({
      authorization: `Bearer ${DEVICE_TOKEN}`,
    });
  });

  it('encodes the admission id into the path', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { kind: 'ended' }));
    await client.end('a/b?c');
    expect(calls[0]?.url).toBe(`${BASE}/api/pos/v1/cashier-admissions/a%2Fb%3Fc/end`);
  });

  it.each([
    [401, 'device_unauthorized'],
    // RT-220: any other 4xx is a definite refusal of the request.
    [400, 'rejected'],
    [404, 'rejected'],
    [408, 'rejected'],
    [409, 'rejected'],
    [429, 'rejected'],
    // RT-220: a 5xx says nothing about whether the server applied the `end`.
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
  ])('HTTP %i → %s', async (status, kind) => {
    const { client } = makeClient(() => jsonResponse(status, errorBody('x')));
    await expect(client.end(ADMISSION_ID)).resolves.toEqual({ kind });
  });

  it('a transport failure → no_connection; no token → no_token', async () => {
    const down = makeClient(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(down.client.end(ADMISSION_ID)).resolves.toEqual({ kind: 'no_connection' });
    const noToken = makeClient(() => jsonResponse(200, { kind: 'ended' }), { token: '' });
    await expect(noToken.client.end(ADMISSION_ID)).resolves.toEqual({ kind: 'no_token' });
    expect(noToken.calls).toHaveLength(0);
  });
});

describe('review F8: a missing or unreadable device token', () => {
  it('a token read that throws resolves no_token on every call and never throws', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, ADMITTED), { tokenThrows: true });
    await expect(client.admit(ONLINE_REQ)).resolves.toEqual({ kind: 'no_token' });
    await expect(client.end(ADMISSION_ID)).resolves.toEqual({ kind: 'no_token' });
    await expect(client.listRoster()).resolves.toEqual({ kind: 'no_token' });
    expect(calls).toHaveLength(0);
  });

  it('no token held: the roster resolves no_token without a request', async () => {
    const { client, calls } = makeClient(() => jsonResponse(200, { cashiers: [] }), {
      token: null,
    });
    await expect(client.listRoster()).resolves.toEqual({ kind: 'no_token' });
    expect(calls).toHaveLength(0);
  });
});

describe('listRoster', () => {
  const ROSTER = {
    cashiers: [
      { user_id: USER_ID, operator_id: 'user_clerk_1', display_name: 'Mona' },
      {
        user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abd',
        operator_id: 'user_clerk_2',
        display_name: 'Karim',
      },
    ],
  };

  it('GETs /api/pos/v1/cashier-admissions/roster with the device bearer and no query', async () => {
    expect(contractErrors('PosCashierRosterResponse', ROSTER)).toEqual([]);
    const { client, calls } = makeClient(() => jsonResponse(200, ROSTER));
    await expect(client.listRoster()).resolves.toEqual({
      kind: 'roster',
      cashiers: ROSTER.cashiers,
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/pos/v1/cashier-admissions/roster`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(headersOf(calls[0] ?? { url: '', init: {} })).toEqual({
      authorization: `Bearer ${DEVICE_TOKEN}`,
    });
  });

  it('strips fields outside the minimum-disclosure allowlist', async () => {
    const { client } = makeClient(() =>
      jsonResponse(200, {
        cashiers: [{ ...ROSTER.cashiers[0], email: 'x@y.z', pin_hash: 'h' }],
      }),
    );
    await expect(client.listRoster()).resolves.toEqual({
      kind: 'roster',
      cashiers: [ROSTER.cashiers[0]],
    });
  });

  it.each([
    ['no cashiers array', {}],
    ['entry missing operator_id', { cashiers: [{ user_id: USER_ID, display_name: 'M' }] }],
    ['entry with empty operator_id', { cashiers: [{ ...ROSTER.cashiers[0], operator_id: '' }] }],
    ['entry missing user_id', { cashiers: [{ operator_id: 'u', display_name: 'M' }] }],
    ['non-object entry', { cashiers: ['x'] }],
  ])('a malformed roster (%s) → rejected', async (_label, body) => {
    const { client } = makeClient(() => jsonResponse(200, body));
    await expect(client.listRoster()).resolves.toEqual({ kind: 'rejected' });
  });

  it.each([
    [401, 'device_unauthorized'],
    [403, 'rejected'],
    [502, 'unavailable'],
  ])('HTTP %i → %s', async (status, kind) => {
    const { client } = makeClient(() => jsonResponse(status, errorBody('x')));
    await expect(client.listRoster()).resolves.toEqual({ kind });
  });

  it('a transport failure → no_connection', async () => {
    const { client } = makeClient(() => Promise.reject(new Error('offline')));
    await expect(client.listRoster()).resolves.toEqual({ kind: 'no_connection' });
  });
});

describe('Clerk-gated operator routes are never requested', () => {
  it('admit, end and listRoster only reach /api/pos/v1/cashier-admissions*', async () => {
    const { client, calls } = makeClient((url) =>
      url.endsWith('/roster')
        ? jsonResponse(200, { cashiers: [] })
        : url.endsWith('/end')
          ? jsonResponse(200, { kind: 'ended' })
          : jsonResponse(200, ADMITTED),
    );
    await client.admit(ONLINE_REQ);
    await client.end(ADMISSION_ID);
    await client.listRoster();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url.startsWith(`${BASE}/api/pos/v1/cashier-admissions`)).toBe(true);
      expect(c.url).not.toContain('/operators/');
    }
  });
});
