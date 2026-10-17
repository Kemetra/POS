import { describe, expect, it, vi } from 'vitest';

import { withRequestId } from '../request-id.js';

/**
 * RT-634 (OBS-5) — POS mints one `X-Request-Id` per Backend-Core HTTP call
 * (OBS-1 contract §2) and logs it locally so a POS log line joins a
 * Backend-Core log line.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function harness(response: Response | Error = new Response(null, { status: 201 })) {
  const inner = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const logger = { info: vi.fn(), debug: vi.fn() };
  let tick = 1000;
  const fetchImpl = withRequestId(inner, { logger, now: () => (tick += 5) });
  const headersOf = (call = 0): Headers => new Headers(inner.mock.calls[call]?.[1]?.headers);
  return { inner, logger, fetchImpl, headersOf };
}

describe('withRequestId', () => {
  it('adds a lowercase UUID v4 X-Request-Id', async () => {
    const h = harness();
    await h.fetchImpl('https://api.example/api/pos/v1/sales', { method: 'POST' });
    expect(h.headersOf().get('x-request-id')).toMatch(UUID_V4);
  });

  it('mints a fresh id for every call, retries included', async () => {
    const h = harness();
    await h.fetchImpl('https://api.example/a');
    await h.fetchImpl('https://api.example/a');
    expect(h.headersOf(0).get('x-request-id')).not.toBe(h.headersOf(1).get('x-request-id'));
  });

  it.each([
    ['plain object', { Authorization: 'Bearer t', 'Idempotency-Key': 'k'.repeat(20) }],
    [
      'array',
      [
        ['Authorization', 'Bearer t'],
        ['Idempotency-Key', 'k'.repeat(20)],
      ] as [string, string][],
    ],
    ['Headers', new Headers({ Authorization: 'Bearer t', 'Idempotency-Key': 'k'.repeat(20) })],
  ])('keeps existing %s headers', async (_label, headers) => {
    const h = harness();
    await h.fetchImpl('https://api.example/a', { method: 'POST', headers, body: '{}' });
    const sent = h.headersOf();
    expect(sent.get('authorization')).toBe('Bearer t');
    expect(sent.get('idempotency-key')).toBe('k'.repeat(20));
    expect(sent.get('x-request-id')).toMatch(UUID_V4);
    expect(h.inner.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  it('keeps the headers of a Request input', async () => {
    const h = harness();
    await h.fetchImpl(
      new Request('https://api.example/a', { headers: { Authorization: 'Bearer r' } }),
    );
    expect(h.headersOf().get('authorization')).toBe('Bearer r');
    expect(h.headersOf().get('x-request-id')).toMatch(UUID_V4);
  });

  it('does not mutate the caller init or headers object', async () => {
    const h = harness();
    const headers = { Authorization: 'Bearer t' };
    const init = { method: 'GET', headers };
    await h.fetchImpl('https://api.example/a', init);
    expect(headers).toEqual({ Authorization: 'Bearer t' });
    expect(init.headers).toBe(headers);
  });

  it('logs request_id, method, path without query, status and duration', async () => {
    const h = harness();
    await h.fetchImpl('https://api.example/api/pos/v1/catalog/snapshot?cursor=secret', {
      method: 'get',
    });
    const id = h.headersOf().get('x-request-id');
    expect(h.logger.info).toHaveBeenCalledWith(
      {
        request_id: id,
        method: 'GET',
        path: '/api/pos/v1/catalog/snapshot',
        status: 201,
        duration_ms: 5,
      },
      'backend:request',
    );
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain('secret');
  });

  it('logs a transport fault and rethrows it unchanged', async () => {
    const fault = new TypeError('fetch failed');
    const h = harness(fault);
    await expect(h.fetchImpl('https://api.example/a')).rejects.toBe(fault);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/a', outcome: 'transport_error' }),
      'backend:request',
    );
  });

  it('quiet mode logs at debug (the idle liveness probe)', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const logger = { info: vi.fn(), debug: vi.fn() };
    await withRequestId(inner, { logger, quiet: true })('https://api.example/health');
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a throwing logger never breaks the call', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const logger = {
      info: vi.fn(() => {
        throw new Error('disk full');
      }),
      debug: vi.fn(),
    };
    const res = await withRequestId(inner, { logger })('https://api.example/a');
    expect(res.status).toBe(200);
  });
});
