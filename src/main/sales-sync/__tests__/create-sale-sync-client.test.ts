import { describe, expect, it } from 'vitest';

import {
  createSaleSyncClient,
  toWireBody,
  classifyStatus,
  exponentFor,
  minorUnitsToDecimalString,
} from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';

/**
 * 011-sale-sync-capture-up T061 — live `SaleSyncClient` tests.
 *
 * Locks down (a) the internal→wire transform against the binding DP2
 * `CaptureSaleRequest` (deployed ref 6975f67, `additionalProperties: false`):
 * flat top-level `posTotal` as an exact-decimal STRING, top-level `currencyCode`,
 * per-line `CaptureSaleLine` (lineName / unitPrice-str / currencyCode / quantity-str
 * / lineAmount-str / unit), STRING `quantity`, and NO tenant/store/actor keys
 * (server-resolved); (b) the HTTP→outcome union mapping; (c) the per-POST
 * operator-token Authorization header + the deterministic `Idempotency-Key`;
 * (d) no-token and transport-fault paths. The token is attached to the request
 * and never surfaced.
 */

const BASE = 'https://example.invalid';
const SALES_PATH = '/api/pos/v1/sales';
// 016 (D5): the credential the holder now delivers is the opaque pos_operator
// ENVELOPE (NOT the Clerk JWT). `getOperatorToken` returns it; the client presents
// it as `Authorization: Bearer <envelope>` via the operatorAuthorization scheme.
const TOKEN = 'opaque-pos-operator-envelope-abc';

const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-1',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-06-09T10:00:00.000Z',
  totalMinor: 2550,
  lines: [
    {
      lineRef: 'l1',
      productRef: 'p1',
      lineName: 'Panadol',
      quantity: 2,
      unitPriceMinor: 1000,
      lineAmountMinor: 2000,
    },
    {
      lineRef: 'l2',
      productRef: 'p2',
      lineName: 'Brufen',
      quantity: 1,
      unitPriceMinor: 550,
      lineAmountMinor: 550,
    },
  ],
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(status: number | 'reject'): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    if (status === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetchImpl, captured };
}

