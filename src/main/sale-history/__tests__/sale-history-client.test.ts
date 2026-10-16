import { describe, expect, it, vi } from 'vitest';

import { createSaleHistoryClient, type SaleHistoryCredential } from '../sale-history-client.js';
import { SALE_REF, wireDetail, wirePage, wireReprint } from './__helpers__/wire-fixtures.js';

const BASE = 'https://bc.test/';
const ENVELOPE: SaleHistoryCredential = { kind: 'envelope', token: 'env-token' };
const ADMISSION = '0190a3c4-0000-4000-8000-00000000ad01';
const DEVICE: SaleHistoryCredential = {
  kind: 'device',
  token: 'device-token',
  admissionId: ADMISSION,
};
const QUERY = { from: '2026-10-01', to: '2026-10-16', pageSize: 50, cursor: null };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? '' : JSON.stringify(body), { status, headers }),
    ),
  );
}

function requestOf(fetch: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

function headersOf(fetch: ReturnType<typeof vi.fn>): Record<string, string> {
  return requestOf(fetch).init.headers as Record<string, string>;
}

describe('RT-542 sale-history client — credentials', () => {
  it('sends the envelope alone on the manager/admin path', async () => {
    const fetch = respond(200, wirePage());
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    await client.list(QUERY, ENVELOPE);
    expect(headersOf(fetch)).toEqual({ Authorization: 'Bearer env-token' });
  });

  it('sends the device token with X-Cashier-Admission on the cashier path', async () => {
    const fetch = respond(200, wirePage({ visibility: 'own_sales' }));
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    await client.list(QUERY, DEVICE);
    expect(headersOf(fetch)).toEqual({
      Authorization: 'Bearer device-token',
      'X-Cashier-Admission': ADMISSION,
    });
  });

  it('makes no request without a usable credential', async () => {
    const fetch = respond(200, wirePage());
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(await client.list(QUERY, { kind: 'envelope', token: '' })).toEqual({
      kind: 'unreachable',
    });
    expect(
      await client.read(SALE_REF, { kind: 'device', token: 't', admissionId: 'not-a-uuid' }),
    ).toEqual({ kind: 'unreachable' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('RT-542 sale-history client — list', () => {
  it('builds the contract query and maps the page', async () => {
    const fetch = respond(200, wirePage({ nextCursor: 'next_1' }));
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    const outcome = await client.list({ ...QUERY, pageSize: 20, cursor: 'c_1' }, ENVELOPE);
    expect(requestOf(fetch).url).toBe(
      'https://bc.test/api/pos/v1/sale-history?from=2026-10-01&to=2026-10-16&page_size=20&cursor=c_1',
    );
    expect(requestOf(fetch).init.method).toBe('GET');
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.page.next_cursor).toBe('next_1');
  });

  it.each([
    [400, 'invalid'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
  ] as const)('maps %i to %s', async (status, kind) => {
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch: respond(status, {}) });
    expect(await client.list(QUERY, ENVELOPE)).toEqual({ kind });
  });

  it.each([409, 429, 500, 503])(
    'reports %i as a server error, not as no connection',
    async (status) => {
      const client = createSaleHistoryClient({ baseUrl: BASE, fetch: respond(status, {}) });
      expect(await client.list(QUERY, ENVELOPE)).toEqual({ kind: 'server_error' });
    },
  );

  it('stops reading a streamed body past the cap (no Content-Length)', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1_000_000)));
        if (pulled > 10) controller.close();
      },
    });
    const fetch = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(await client.list(QUERY, ENVELOPE)).toEqual({ kind: 'unreadable' });
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it('treats an oversized body as unreadable', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('x'.repeat(2_000_001), { status: 200 })),
    );
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(await client.list(QUERY, ENVELOPE)).toEqual({ kind: 'unreadable' });
  });

  it('caps a streamed body in bytes, not characters (Arabic text is 2 bytes a letter)', async () => {
    // 1.1 M letters: under 2 M characters, but 2.2 MB on the wire.
    const body = new TextEncoder().encode('م'.repeat(1_100_000));
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(new Blob([body]).stream(), { status: 200 })),
    );
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(await client.list(QUERY, ENVELOPE)).toEqual({ kind: 'unreadable' });
  });

  it('treats a network failure as unreachable and an off-contract 200 as unreadable', async () => {
    const down = createSaleHistoryClient({
      baseUrl: BASE,
      fetch: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    });
    expect(await down.list(QUERY, ENVELOPE)).toEqual({ kind: 'unreachable' });
    const odd = createSaleHistoryClient({ baseUrl: BASE, fetch: respond(200, { items: 'x' }) });
    expect(await odd.list(QUERY, ENVELOPE)).toEqual({ kind: 'unreadable' });
  });
});

describe('RT-542 sale-history client — detail', () => {
  it('reads one sale by its ref', async () => {
    const fetch = respond(200, wireDetail());
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    const outcome = await client.read(SALE_REF, ENVELOPE);
    expect(requestOf(fetch).url).toBe(`https://bc.test/api/pos/v1/sale-history/${SALE_REF}`);
    expect(outcome.kind).toBe('ok');
  });

  it('maps the non-disclosing 404 and never requests a malformed ref', async () => {
    const fetch = respond(404, {});
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(await client.read(SALE_REF, ENVELOPE)).toEqual({ kind: 'not_found' });
    expect(await client.read('../x', ENVELOPE)).toEqual({ kind: 'not_found' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('RT-542 sale-history client — reprint authorize', () => {
  const REQUEST = {
    saleRef: SALE_REF,
    kind: 'duplicate' as const,
    printedAt: '2026-10-16T11:00:00.000Z',
    idempotencyKey: 'pos-pulse-reprint:0190a3c4-0000-4000-8000-000000000001',
  };

  it('POSTs mode authorize with the Idempotency-Key and no localCopyNumber', async () => {
    const fetch = respond(201, wireReprint());
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    const outcome = await client.authorizeReprint(REQUEST, DEVICE);
    const { url, init } = requestOf(fetch);
    expect(url).toBe(`https://bc.test/api/pos/v1/sale-history/${SALE_REF}/reprints`);
    expect(init.method).toBe('POST');
    expect(headersOf(fetch)['Idempotency-Key']).toBe(REQUEST.idempotencyKey);
    expect(headersOf(fetch)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      mode: 'authorize',
      kind: 'duplicate',
      printedAt: '2026-10-16T11:00:00.000Z',
    });
    expect(outcome).toMatchObject({ kind: 'ok', reprint: { copy_number: 2 } });
  });

  it.each([
    [422, 'duplicate_unavailable'],
    [404, 'not_found'],
    [403, 'unauthorized'],
    [400, 'invalid'],
  ] as const)('maps %i to %s', async (status, kind) => {
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch: respond(status, {}) });
    expect(await client.authorizeReprint(REQUEST, ENVELOPE)).toEqual({ kind });
  });

  it('refuses a key outside the contract charset before any request', async () => {
    const fetch = respond(201, wireReprint());
    const client = createSaleHistoryClient({ baseUrl: BASE, fetch });
    expect(
      await client.authorizeReprint({ ...REQUEST, idempotencyKey: 'short' }, ENVELOPE),
    ).toEqual({
      kind: 'invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
