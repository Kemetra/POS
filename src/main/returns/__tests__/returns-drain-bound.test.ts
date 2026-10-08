import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DRAIN_MARGIN_MS } from '../../sales-sync/settled-within.js';
import { RETURNS_DRAIN_TIMEOUT_MS } from '../compose-returns.js';
import { createReturnsClient, RETURNS_REQUEST_TIMEOUT_MS } from '../returns-client.js';

/**
 * RT-17 follow-up (comment 10965) — the returns resolver's drain bound is
 * derived from the returns client's request timeout plus the shared drain
 * margin (the same pattern as the sale and shift drains), so the drain never
 * gives up before the client has aborted the request it is waiting on.
 */

const SALE_REF = '0192f5a2-3b4c-7d8e-9f01-0000000000aa';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RETURNS_DRAIN_TIMEOUT_MS — the drain outlasts the client request timeout', () => {
  it('is the client request timeout plus the shared margin', () => {
    expect(RETURNS_DRAIN_TIMEOUT_MS).toBe(RETURNS_REQUEST_TIMEOUT_MS + DRAIN_MARGIN_MS);
  });

  it('is never below the client request timeout', () => {
    expect(RETURNS_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(RETURNS_REQUEST_TIMEOUT_MS);
    expect(DRAIN_MARGIN_MS).toBeGreaterThan(0);
  });

  it('leaves the timeout itself at 15 s (only the drain bound is derived)', () => {
    expect(RETURNS_REQUEST_TIMEOUT_MS).toBe(15_000);
  });
});

describe('the returns client passes its exported timeout to AbortSignal.timeout', () => {
  it('uses RETURNS_REQUEST_TIMEOUT_MS when no timeout is injected', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = createReturnsClient({
      baseUrl: 'https://backend.example.test',
      fetch: () => Promise.resolve(new Response('{}', { status: 500 })),
    });
    await client.readSale(SALE_REF, 'token');
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(RETURNS_REQUEST_TIMEOUT_MS);
  });

  it('still honours an injected timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = createReturnsClient({
      baseUrl: 'https://backend.example.test',
      fetch: () => Promise.resolve(new Response('{}', { status: 500 })),
      timeoutMs: 123,
    });
    await client.readSale(SALE_REF, 'token');
    expect(timeout).toHaveBeenCalledWith(123);
  });
});

describe('main/index.ts bounds the returns drain by the exported constant', () => {
  // `index.ts` cannot be imported under vitest (it runs `app.whenReady()`).
  const source = readFileSync(resolve(__dirname, '../../index.ts'), 'utf-8');

  it('imports RETURNS_DRAIN_TIMEOUT_MS and defines no local copy', () => {
    expect(source).not.toMatch(/const RETURNS_DRAIN_TIMEOUT_MS\b/);
    expect(source).toMatch(
      /import \{[^}]*\bRETURNS_DRAIN_TIMEOUT_MS\b[^}]*\} from '\.\/returns\/compose-returns\.js';/,
    );
  });

  it('passes it as the resolver drain bound (no bare number)', () => {
    expect(source).toMatch(/drainTimeoutMs: RETURNS_DRAIN_TIMEOUT_MS,/);
    expect(source).not.toMatch(/drainTimeoutMs: \d/);
  });
});