function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(init: RequestInit, name: string): string | null {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

describe('exponentFor — ISO-4217 minor-unit exponent (shared with RT-15 returns)', () => {
  it.each<[string, number]>([
    ['EGP', 2],
    ['USD', 2],
    ['JPY', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['XYZ', 2],
  ])('%s → %s (unknown currencies default to 2)', (currency, exponent) => {
    expect(exponentFor(currency)).toBe(exponent);
  });
});

describe('minorUnitsToDecimalString — integer minor → exact-decimal string', () => {
  it('formats exponent-2 amounts with two fractional digits', () => {
    expect(minorUnitsToDecimalString(2550, 2)).toBe('25.50');
    expect(minorUnitsToDecimalString(5, 2)).toBe('0.05');
    expect(minorUnitsToDecimalString(0, 2)).toBe('0.00');
    expect(minorUnitsToDecimalString(100000, 2)).toBe('1000.00');
  });
  it('emits NO decimal point for an exponent-0 currency (DecimalAmount grammar)', () => {
    expect(minorUnitsToDecimalString(100, 0)).toBe('100');
    expect(minorUnitsToDecimalString(0, 0)).toBe('0');
  });
  it('formats exponent-3 amounts with three fractional digits', () => {
    expect(minorUnitsToDecimalString(1234, 3)).toBe('1.234');
    expect(minorUnitsToDecimalString(5, 3)).toBe('0.005');
  });
  it('throws on a non-safe-integer minor amount (float / NaN / overflow)', () => {
    expect(() => minorUnitsToDecimalString(10.5, 2)).toThrow();
    expect(() => minorUnitsToDecimalString(Number.NaN, 2)).toThrow();
    expect(() => minorUnitsToDecimalString(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow();
  });
  it('throws on a negative or non-integer exponent', () => {
    expect(() => minorUnitsToDecimalString(100, -1)).toThrow();
    expect(() => minorUnitsToDecimalString(100, 1.5)).toThrow();
  });
});

describe('toWireBody — internal → DP2 CaptureSaleRequest wire shape', () => {
  it('renames total→posTotal as a decimal string, adds top-level currencyCode, stringifies quantity', () => {
    const wire = toWireBody(PAYLOAD, 'EGP');

    expect(wire.currencyCode).toBe('EGP');
    expect(wire.posTotal).toBe('25.50'); // DecimalAmount STRING, not minor units
    expect(wire.sourceSystem).toBe('pos-pulse');
    expect(wire.externalId).toBe('pos-pulse:handoff-1');
    expect(wire.occurredAt).toBe('2026-06-09T10:00:00.000Z');

    // Each line carries the binding CaptureSaleLine fields.
    expect(wire.lines[0]).toEqual({
      lineName: 'Panadol',
      unitPrice: '10.00',
      currencyCode: 'EGP',
      quantity: '2', // STRING on the wire
      lineAmount: '20.00',
      unit: 'unit',
    });
    expect(wire.lines[1]).toEqual({
      lineName: 'Brufen',
      unitPrice: '5.50',
      currencyCode: 'EGP',
      quantity: '1',
      lineAmount: '5.50',
      unit: 'unit',
    });
  });

  it('omits server-resolved tenant/store/actor and non-contract keys (additionalProperties:false)', () => {
    const wire = toWireBody(PAYLOAD, 'EGP') as unknown as Record<string, unknown>;
    for (const forbidden of ['tenantId', 'branchId', 'terminalId', 'operatorId', 'total']) {
      expect(forbidden in wire).toBe(false);
    }
    const line0 = wire['lines'] as Array<Record<string, unknown>>;
    for (const forbidden of ['lineRef', 'productRef', 'unitPriceMinor', 'lineAmountMinor']) {
      expect(forbidden in (line0[0] ?? {})).toBe(false);
    }
  });

  // RT-35 (RT-30 lineage contract): the frozen `item_ref` IS the Backend-Core
  // `tenant_products.id` for catalogue lines. It rides the wire as the optional
  // `tenantProductRef` ONLY when it has the UUID shape DP-2 accepts
  // (`z.string().uuid()`); anything else is omitted (ad-hoc lineage) so the sale
  // is still captured instead of 400 → dead-lettered.
  const TENANT_PRODUCT_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
  const withProductRefs = (...refs: string[]): CaptureSalePayload => {
    const base = PAYLOAD.lines[0];
    if (base === undefined) throw new Error('test: fixture has no lines');
    return {
      ...PAYLOAD,
      lines: refs.map((productRef, i) => ({ ...base, lineRef: `l${String(i)}`, productRef })),
    };
  };

  it('emits tenantProductRef from a UUID productRef (catalogue lineage)', () => {
    const wire = toWireBody(withProductRefs(TENANT_PRODUCT_ID), 'EGP');
    expect(wire.lines[0]?.tenantProductRef).toBe(TENANT_PRODUCT_ID);
  });

  it('accepts an upper-case UUID exactly as DP-2 zod does (case-insensitive)', () => {
    const upper = TENANT_PRODUCT_ID.toUpperCase();
    const wire = toWireBody(withProductRefs(upper), 'EGP');
    expect(wire.lines[0]?.tenantProductRef).toBe(upper);
  });

  it('omits the tenantProductRef KEY for a non-UUID or empty productRef (never null / "")', () => {
    const wire = toWireBody(
      withProductRefs('dev-p-001', 'SKU-PARA-500', '', `${TENANT_PRODUCT_ID}x`),
      'EGP',
    );
    for (const line of wire.lines) {
      expect('tenantProductRef' in line).toBe(false);
    }
  });

  it('decides tenantProductRef per line on a mixed sale', () => {
    const wire = toWireBody(withProductRefs(TENANT_PRODUCT_ID, 'dev-p-002'), 'EGP');
    expect(wire.lines[0]?.tenantProductRef).toBe(TENANT_PRODUCT_ID);
    expect('tenantProductRef' in (wire.lines[1] ?? {})).toBe(false);
  });

  it('is byte-stable across retries of the same sale', () => {
    const payload = withProductRefs(TENANT_PRODUCT_ID, 'dev-p-002');
    expect(JSON.stringify(toWireBody(payload, 'EGP'))).toBe(
      JSON.stringify(toWireBody(payload, 'EGP')),
    );
  });

  it('throws when a money field is not a safe integer (corrupted upstream value)', () => {
    const bad: CaptureSalePayload = { ...PAYLOAD, totalMinor: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => toWireBody(bad, 'EGP')).toThrow();
  });

  it('throws when a line quantity is not a safe integer', () => {
    const firstLine = PAYLOAD.lines[0];
    if (firstLine === undefined) throw new Error('test: fixture has no lines');
    const bad: CaptureSalePayload = {
      ...PAYLOAD,
      lines: [{ ...firstLine, quantity: 1.5 }],
    };
    expect(() => toWireBody(bad, 'EGP')).toThrow();
  });
});

describe('classifyStatus — HTTP → outcome union', () => {
  it('maps 200/201 → ok', () => {
    expect(classifyStatus(200)).toEqual({ kind: 'ok', saleRef: null });
    expect(classifyStatus(201)).toEqual({ kind: 'ok', saleRef: null });
  });
  it('RT-190: maps 409 → divergent (terminal, NOT success); the status alone decides', () => {
    expect(classifyStatus(409)).toEqual({ kind: 'divergent', errorCode: 'unrecognized' });
  });
  it('maps 5xx → transient', () => {
    expect(classifyStatus(500)).toEqual({ kind: 'transient' });
    expect(classifyStatus(503)).toEqual({ kind: 'transient' });
  });
  it('maps auth 401/403 → transient (NOT permanent — never lose a sale to an expired JWT)', () => {
    // The Clerk operator JWT lives ~60s; a flush attempted with a stale token
    // 401s. That is a RETRYABLE auth-refresh case, not a permanent defect — a
    // fresh sign-in re-drains the row. Dead-lettering it loses the sale.
    expect(classifyStatus(401)).toEqual({ kind: 'transient' });
    expect(classifyStatus(403)).toEqual({ kind: 'transient' });
  });
  it('maps 429 → transient (NOT permanent — a rate-limit throttle must retry, never dead-letter the sale)', () => {
    // DP-2 ADR 0009 adds a per-device write rate limit that returns 429 on the
    // sale-capture route. 429 is a TRANSIENT back-pressure signal (retry after
    // Retry-After), not a contract defect — dead-lettering it would permanently
    // lose a perfectly valid sale just because the device was briefly too fast.
    expect(classifyStatus(429)).toEqual({ kind: 'transient' });
  });
  it('maps 425 idempotency_in_progress → transient (RT-194: the same key is still in flight, never dead-letter)', () => {
    expect(classifyStatus(425)).toEqual({ kind: 'transient' });
  });
  it('maps genuine validation 4xx (400/404/422) → permanent (dead-letter)', () => {
    expect(classifyStatus(400)).toEqual({ kind: 'permanent' });
    expect(classifyStatus(404)).toEqual({ kind: 'permanent' });
    expect(classifyStatus(422)).toEqual({ kind: 'permanent' });
  });
  it('maps an unexpected 3xx → transient (never lose the sale)', () => {
    expect(classifyStatus(302)).toEqual({ kind: 'transient' });
  });
});

describe('createSaleSyncClient — request shape', () => {
  it('POSTs with operator-envelope Bearer auth + deterministic Idempotency-Key + wire body, NO X-Device-Attestation (016 D5/D7)', async () => {
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });

    await client.postSale(PAYLOAD);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    if (req === undefined) throw new Error('test: no request captured');
    expect(req.url).toBe(`${BASE}${SALES_PATH}`);
    expect(req.init.method).toBe('POST');
    // 016 (D5): the operatorAuthorization scheme = Bearer <opaque envelope>.
    expect(headerValue(req.init, 'Authorization')).toBe(`Bearer ${TOKEN}`);
    // 016 (D7): X-Device-Attestation is RETIRED from the sale wire (#559) — the
    // device token no longer co-travels on the sale POST. Assert it is ABSENT.
    expect(headerValue(req.init, 'X-Device-Attestation')).toBeNull();
    expect(headerValue(req.init, 'Idempotency-Key')).toBe(PAYLOAD.externalId);
    expect(headerValue(req.init, 'Content-Type')).toBe('application/json');
    // The opaque envelope rides in the Authorization HEADER, never the body.
    expect(req.init.body as string).not.toContain(TOKEN);

    const body = JSON.parse(req.init.body as string) as {
      posTotal: unknown;
      currencyCode: unknown;
      lines: Array<Record<string, unknown>>;
    };
    expect(body.posTotal).toBe('25.50');
    expect(body.currencyCode).toBe('EGP');
    expect(body.lines[0]?.['lineName']).toBe('Panadol');
    expect(body.lines[0]?.['unitPrice']).toBe('10.00');
    expect(body.lines[0]?.['unit']).toBe('unit');
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: `${BASE}/`,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });

    await client.postSale(PAYLOAD);
    expect(captured[0]?.url).toBe(`${BASE}${SALES_PATH}`);
  });
});

