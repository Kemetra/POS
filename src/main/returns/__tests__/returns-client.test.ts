/**
 * RT-15 S2 — the Backend-Core returns client.
 *
 *   • every documented status / `error.code` maps to its own typed refusal (AC10);
 *   • a replay is detected by `Idempotent-Replayed: true` or a 200;
 *   • a lost or unreadable answer is `unknown` — never success (AC9);
 *   • the only hosts / paths are Backend-Core `/api/pos/v1/sales/...` (AC7);
 *   • the envelope is sent as `Authorization: Bearer`, the journaled body bytes
 *     verbatim, `Idempotency-Key` = externalId; no credential → no request.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ServerReturnRefusal } from '../../../shared/returns/types.js';
import {
  classifyRefusal,
  createReturnsClient,
  type RecordReturnRequest,
} from '../returns-client.js';
import {
  BASE_URL,
  ENVELOPE,
  FakeBackend,
  SALE_REF,
  errorBody,
  jsonResponse,
  saleReturnFor,
} from './__helpers__/returns-fixture.js';

const KEY = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const BODY = JSON.stringify({
  sourceSystem: 'pos-pulse',
  externalId: KEY,
  lines: [{ lineRef: SALE_REF, quantity: '1' }],
  refundTenders: [{ method: 'cash', amount: '15.00' }],
});

/** The client, with every call carrying `token` as its (snapshot) envelope. */
function clientFor(backend: FakeBackend, token: string | null = ENVELOPE) {
  const client = createReturnsClient({
    baseUrl: `${BASE_URL}/`,
    fetch: backend.fetch,
    timeoutMs: 50,
  });
  return {
    readSale: (saleRef: string) => client.readSale(saleRef, token),
    recordReturn: (request: RecordReturnRequest) => client.recordReturn(request, token),
  };
}

function record(backend: FakeBackend, resend = false) {
  return clientFor(backend).recordReturn({
    saleRef: SALE_REF,
    bodyJson: BODY,
    idempotencyKey: KEY,
    resend,
  });
}

const RECORDED = saleReturnFor(JSON.parse(BODY) as Parameters<typeof saleReturnFor>[0]);

describe('classifyRefusal', () => {
  it.each<[number, string | null, ServerReturnRefusal | null]>([
    [400, 'validation_error', 'validation_error'],
    [401, 'unauthorized', 'unauthorized'],
    [403, null, 'unauthorized'],
    [404, 'not_found', 'returns_unavailable'],
    [409, 'over_return', 'over_return'],
    [409, 'already_reversed', 'already_reversed'],
    [409, 'conflict', 'conflict'],
    [409, 'idempotency_key_conflict', 'conflict'],
    [409, null, 'conflict'],
    [422, 'return_tender_mismatch', 'return_tender_mismatch'],
    [429, 'rate_limited', null],
    [500, 'internal_error', null],
    [302, null, null],
  ])('%s %s → %s', (status, code, expected) => {
    expect(classifyRefusal(status, code)).toBe(expected);
  });
});

describe('recordReturn', () => {
  it('sends the journaled bytes with the envelope and the Idempotency-Key, to the returns path', async () => {
    const backend = new FakeBackend();
    backend.onReturn = () => jsonResponse(201, RECORDED);
    await expect(record(backend)).resolves.toMatchObject({
      kind: 'recorded',
      replayed: false,
      saleReturn: { externalId: KEY, returnTotal: '15.0000' },
    });
    expect(backend.calls).toEqual([
      {
        url: `${BASE_URL}/api/pos/v1/sales/${SALE_REF}/returns`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': KEY,
          Authorization: `Bearer ${ENVELOPE}`,
        },
        body: BODY,
      },
    ]);
  });

  it.each<[string, Response]>([
    ['a same-key 201 replay', jsonResponse(201, RECORDED, { 'Idempotent-Replayed': 'true' })],
    ['a 200 provenance replay', jsonResponse(200, RECORDED, { 'Idempotent-Replayed': 'true' })],
    ['a 200 without the header', jsonResponse(200, RECORDED)],
  ])('detects %s as a replay (success)', async (_label, response) => {
    const backend = new FakeBackend();
    backend.onReturn = () => response;
    await expect(record(backend)).resolves.toMatchObject({ kind: 'recorded', replayed: true });
  });

  it('maps an Error envelope to its refusal', async () => {
    const backend = new FakeBackend();
    backend.onReturn = () => jsonResponse(409, errorBody('over_return'));
    await expect(record(backend)).resolves.toEqual({ kind: 'refused', reason: 'over_return' });
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a refused connection', () => Promise.reject(new TypeError('ECONNREFUSED'))],
    ['a 500', () => jsonResponse(500, errorBody('internal_error'))],
    ['a 201 whose body is not a SaleReturn', () => jsonResponse(201, { ok: true })],
    [
      'a body stream that fails mid-read',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('reset'));
            },
          }),
          { status: 201 },
        ),
    ],
    [
      'a 425 idempotency_in_progress (RT-194)',
      () => jsonResponse(425, errorBody('idempotency_in_progress')),
    ],
  ])('%s is unknown, never success', async (_label, respond) => {
    const backend = new FakeBackend();
    backend.onReturn = respond;
    await expect(record(backend)).resolves.toEqual({ kind: 'unknown' });
  });

  it('a real timeout aborts the request and is unknown', async () => {
    const client = createReturnsClient({
      baseUrl: BASE_URL,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'TimeoutError'));
          });
        }),
      timeoutMs: 10,
    });
    await expect(
      client.recordReturn(
        { saleRef: SALE_REF, bodyJson: BODY, idempotencyKey: KEY, resend: false },
        ENVELOPE,
      ),
    ).resolves.toEqual({ kind: 'unknown' });
  });

  it.each<[string, string | null]>([
    ['no envelope', null],
    ['an empty envelope', ''],
  ])('with %s sends nothing and is unknown', async (_label, token) => {
    const backend = new FakeBackend();
    const client = clientFor(backend, token);
    await expect(
      client.recordReturn({
        saleRef: SALE_REF,
        bodyJson: BODY,
        idempotencyKey: KEY,
        resend: false,
      }),
    ).resolves.toEqual({ kind: 'unknown' });
    await expect(client.readSale(SALE_REF)).resolves.toEqual({ kind: 'unavailable' });
    expect(backend.calls).toHaveLength(0);
  });

  it('never builds a URL from a non-UUID saleRef', async () => {
    const backend = new FakeBackend();
    const client = clientFor(backend);
    const evil = '../../../api/method/frappe.client.get';
    await expect(
      client.recordReturn({ saleRef: evil, bodyJson: BODY, idempotencyKey: KEY, resend: false }),
    ).resolves.toEqual({ kind: 'refused', reason: 'returns_unavailable' });
    await expect(client.readSale(evil)).resolves.toEqual({
      kind: 'refused',
      reason: 'returns_unavailable',
    });
    expect(backend.calls).toHaveLength(0);
  });
});

