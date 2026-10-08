import { describe, expect, it, vi } from 'vitest';

import { createReadDownClient } from '../read-down-client.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';

/**
 * 010-pos-catalog-read-down-consumption T021 — live `ReadDownClient` tests.
 *
 * Verifies the request shape (path, device-token Authorization header), the
 * binding `CatalogSnapshotPage` envelope parse (`items` + `cursor`), the
 * cursor-pagination loop over `next_page_token` (accumulate `items`, carry the
 * shared `cursor` into `sourceSnapshotId`), and the transport-result union
 * mapping (ok / no_connection / failed). The device token is the sole credential;
 * it is attached to the outbound request and never surfaced on the returned union
 * (P7). Resolve-on-reachable / reject-only-on-transport: every reachable response
 * resolves to a typed result; only a transport fault maps to `no_connection`. A
 * mid-loop failure NEVER yields a partial snapshot (R3 full-replace).
 */

const BASE = 'https://example.invalid';
const SNAPSHOT_PATH = '/api/pos/v1/catalog/snapshot';
const TOKEN = 'device-token-xyz';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response | (() => never)): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    if (typeof response === 'function') return Promise.reject(new Error('network down'));
    return Promise.resolve(response.clone());
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

const ROW: SellableCatalogRow = {
  product_id: 'p1',
  sku: 'SKU-1',
  name: 'Paracetamol 500mg',
  aliases: ['6223000000001'],
  price: { amount: '12.50', currency_code: 'EGP' },
  tax_category: 'standard',
  active: true,
  row_cursor: 'rc-1',
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A `CatalogSnapshotPage` body. `next_page_token` defaults to null (last page). */
function page(items: unknown[], cursor: string, nextPageToken: string | null = null): unknown {
  return { items, cursor, next_page_token: nextPageToken };
}

/**
 * A fetch that returns a SCRIPTED sequence of responses (one per call), to drive
 * the pagination loop. A `() => never` entry rejects (transport fault) on that call.
 */
function scriptedFetch(responses: Array<Response | (() => never)>): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  let idx = 0;
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    const next = responses[idx];
    idx += 1;
    if (next === undefined) return Promise.reject(new Error('scriptedFetch: out of responses'));
    if (typeof next === 'function') return Promise.reject(new Error('network down'));
    return Promise.resolve(next.clone());
  };
  return { fetchImpl, captured };
}

describe('createReadDownClient — request shape', () => {
  it('GETs the snapshot path with the device token as a Bearer Authorization header', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse(page([ROW], 's1')));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    await client.fetchSnapshot();

    expect(captured).toHaveLength(1);
    const req = captured[0];
    if (req === undefined) throw new Error('test: no request captured');
    expect(req.url).toBe(`${BASE}${SNAPSHOT_PATH}`);
    expect(req.init.method).toBe('GET');
    expect(headerValue(req.init, 'Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse(page([], 's0')));
    const client = createReadDownClient({
      baseUrl: `${BASE}/`,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    await client.fetchSnapshot();

    expect(captured[0]?.url).toBe(`${BASE}${SNAPSHOT_PATH}`);
  });
});

describe('createReadDownClient — outcome mapping', () => {
  it('maps a reachable valid single-page snapshot to ok with items + cursor', async () => {
    const { fetchImpl } = captureFetch(okResponse(page([ROW], 's9')));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.sourceSnapshotId).toBe('s9'); // the page `cursor`
      expect(result.rows).toEqual([ROW]);
    }
  });

  it('treats an absent/empty cursor as a malformed page → failed', async () => {
    const { fetchImpl } = captureFetch(okResponse({ items: [ROW], next_page_token: null }));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
  });

  it('maps a transport fault (fetch rejects) to no_connection', async () => {
    const { fetchImpl } = captureFetch(() => {
      throw new Error('unused');
    });
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('no_connection');
  });

  it.each([403, 404, 500, 503])(
    'maps a non-2xx, non-401 response (%s) to failed',
    async (status) => {
      const { fetchImpl } = captureFetch(new Response('nope', { status }));
      const client = createReadDownClient({
        baseUrl: BASE,
        fetch: fetchImpl,
        getDeviceToken: () => Promise.resolve(TOKEN),
      });

      const result = await client.fetchSnapshot();
      expect(result.kind).toBe('failed');
    },
  );

  it('RT-215 decision 2: maps a 401 to device_unauthorized (distinct from failed)', async () => {
    const { fetchImpl } = captureFetch(new Response('nope', { status: 401 }));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('device_unauthorized');
  });

  it('RT-215 / Codex P2: the token is re-read before EVERY page; revoked between pages → page 2 is never sent', async () => {
    const tokens: (string | null)[] = [TOKEN, null];
    const getDeviceToken = vi.fn(() => Promise.resolve(tokens.shift() ?? null));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ items: [ROW], cursor: 's1', next_page_token: 'p2' })),
    );
    const client = createReadDownClient({ baseUrl: BASE, fetch: fetchImpl, getDeviceToken });

    const result = await client.fetchSnapshot();
    // Aborted like any failed fetch: the driver keeps the prior catalogue.
    expect(result.kind).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // page 2 never left the terminal
    expect(getDeviceToken).toHaveBeenCalledTimes(2);
  });

  it('RT-215 / Codex P2: a token read that throws between pages aborts the snapshot', async () => {
    let n = 0;
    const getDeviceToken = vi.fn(() => {
      n += 1;
      return n === 1 ? Promise.resolve(TOKEN) : Promise.reject(new Error('decrypt'));
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ items: [ROW], cursor: 's1', next_page_token: 'p2' })),
    );
    const client = createReadDownClient({ baseUrl: BASE, fetch: fetchImpl, getDeviceToken });
    await expect(client.fetchSnapshot()).resolves.toEqual({ kind: 'failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('RT-215: a 401 on a later page is device_unauthorized too (no partial snapshot)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? okResponse({ items: [ROW], cursor: 's1', next_page_token: 'p2' })
          : new Response('nope', { status: 401 }),
      );
    });
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('device_unauthorized');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a malformed (non-array items) body to failed', async () => {
    const { fetchImpl } = captureFetch(
      okResponse({ items: 'not-an-array', cursor: 's1', next_page_token: null }),
    );
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
  });

  it('rejects the whole snapshot (failed) when any row is structurally invalid', async () => {
    const { fetchImpl } = captureFetch(okResponse(page([ROW, { product_id: 'bad' }], 's1')));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
  });

  it('maps non-JSON body to failed', async () => {
    const { fetchImpl } = captureFetch(new Response('<<not json>>', { status: 200 }));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
  });
});