describe('createSaleSyncClient — outcome mapping', () => {
  const cases: Array<[number, string]> = [
    [200, 'ok'],
    [201, 'ok'],
    [409, 'divergent'],
    [500, 'transient'],
    [401, 'transient'], // expired operator JWT — retryable, not dead-lettered
    [403, 'transient'],
    [400, 'permanent'],
    [422, 'permanent'],
  ];
  for (const [status, kind] of cases) {
    it(`maps HTTP ${String(status)} → ${kind}`, async () => {
      const { fetchImpl } = captureFetch(status);
      const client = createSaleSyncClient({
        baseUrl: BASE,
        fetch: fetchImpl,
        getOperatorToken: () => TOKEN,
      });

      const result = await client.postSale(PAYLOAD);
      expect(result.kind).toBe(kind);
    });
  }

  it('maps a transport fault to no_connection', async () => {
    const { fetchImpl } = captureFetch('reject');
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });

    const result = await client.postSale(PAYLOAD);
    expect(result.kind).toBe('no_connection');
  });

  it('maps a corrupted money value to permanent without throwing (never-rejects contract)', async () => {
    // A non-safe-integer amount makes the wire transform throw; postSale must NOT
    // reject (sale-sync-client-types.ts) — it dead-letters via `permanent` instead.
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });
    const bad: CaptureSalePayload = { ...PAYLOAD, totalMinor: Number.MAX_SAFE_INTEGER + 1 };

    const result = await client.postSale(bad);
    expect(result.kind).toBe('permanent');
    expect(captured).toHaveLength(0); // never reached the network
  });
});

