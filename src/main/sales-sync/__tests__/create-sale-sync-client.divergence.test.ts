/**
 * RT-190 — a capture 409 is a terminal payload divergence, never success.
 *
 * Backend-Core (`pos-sales/sales.yaml` `captureSale`, `Conflict` response)
 * answers 409 ONLY as the `Error` envelope `{ error: { code:
 * 'idempotency_key_conflict', message } }`: the Idempotency-Key or the
 * `(tenant, sourceSystem, externalId)` provenance was already used for a
 * DIFFERENT logical payload. Benign replays are 201 (`Idempotent-Replayed`) or
 * 200 with the identical `Sale`, never 409.
 *
 * Locks down:
 *   • 409 → `divergent` with a closed-set `errorCode`, never `ok`;
 *   • a malformed / unreadable body or any other code is still `divergent`
 *     (`unrecognized`) — fail closed, and no server text is echoed (P7);
 *   • 200/201 replays stay `ok` with their saleRef;
 *   • other statuses keep their classification.
 */
import { describe, expect, it } from 'vitest';

import { createSaleSyncClient, parseConflictCode } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';
import type { SaleSyncResult } from '../sale-sync-client-types.js';

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

const CONFLICT_BODY = {
  error: {
    code: 'idempotency_key_conflict',
    message: 'sale already captured with different tenders',
  },
};

function respondWith(response: () => Response): Promise<SaleSyncResult> {
  return createSaleSyncClient({
    baseUrl: BASE,
    fetch: () => Promise.resolve(response()),
    getOperatorToken: () => 'opaque-envelope',
  }).postSale(PAYLOAD);
}

function raw(status: number, body: string | null, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('parseConflictCode — closed-set label of a 409 body', () => {
  it('names the contract code', () => {
    expect(parseConflictCode(JSON.stringify(CONFLICT_BODY))).toBe('idempotency_key_conflict');
  });

  it.each([
    ['empty body', ''],
    ['not JSON', '<html>conflict</html>'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['no error envelope', JSON.stringify({ code: 'idempotency_key_conflict' })],
    ['error is not an object', JSON.stringify({ error: 'idempotency_key_conflict' })],
    ['error has no code', JSON.stringify({ error: { message: 'x' } })],
    ['code is not a string', JSON.stringify({ error: { code: 409 } })],
    ['another code', JSON.stringify({ error: { code: 'conflict', message: 'x' } })],
  ])('%s → unrecognized', (_label, body) => {
    expect(parseConflictCode(body)).toBe('unrecognized');
  });
});

describe('createSaleSyncClient — capture 409 (RT-190)', () => {
  it('409 idempotency_key_conflict → divergent with the contract code, never ok', async () => {
    const result = await respondWith(() => raw(409, JSON.stringify(CONFLICT_BODY)));
    expect(result).toEqual({ kind: 'divergent', errorCode: 'idempotency_key_conflict' });
  });

  it('409 with a malformed body is still divergent (fail closed)', async () => {
    const result = await respondWith(() => raw(409, '{"error":'));
    expect(result).toEqual({ kind: 'divergent', errorCode: 'unrecognized' });
  });

  it('409 with an empty body is still divergent', async () => {
    const result = await respondWith(() => raw(409, null));
    expect(result).toEqual({ kind: 'divergent', errorCode: 'unrecognized' });
  });

  it('409 with another code is still divergent, and the server code is not echoed', async () => {
    const result = await respondWith(() =>
      raw(409, JSON.stringify({ error: { code: 'customer_ahmed_conflict', message: 'x' } })),
    );
    expect(result).toEqual({ kind: 'divergent', errorCode: 'unrecognized' });
    expect(JSON.stringify(result)).not.toContain('ahmed');
  });

  it('409 whose body stream fails is still divergent (never transient, never retried)', async () => {
    const response = raw(409, JSON.stringify(CONFLICT_BODY));
    response.text = () => Promise.reject(new Error('stream reset'));
    const result = await respondWith(() => response);
    expect(result).toEqual({ kind: 'divergent', errorCode: 'unrecognized' });
  });

  it('the divergent result carries no server message', async () => {
    const result = await respondWith(() => raw(409, JSON.stringify(CONFLICT_BODY)));
    expect(JSON.stringify(result)).not.toContain('different tenders');
  });
});

describe('createSaleSyncClient — replays stay success (RT-190 unchanged paths)', () => {
  it('201 first capture → ok with saleRef', async () => {
    const result = await respondWith(() => raw(201, JSON.stringify({ saleRef: SALE_REF })));
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
  });

  it('201 same-key replay (Idempotent-Replayed) → ok with saleRef', async () => {
    const result = await respondWith(() =>
      raw(201, JSON.stringify({ saleRef: SALE_REF }), { 'Idempotent-Replayed': 'true' }),
    );
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
  });

  it('200 provenance replay (Idempotent-Replayed) → ok with saleRef', async () => {
    const result = await respondWith(() =>
      raw(200, JSON.stringify({ saleRef: SALE_REF }), { 'Idempotent-Replayed': 'true' }),
    );
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
  });

  it.each<[number, SaleSyncResult['kind']]>([
    [400, 'permanent'],
    [401, 'transient'],
    [403, 'transient'],
    [404, 'permanent'],
    [422, 'permanent'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ])('HTTP %i keeps its classification (%s)', async (status, kind) => {
    const result = await respondWith(() => raw(status, JSON.stringify(CONFLICT_BODY)));
    expect(result.kind).toBe(kind);
  });
});