describe('recordReturn — a resend never turns a pre-replay answer into a refusal (P1)', () => {
  it.each<[number, string]>([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('a resend that gets %s (%s) is unknown, not refused', async (status, code) => {
    const backend = new FakeBackend();
    backend.onReturn = () => jsonResponse(status, errorBody(code));
    await expect(record(backend, true)).resolves.toEqual({ kind: 'unknown' });
  });

  it.each<[number, string, ServerReturnRefusal]>([
    [400, 'validation_error', 'validation_error'],
    [409, 'over_return', 'over_return'],
    [422, 'return_tender_mismatch', 'return_tender_mismatch'],
  ])(
    'a resend that gets %s %s is still refused (decided after the replay)',
    async (status, code, reason) => {
      const backend = new FakeBackend();
      backend.onReturn = () => jsonResponse(status, errorBody(code));
      await expect(record(backend, true)).resolves.toEqual({ kind: 'refused', reason });
    },
  );

  it('a first send that gets 401 is refused (unchanged)', async () => {
    const backend = new FakeBackend();
    backend.onReturn = () => jsonResponse(401, errorBody('unauthorized'));
    await expect(record(backend)).resolves.toEqual({ kind: 'refused', reason: 'unauthorized' });
  });
});

describe('readSale', () => {
  it.each<[string, Response, unknown]>([
    [
      'a 404',
      jsonResponse(404, errorBody('not_found')),
      { kind: 'refused', reason: 'returns_unavailable' },
    ],
    [
      'a 401',
      jsonResponse(401, errorBody('unauthorized')),
      { kind: 'refused', reason: 'unauthorized' },
    ],
    ['a 503', jsonResponse(503, errorBody('internal_error')), { kind: 'unavailable' }],
  ])('maps %s', async (_label, response, expected) => {
    const backend = new FakeBackend();
    backend.sale = response;
    await expect(clientFor(backend).readSale(SALE_REF)).resolves.toEqual(expected);
  });

  it('GETs the sale with the envelope only', async () => {
    const backend = new FakeBackend();
    await expect(clientFor(backend).readSale(SALE_REF)).resolves.toMatchObject({ kind: 'ok' });
    expect(backend.calls[0]).toEqual({
      url: `${BASE_URL}/api/pos/v1/sales/${SALE_REF}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${ENVELOPE}` },
      body: undefined,
    });
  });
});

describe('AC7 — Backend-Core only, never ERPNext / Frappe', () => {
  const ERP = /erpnext|frappe|\/api\/method\/|\/api\/resource\//i;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceDir = path.resolve(here, '..');

  it('no return-domain source names an ERPNext / Frappe host or API', () => {
    const sources = readdirSync(sourceDir).filter((f) => f.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const code = readFileSync(path.join(sourceDir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(ERP);
    }
  });

  it('every request the client makes targets Backend-Core /api/pos/v1/sales/', async () => {
    const backend = new FakeBackend();
    const client = clientFor(backend);
    await client.readSale(SALE_REF);
    await client.recordReturn({
      saleRef: SALE_REF,
      bodyJson: BODY,
      idempotencyKey: KEY,
      resend: false,
    });
    expect(backend.calls).toHaveLength(2);
    for (const call of backend.calls) {
      expect(call.url.startsWith(`${BASE_URL}/api/pos/v1/sales/${SALE_REF}`)).toBe(true);
      expect(call.url).not.toMatch(ERP);
    }
  });
});