describe('createReadDownClient — cursor pagination', () => {
  const ROW2: SellableCatalogRow = {
    product_id: 'p2',
    sku: 'SKU-2',
    name: 'Aspirin 100mg',
    aliases: ['6223000000002'],
    price: { amount: '8.00', currency_code: 'EGP' },
    tax_category: 'standard',
    active: true,
    row_cursor: 'rc-2',
  };

  it('walks next_page_token, accumulating items across pages under one cursor', async () => {
    const { fetchImpl, captured } = scriptedFetch([
      okResponse(page([ROW], 'snap-1', 'tok-2')),
      okResponse(page([ROW2], 'snap-1', null)),
    ]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.rows).toEqual([ROW, ROW2]); // accumulated in page order
      expect(result.sourceSnapshotId).toBe('snap-1'); // shared cursor
    }
    // Page 1 has no page_token; page 2 carries the prior next_page_token.
    expect(captured).toHaveLength(2);
    expect(captured[0]?.url).toBe(`${BASE}${SNAPSHOT_PATH}`);
    expect(captured[1]?.url).toBe(`${BASE}${SNAPSHOT_PATH}?page_token=tok-2`);
  });

  it('treats an empty-string next_page_token as the last page', async () => {
    const { fetchImpl, captured } = scriptedFetch([okResponse(page([ROW], 'snap-1', ''))]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('ok');
    expect(captured).toHaveLength(1); // did NOT request another page
  });

  it('fails the whole fetch (no partial snapshot) when a later page is non-2xx', async () => {
    const { fetchImpl, captured } = scriptedFetch([
      okResponse(page([ROW], 'snap-1', 'tok-2')),
      new Response('boom', { status: 500 }),
    ]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed'); // NOT a partial ok with only page 1
    expect(captured).toHaveLength(2);
  });

  it('maps a mid-loop transport fault to no_connection', async () => {
    const { fetchImpl } = scriptedFetch([
      okResponse(page([ROW], 'snap-1', 'tok-2')),
      () => {
        throw new Error('unused');
      },
    ]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('no_connection');
  });

  it('fails (no mixed snapshot) when a later page reports a different cursor', async () => {
    const { fetchImpl, captured } = scriptedFetch([
      okResponse(page([ROW], 'snap-1', 'tok-2')),
      okResponse(page([ROW2], 'snap-2', null)), // cursor drifted from snap-1
    ]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed'); // NOT an ok stitched from two server states
    expect(captured).toHaveLength(2);
  });

  it('fails closed when the page cap is exhausted (server never sends a null token)', async () => {
    // Every page advertises a further page; with maxPages=2 the cap is hit before
    // any page signals the last one → failed (never a partial accumulated prefix).
    const { fetchImpl, captured } = scriptedFetch([
      okResponse(page([ROW], 'snap-1', 'tok-2')),
      okResponse(page([ROW2], 'snap-1', 'tok-3')),
    ]);
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(TOKEN),
      maxPages: 2,
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
    expect(captured).toHaveLength(2); // walked exactly maxPages, then failed closed
  });
});

describe('createReadDownClient — device token gating', () => {
  it('does not POST and returns failed when the device token is null (unpaired)', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse(page([], 's0')));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.resolve(null),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
    expect(captured).toHaveLength(0);
  });

  it('returns failed (no request) when the token read throws', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse(page([], 's0')));
    const client = createReadDownClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getDeviceToken: () => Promise.reject(new Error('secret store error')),
    });

    const result = await client.fetchSnapshot();
    expect(result.kind).toBe('failed');
    expect(captured).toHaveLength(0);
  });
});
