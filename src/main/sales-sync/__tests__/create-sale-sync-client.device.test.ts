/**
 * RT-224 step 2 — the live client's device path (`postSaleAsCashier`).
 *
 * Backend-Core #709 (`sales.yaml` 1.5.0-draft): `captureSale` also accepts the
 * `device` scheme — `Authorization: Bearer <device token>` — with a body
 * `operatorUserId` (the `users.id` of the cashier who made the sale). With the
 * `operatorAuthorization` envelope the body MUST NOT carry `operatorUserId`.
 *
 * Device-path status mapping:
 *   401 → `device_unauthorized` (the device credential; the sale stays queued)
 *   403 → `refused` (an authenticated device whose cashier claim was refused)
 *   every other status → exactly the envelope path's mapping.
 * The envelope path's own 401/403 mapping (transient) is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { createSaleSyncClient, toWireBody } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';

const BASE = 'https://example.invalid';
const ENVELOPE = 'opaque-pos-operator-envelope-abc';
const DEVICE_TOKEN = 'device-token-SECRET-xyz';
const USER = '0190a3c4-0000-7000-8000-00000000000a';
const SALE_REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';

const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-1',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-06-09T10:00:00.000Z',
  totalMinor: 1000,
  lines: [
    {
      lineRef: 'l1',
      productRef: 'p1',
      lineName: 'Panadol',
      quantity: 1,
      unitPriceMinor: 1000,
      lineAmountMinor: 1000,
    },
  ],
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fetchAnswering(
  status: number | 'reject',
  body: string | null = null,
  headers: Record<string, string> = {},
): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
    if (status === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetchImpl, captured };
}

function client(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  device: string | null = DEVICE_TOKEN,
) {
  return createSaleSyncClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getOperatorToken: () => ENVELOPE,
    getDeviceToken: () => Promise.resolve(device),
  });
}

const header = (c: Captured, name: string): string | null =>
  (c.init.headers as Record<string, string> | undefined)?.[name] ?? null;
/** The client always sends a JSON string body. */
const rawBody = (c: Captured): string => {
  if (typeof c.init.body !== 'string') throw new Error('expected a string body');
  return c.init.body;
};
const body = (c: Captured): Record<string, unknown> =>
  JSON.parse(rawBody(c)) as Record<string, unknown>;

describe('RT-224 step 2 — postSaleAsCashier request', () => {
  it('POSTs /api/pos/v1/sales with the device bearer, the idempotency key and operatorUserId', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, JSON.stringify({ saleRef: SALE_REF }));
    const result = await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER);
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
    expect(captured).toHaveLength(1);
    const req = captured[0] as Captured;
    expect(req.url).toBe(`${BASE}/api/pos/v1/sales`);
    expect(req.init.method).toBe('POST');
    expect(header(req, 'Authorization')).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(header(req, 'Idempotency-Key')).toBe(PAYLOAD.externalId);
    expect(body(req)).toEqual({ ...toWireBody(PAYLOAD, 'EGP'), operatorUserId: USER });
  });

  it('never puts the device token or the envelope in the body', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER);
    const raw = rawBody(captured[0] as Captured);
    expect(raw).not.toContain(DEVICE_TOKEN);
    expect(raw).not.toContain(ENVELOPE);
  });

  it('with no device token: no request, and the sale stays queued (no_connection)', async () => {
    for (const token of [null, '']) {
      const { fetchImpl, captured } = fetchAnswering(201, '{}');
      expect(await client(fetchImpl, token).postSaleAsCashier(PAYLOAD, USER)).toEqual({
        kind: 'no_connection',
      });
      expect(captured).toHaveLength(0);
    }
  });

  it('with no device-token reader wired at all: no request (no_connection)', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
    });
    expect(await c.postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'no_connection' });
    expect(captured).toHaveLength(0);
  });
});

describe('RT-224 step 2 — the envelope request is unchanged', () => {
  it('postSale carries the envelope and NO operatorUserId', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    await client(fetchImpl).postSale(PAYLOAD);
    const req = captured[0] as Captured;
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENVELOPE}`);
    expect('operatorUserId' in body(req)).toBe(false);
    expect(body(req)).toEqual(toWireBody(PAYLOAD, 'EGP'));
  });

  it.each([401, 403])('an envelope %s is still transient (unchanged)', async (status) => {
    const { fetchImpl } = fetchAnswering(status);
    expect(await client(fetchImpl).postSale(PAYLOAD)).toEqual({ kind: 'transient' });
  });
});

describe('RT-224 step 2 — device-path status mapping', () => {
  it('403 → refused (a per-sale refusal, never device-revoked)', async () => {
    const { fetchImpl } = fetchAnswering(403, JSON.stringify({ code: 'refused' }));
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'refused' });
  });

  it('403 with any body (or none) → refused: the status alone decides', async () => {
    const { fetchImpl } = fetchAnswering(403, 'not json');
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'refused' });
  });

  it('401 → device_unauthorized', async () => {
    const { fetchImpl } = fetchAnswering(401);
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'device_unauthorized',
    });
  });

  it.each<[number, unknown]>([
    [400, { kind: 'permanent' }],
    [422, { kind: 'permanent' }],
    [500, { kind: 'transient' }],
    [503, { kind: 'transient' }],
  ])('%s → %j (same as the envelope path)', async (status, expected) => {
    const { fetchImpl } = fetchAnswering(status);
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual(expected);
  });

  it('409 → divergent with the closed-set code', async () => {
    const { fetchImpl } = fetchAnswering(
      409,
      JSON.stringify({ error: { code: 'idempotency_key_conflict' } }),
    );
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'divergent',
      errorCode: 'idempotency_key_conflict',
    });
  });

  it('200 replay → ok with the saleRef', async () => {
    const { fetchImpl } = fetchAnswering(200, JSON.stringify({ saleRef: SALE_REF }));
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'ok',
      saleRef: SALE_REF,
    });
  });

  it('425 → transient with Retry-After', async () => {
    const { fetchImpl } = fetchAnswering(425, null, { 'Retry-After': '2' });
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'transient',
      retryAfterMs: 2000,
    });
  });

  it('a transport fault → no_connection', async () => {
    const { fetchImpl } = fetchAnswering('reject');
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'no_connection',
    });
  });
});
