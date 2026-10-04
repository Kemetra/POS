/**
 * RT-15 S1 — the live capture client reads Backend-Core's `saleRef` leniently.
 *
 * Contract (Backend-Core `pos-sales/sales.yaml` `captureSale`): 201 (first
 * capture) and 200 (provenance replay, `Idempotent-Replayed: true`) both return
 * the `Sale` projection with a required `saleRef` (`format: uuid`). 409 is an
 * `Error` envelope (`idempotency_key_conflict`) with no `saleRef` — RT-190 makes
 * it a terminal divergence (see create-sale-sync-client.divergence.test.ts).
 *
 * Locks down (RT-15 D-g, lenient): only `saleRef` is read; unknown keys are
 * allowed; a missing / unparseable body or a non-UUID `saleRef` is still `ok`
 * (the sale is captured) with `saleRef: null`, and the warning hook gets a
 * closed-set reason plus the opaque externalId — never the body or the value.
 */
import { describe, expect, it } from 'vitest';

import {
  createSaleSyncClient,
  parseSaleRef,
  type SaleRefUnavailableInfo,
} from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';

const BASE = 'https://example.invalid';
const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';

const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-1',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-10-04T10:00:00.000Z',
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

/** A full `Sale` projection as Backend-Core 1.4.0-draft returns it. */
function saleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    saleRef: SALE_REF,
    storeId: '0190f5a2-0000-7000-8000-000000000001',
    currencyCode: 'EGP',
    posTotal: '10.00',
    occurredAt: '2026-10-04T10:00:00.000Z',
    receivedAt: '2026-10-04T10:00:01.000Z',
    businessDate: '2026-10-04',
    processedAt: null,
    sourceClockAt: null,
    sourceSystem: 'pos-pulse',
    externalId: 'pos-pulse:handoff-1',
    mismatchFlag: false,
    syncStatus: 'pending',
    voided: false,
    lines: [],
    ...overrides,
  };
}

