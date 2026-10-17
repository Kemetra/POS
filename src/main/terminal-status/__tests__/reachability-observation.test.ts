/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.3, §2.4, §5.1 "Classification") — the
 * transport-level observation seam and the answer classification.
 *
 *  - The seam OBSERVES only: the response object and the rejection reach the
 *    caller untouched, and a failing observer never breaks the call.
 *  - Classification is by transport outcome, never by the client result union:
 *    a missing token, a missing device token or a terminal change makes no
 *    request, so it can never feed `transport_fault`.
 *  - 521/502/503/504/429 are server failures (→ degraded). A Backend-Core 401
 *    counts as reachable.
 */
import { describe, expect, it, vi } from 'vitest';

import { classifyObservation, withReachabilityObservation } from '../reachability-observation.js';
import type { ReachabilityObservation } from '../terminal-status-monitor.js';
import { createSaleSyncClient } from '../../sales-sync/create-sale-sync-client.js';
import type { CaptureSalePayload } from '../../sales-sync/capture-payload.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe('RT-601 classifyObservation', () => {
  it.each([200, 201, 204, 299])('%i → reachable', (status) => {
    expect(classifyObservation({ kind: 'answer', status })).toBe('reachable');
  });

  it.each([401, 403, 404, 409, 422])('Backend-Core %i → reachable', (status) => {
    expect(classifyObservation({ kind: 'answer', status })).toBe('reachable');
  });

  it.each([429, 500, 502, 503, 504, 521, 599])('%i → server_failure', (status) => {
    expect(classifyObservation({ kind: 'answer', status })).toBe('server_failure');
  });

  it.each([100, 301, 304, 400, 405, 408, 413, 425])('%i → ignored (no evidence)', (status) => {
    expect(classifyObservation({ kind: 'answer', status })).toBe('ignored');
  });

  it('a transport fault → transport_fault', () => {
    expect(classifyObservation({ kind: 'transport_fault' })).toBe('transport_fault');
  });

  it('RT-602: an answer that is not Backend-Core liveness → server_failure', () => {
    expect(classifyObservation({ kind: 'not_backend_core' })).toBe('server_failure');
  });
});

/** Run one call through the seam; returns what the observer saw and the outcome. */
async function observeOnce(
  inner: FetchLike,
  observer?: (o: ReachabilityObservation) => void,
  init?: RequestInit,
): Promise<{ seen: ReachabilityObservation[]; outcome: PromiseSettledResult<Response> }> {
  const seen: ReachabilityObservation[] = [];
  const observed = withReachabilityObservation(inner, observer ?? ((o) => seen.push(o)));
  const [outcome] = await Promise.allSettled([observed('https://backend.example/x', init)]);
  return { seen, outcome };
}

/** Assert the call settled with exactly this object (identity, not structure). */
function expectSettledWith(
  outcome: PromiseSettledResult<Response>,
  status: 'fulfilled' | 'rejected',
  value: unknown,
): void {
  expect(outcome.status).toBe(status);
  expect(outcome.status === 'fulfilled' ? outcome.value : outcome.reason).toBe(value);
}

const throwingObserver = (): void => {
  throw new Error('observer boom');
};

describe('RT-601 withReachabilityObservation — observe only', () => {
  it('returns the very same response object, unread, and reports its status', async () => {
    const response = new Response('{"ok":true}', { status: 201 });
    const inner = vi.fn<FetchLike>(() => Promise.resolve(response));
    const init: RequestInit = { method: 'POST', body: 'x' };

    const { seen, outcome } = await observeOnce(inner, undefined, init);

    expectSettledWith(outcome, 'fulfilled', response);
    expect(response.bodyUsed).toBe(false);
    expect(inner).toHaveBeenCalledWith('https://backend.example/x', init);
    expect(seen).toEqual([{ kind: 'answer', status: 201 }]);
  });

  it.each([
    ['a network failure', new TypeError('fetch failed')],
    ['a timeout abort', new DOMException('aborted due to timeout', 'TimeoutError')],
  ])('%s: rethrows the very same rejection and reports a transport fault', async (_n, err) => {
    const { seen, outcome } = await observeOnce(() => Promise.reject(err));
    expectSettledWith(outcome, 'rejected', err);
    expect(seen).toEqual([{ kind: 'transport_fault' }]);
  });

  it('a throwing observer never breaks an answered call', async () => {
    const response = new Response(null, { status: 200 });
    const { outcome } = await observeOnce(() => Promise.resolve(response), throwingObserver);
    expectSettledWith(outcome, 'fulfilled', response);
  });

  it('a throwing observer never replaces the transport rejection', async () => {
    const boom = new TypeError('fetch failed');
    const { outcome } = await observeOnce(() => Promise.reject(boom), throwingObserver);
    expectSettledWith(outcome, 'rejected', boom);
  });

  it('reports nothing about the request: no URL, host or header reaches the observer', async () => {
    const seen: unknown[] = [];
    const observed = withReachabilityObservation(
      () => Promise.resolve(new Response(null, { status: 503 })),
      (o) => seen.push(o),
    );
    await observed('https://secret-host.example/api?token=abc', {
      headers: { Authorization: 'Bearer abc' },
    });
    expect(JSON.stringify(seen)).not.toMatch(/secret-host|token|Bearer|abc/);
  });
});

describe('RT-601 — a missing credential or a terminal change never feeds transport_fault', () => {
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
        lineName: 'Item',
        quantity: 1,
        unitPriceMinor: 1000,
        lineAmountMinor: 1000,
      },
    ],
  };

  function observedClient(overrides: {
    getOperatorToken?: () => string | null;
    getDeviceToken?: () => Promise<string | null>;
    currentTerminalId?: () => string | null;
  }) {
    const seen: ReachabilityObservation[] = [];
    const inner = vi.fn<FetchLike>(() => Promise.reject(new TypeError('fetch failed')));
    const fetch = withReachabilityObservation(inner, (o) => seen.push(o));
    const client = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch,
      deviceFetch: fetch,
      getOperatorToken: overrides.getOperatorToken ?? (() => 'envelope'),
      getDeviceToken: overrides.getDeviceToken ?? (() => Promise.resolve('device-token')),
      currentTerminalId: overrides.currentTerminalId ?? (() => 'term-1'),
    });
    return { client, seen, inner };
  }

  type Client = ReturnType<typeof observedClient>['client'];
  it.each([
    {
      name: 'no operator token',
      overrides: { getOperatorToken: () => null },
      send: (c: Client) => c.postSale(PAYLOAD),
    },
    {
      name: 'no device token',
      overrides: { getDeviceToken: () => Promise.resolve(null) },
      send: (c: Client) => c.postSaleAsCashier(PAYLOAD, 'user-1'),
    },
    {
      name: 'terminal changed before the send',
      overrides: { currentTerminalId: () => 'term-2' },
      send: (c: Client) => c.postSaleAsCashier(PAYLOAD, 'user-1'),
    },
  ])('$name: the client answers no_connection, but nothing is observed', async (c) => {
    const { client, seen, inner } = observedClient(c.overrides);
    await expect(c.send(client)).resolves.toEqual({ kind: 'no_connection' });
    expect(inner).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('a real transport failure under the same client IS observed', async () => {
    const { client, seen } = observedClient({});
    await expect(client.postSale(PAYLOAD)).resolves.toEqual({ kind: 'no_connection' });
    expect(seen).toEqual([{ kind: 'transport_fault' }]);
  });
});