describe('createSaleSyncClient — operator-token gating', () => {
  it('does not POST and returns no_connection when no operator token is present', async () => {
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => null,
    });

    const result = await client.postSale(PAYLOAD);
    expect(result.kind).toBe('no_connection');
    expect(captured).toHaveLength(0);
  });

  it('honors a custom currencyCode in the wire body', async () => {
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
      currencyCode: 'USD',
    });

    await client.postSale(PAYLOAD);
    const req = captured[0];
    if (req === undefined) throw new Error('test: no request captured');
    const body = JSON.parse(req.init.body as string) as {
      currencyCode: string;
      lines: Array<{ currencyCode: string }>;
    };
    expect(body.currencyCode).toBe('USD');
    expect(body.lines[0]?.currencyCode).toBe('USD');
  });
});

describe('RT-79 — tenders on the wire (RT-10 D1; SaleTender contract)', () => {
  const TENDERED: CaptureSalePayload = {
    ...PAYLOAD,
    tenders: [
      { method: 'cash', amountMinor: PAYLOAD.totalMinor - 500 },
      { method: 'card_external', amountMinor: 500 },
    ],
  };

  it('converts tender amounts to exact-decimal strings (same exponent as posTotal)', () => {
    const wire = toWireBody(TENDERED, 'EGP');
    expect(wire.posTotal).toBe(minorUnitsToDecimalString(PAYLOAD.totalMinor, 2));
    expect(wire.tenders).toEqual([
      { method: 'cash', amount: minorUnitsToDecimalString(PAYLOAD.totalMinor - 500, 2) },
      { method: 'card_external', amount: '5.00' },
    ]);
  });

  it('emits NO reference key and only {method, amount} per tender', () => {
    const wire = toWireBody(TENDERED, 'EGP');
    for (const t of wire.tenders ?? []) {
      expect(Object.keys(t).sort()).toEqual(['amount', 'method']);
    }
  });

  it('a payload without tenders has no tenders key (byte-identical to pre-RT-79)', () => {
    expect('tenders' in toWireBody(PAYLOAD, 'EGP')).toBe(false);
  });

  it('honours the currency exponent for tenders (JPY exponent 0)', () => {
    const jpy: CaptureSalePayload = {
      ...PAYLOAD,
      totalMinor: 1000,
      tenders: [{ method: 'cash', amountMinor: 1000 }],
    };
    expect(toWireBody(jpy, 'JPY').tenders).toEqual([{ method: 'cash', amount: '1000' }]);
  });

  it('sum(tenders) != total -> the transform throws (local defect)', () => {
    const off: CaptureSalePayload = {
      ...PAYLOAD,
      tenders: [{ method: 'cash', amountMinor: PAYLOAD.totalMinor - 1 }],
    };
    expect(() => toWireBody(off, 'EGP')).toThrow(/tender/i);
  });

  it('postSale with a tender mismatch is permanent (dead-letter) and never reaches the network', async () => {
    const { fetchImpl, captured } = captureFetch(200);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });
    const off: CaptureSalePayload = {
      ...PAYLOAD,
      tenders: [{ method: 'cash', amountMinor: PAYLOAD.totalMinor + 1 }],
    };
    expect((await client.postSale(off)).kind).toBe('permanent');
    expect(captured).toHaveLength(0);
  });

  it('postSale sends tenders in the JSON body', async () => {
    const { fetchImpl, captured } = captureFetch(201);
    const client = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => TOKEN,
    });
    expect((await client.postSale(TENDERED)).kind).toBe('ok');
    const sent = JSON.parse(captured[0]?.init.body as string) as { tenders?: unknown[] };
    expect(sent.tenders).toHaveLength(2);
  });
});
