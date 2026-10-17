/**
 * RT-602 (VN-S6 S6-1b, doc 24 §2.3, §2.5) — the active liveness probe.
 *
 * One GET of Backend-Core's public liveness endpoint, with NO credential.
 * Alive means HTTP 200 with `{"status":"ok"}` (RT-600); the result is
 * "reachable", never "can sync". The outcome is reported in the monitor's
 * observation vocabulary:
 *  - alive                                  → an answer with status 200 (reachable);
 *  - 5xx / 429                              → that answer (degraded);
 *  - any other answer, or a 200 without the
 *    liveness body (an edge, proxy or portal) → `not_backend_core` (degraded);
 *  - no answer before the timeout, or a
 *    network error                          → `transport_fault` (offline);
 *  - headers in time, body too slow         → `not_backend_core` (degraded).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  LIVENESS_PATH,
  LIVENESS_PROBE_DEFAULTS,
  livenessUrl,
  runLivenessProbe,
} from '../liveness-probe.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const BASE = 'https://backend.example';

/** The init of the single recorded call. */
function onlyInit(calls: ReadonlyArray<{ init: RequestInit | undefined }>): RequestInit {
  return calls[0]?.init ?? {};
}

/** The URL a fetch was called with. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A fake timer pair: the probe's timeout fires only when the test says so. */
function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cleared: false, unref: () => undefined };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    fire() {
      for (const entry of pending) if (!entry.cleared) entry.fn();
    },
  };
}

/** A fetch that never answers until its signal aborts. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

function probe(fetchImpl: FetchLike, timers = fakeTimers(), baseUrl = BASE) {
  return runLivenessProbe({
    fetch: fetchImpl,
    baseUrl,
    timeoutMs: LIVENESS_PROBE_DEFAULTS.timeoutMs,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('RT-602 liveness probe — target and cadence constants', () => {
  it('targets the Backend-Core liveness path (RT-600)', () => {
    expect(LIVENESS_PATH).toBe('/api/v1/health/live');
  });

  it('uses the approved §2.5 cadence (D-6-3)', () => {
    expect(LIVENESS_PROBE_DEFAULTS).toEqual({
      intervalMs: 10_000,
      timeoutMs: 4_000,
      confirmDelayMs: 3_000,
    });
  });

  it.each([
    ['https://backend.example', 'https://backend.example/api/v1/health/live'],
    ['https://backend.example/', 'https://backend.example/api/v1/health/live'],
    ['https://backend.example/edge', 'https://backend.example/edge/api/v1/health/live'],
  ])('joins %s onto the path', (base, expected) => {
    expect(livenessUrl(base)).toBe(expected);
  });
});

describe('RT-602 liveness probe — the request', () => {
  it('sends one credential-free GET with a timeout signal and no redirect following', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(json({ status: 'ok' }));
    };
    await probe(fetchImpl);

    expect(calls.map((c) => c.url)).toEqual(['https://backend.example/api/v1/health/live']);
    const init = onlyInit(calls);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect([...headers.keys()]).toEqual(['accept']);
  });

  it('arms the timeout at the configured value and clears it after an answer', async () => {
    const timers = fakeTimers();
    await probe(() => Promise.resolve(json({ status: 'ok' })), timers);
    expect(timers.pending.map((p) => p.ms)).toEqual([4_000]);
    expect(timers.pending.every((p) => p.cleared)).toBe(true);
  });
});

describe('RT-602 liveness probe — outcome → observation', () => {
  it('200 with {"status":"ok"} is reachable', async () => {
    await expect(probe(() => Promise.resolve(json({ status: 'ok' })))).resolves.toEqual({
      kind: 'answer',
      status: 200,
    });
  });

  it.each([
    ['a wrong status value', json({ status: 'degraded' })],
    ['an empty body', new Response(null, { status: 200 })],
    ['an HTML portal page', new Response('<html>login</html>', { status: 200 })],
    ['a JSON array', json(['ok'])],
    ['a 204', new Response(null, { status: 204 })],
    ['a redirect', new Response(null, { status: 302, headers: { location: 'https://portal' } })],
    ['a 404', json({ message: 'not found' }, 404)],
    ['a 401', json({ message: 'nope' }, 401)],
  ])('%s is not Backend-Core liveness (degraded)', async (_label, response) => {
    await expect(probe(() => Promise.resolve(response))).resolves.toEqual({
      kind: 'not_backend_core',
    });
  });

  it.each([500, 502, 503, 504, 521, 429])('HTTP %i is reported as that answer', async (status) => {
    await expect(probe(() => Promise.resolve(json({ status: 'ok' }, status)))).resolves.toEqual({
      kind: 'answer',
      status,
    });
  });

  it('a network error is a transport fault', async () => {
    await expect(probe(() => Promise.reject(new TypeError('fetch failed')))).resolves.toEqual({
      kind: 'transport_fault',
    });
  });

  it('no answer before the timeout is a transport fault', async () => {
    const timers = fakeTimers();
    const result = probe(hangingFetch, timers);
    timers.fire();
    await expect(result).resolves.toEqual({ kind: 'transport_fault' });
  });

  it('headers in time but the body too slow is degraded, not offline', async () => {
    const timers = fakeTimers();
    const slowBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetchImpl: FetchLike = (_input, init) => {
      const response = new Response(slowBody, { status: 200 });
      init?.signal?.addEventListener('abort', () => {
        void slowBody.cancel().catch(() => undefined);
      });
      return Promise.resolve(response);
    };
    const result = probe(fetchImpl, timers);
    await vi.waitFor(() => {
      expect(timers.pending).toHaveLength(1);
    });
    await Promise.resolve();
    timers.fire();
    await expect(result).resolves.toEqual({ kind: 'not_backend_core' });
  });

  it('an external abort (stop on quit) is reported as no evidence', async () => {
    const controller = new AbortController();
    const result = runLivenessProbe({
      fetch: hangingFetch,
      baseUrl: BASE,
      timeoutMs: 4_000,
      signal: controller.signal,
      setTimeout: fakeTimers().setTimeout,
      clearTimeout: () => undefined,
    });
    controller.abort();
    await expect(result).resolves.toBeNull();
  });

  it('an already-aborted signal makes no request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<FetchLike>();
    await expect(
      runLivenessProbe({
        fetch: fetchImpl,
        baseUrl: BASE,
        timeoutMs: 4_000,
        signal: controller.signal,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