function client(
  respond: () => Response | Promise<Response>,
  warnings: SaleRefUnavailableInfo[] = [],
): ReturnType<typeof createSaleSyncClient> {
  return createSaleSyncClient({
    baseUrl: BASE,
    fetch: () => Promise.resolve(respond()),
    getOperatorToken: () => 'opaque-envelope',
    onSaleRefUnavailable: (info) => warnings.push(info),
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('parseSaleRef — lenient read of saleRef only (D-g)', () => {
  it('returns the saleRef from a full Sale projection', () => {
    expect(parseSaleRef(JSON.stringify(saleBody()))).toEqual({ saleRef: SALE_REF });
  });

  it('allows unknown keys (a later additive Sale field never breaks capture)', () => {
    const body = JSON.stringify({ saleRef: SALE_REF, someFutureField: { nested: [1, 2] } });
    expect(parseSaleRef(body)).toEqual({ saleRef: SALE_REF });
  });

  it('needs nothing but saleRef (other Sale fields are not validated)', () => {
    expect(parseSaleRef(JSON.stringify({ saleRef: SALE_REF }))).toEqual({ saleRef: SALE_REF });
  });

  it('accepts an upper-case UUID (Backend-Core checks case-insensitively)', () => {
    const upper = SALE_REF.toUpperCase();
    expect(parseSaleRef(JSON.stringify({ saleRef: upper }))).toEqual({ saleRef: upper });
  });

  it.each([
    ['empty body', ''],
    ['not JSON', 'Created'],
    ['JSON null', 'null'],
    ['JSON array', JSON.stringify([{ saleRef: SALE_REF }])],
    ['JSON string', JSON.stringify(SALE_REF)],
  ])('unparseable_body: %s', (_label, text) => {
    expect(parseSaleRef(text)).toEqual({ saleRef: null, reason: 'unparseable_body' });
  });

  it.each([
    ['absent', {}],
    ['null', { saleRef: null }],
  ])('missing_sale_ref: saleRef %s', (_label, body) => {
    expect(parseSaleRef(JSON.stringify(body))).toEqual({
      saleRef: null,
      reason: 'missing_sale_ref',
    });
  });

  it.each([
    ['not a UUID', 'sale-1'],
    ['empty string', ''],
    ['a number', 42],
    ['an object', { id: SALE_REF }],
    ['UUID with whitespace', ` ${SALE_REF}`],
    ['UUID without dashes', SALE_REF.replace(/-/g, '')],
  ])('invalid_sale_ref: %s', (_label, value) => {
    expect(parseSaleRef(JSON.stringify({ saleRef: value }))).toEqual({
      saleRef: null,
      reason: 'invalid_sale_ref',
    });
  });
});

describe('createSaleSyncClient.postSale — carries saleRef on ok (RT-15 S1)', () => {
  it('201 first capture: ok with the saleRef, no warning', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const result = await client(() => json(201, saleBody()), warnings).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
    expect(warnings).toEqual([]);
  });

  it('200 provenance replay (Idempotent-Replayed) carries the same saleRef', async () => {
    const result = await client(() =>
      json(200, saleBody(), { 'Idempotent-Replayed': 'true' }),
    ).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
  });

  it('extra keys in the body are allowed', async () => {
    const result = await client(() =>
      json(201, saleBody({ tenders: [{ method: 'cash', amount: '10.00' }], newField: true })),
    ).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
  });

  it('missing body: still ok (captured) with saleRef null + unparseable_body warning', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const result = await client(() => new Response(null, { status: 201 }), warnings).postSale(
      PAYLOAD,
    );
    expect(result).toEqual({ kind: 'ok', saleRef: null });
    expect(warnings).toEqual([{ externalId: 'pos-pulse:handoff-1', reason: 'unparseable_body' }]);
  });

  it('body without saleRef: ok with null + missing_sale_ref warning', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const result = await client(
      () => json(201, saleBody({ saleRef: undefined })),
      warnings,
    ).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'ok', saleRef: null });
    expect(warnings).toEqual([{ externalId: 'pos-pulse:handoff-1', reason: 'missing_sale_ref' }]);
  });

  it('invalid UUID: ok with null + invalid_sale_ref; the warning never carries the value', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const result = await client(
      () => json(200, saleBody({ saleRef: 'not-a-uuid-PII-ish' })),
      warnings,
    ).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'ok', saleRef: null });
    expect(warnings).toEqual([{ externalId: 'pos-pulse:handoff-1', reason: 'invalid_sale_ref' }]);
    expect(JSON.stringify(warnings)).not.toContain('not-a-uuid-PII-ish');
  });

  it('a body read that fails after the status is transient (retry), with no warning', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream aborted'));
        },
      }),
      { status: 201 },
    );
    const result = await client(() => broken, warnings).postSale(PAYLOAD);
    // The answer was lost in transit, not malformed: retry with the same key so
    // the server replays it (same saleRef) — never mark it synced without one.
    expect(result).toEqual({ kind: 'transient' });
    expect(warnings).toEqual([]);
  });

  it('a timeout that fires mid-body is transient too', async () => {
    const c = createSaleSyncClient({
      baseUrl: BASE,
      // Like a real fetch: the headers arrive, then the body stream errors when the
      // request signal (the client's AbortSignal.timeout) aborts mid-body.
      fetch: (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"saleRef":"'));
            signal?.addEventListener('abort', () => {
              controller.error(signal.reason);
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 201 }));
      },
      getOperatorToken: () => 'opaque-envelope',
      timeoutMs: 20,
    });
    expect(await c.postSale(PAYLOAD)).toEqual({ kind: 'transient' });
  });

  it('no warning hook configured: a null saleRef is still a quiet ok', async () => {
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: () => Promise.resolve(new Response('oops', { status: 201 })),
      getOperatorToken: () => 'opaque-envelope',
    });
    expect(await c.postSale(PAYLOAD)).toEqual({ kind: 'ok', saleRef: null });
  });

  it('a throwing warning hook never turns the captured sale into a rejection', async () => {
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: () => Promise.resolve(new Response(null, { status: 201 })),
      getOperatorToken: () => 'opaque-envelope',
      onSaleRefUnavailable: () => {
        throw new Error('logger down');
      },
    });
    expect(await c.postSale(PAYLOAD)).toEqual({ kind: 'ok', saleRef: null });
  });

  it('RT-190: 409 is divergent, never ok, and never raises a saleRef warning', async () => {
    const warnings: SaleRefUnavailableInfo[] = [];
    const conflict = json(409, {
      error: { code: 'idempotency_key_conflict', message: 'sale already captured' },
    });
    const result = await client(() => conflict, warnings).postSale(PAYLOAD);
    expect(result).toEqual({ kind: 'divergent', errorCode: 'idempotency_key_conflict' });
    expect(warnings).toEqual([]);
  });

  it('other statuses are classified exactly as before (bodies ignored)', async () => {
    expect(await client(() => json(500, saleBody())).postSale(PAYLOAD)).toEqual({
      kind: 'transient',
    });
    expect(await client(() => json(422, saleBody())).postSale(PAYLOAD)).toEqual({
      kind: 'permanent',
    });
    expect(await client(() => json(401, saleBody())).postSale(PAYLOAD)).toEqual({
      kind: 'transient',
    });
  });
});
