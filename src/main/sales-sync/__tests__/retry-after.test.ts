/**
 * RT-194 — 425 `idempotency_in_progress` (and 429) are transient and carry the
 * server's `Retry-After`.
 *
 * Locks down:
 *   • `parseRetryAfterMs`: delay-seconds and HTTP-date forms, clamped to
 *     [0, MAX_RETRY_AFTER_MS]; missing / invalid → undefined (normal backoff);
 *   • the live client: 425 with or without the Backend-Core body → `transient`,
 *     never `permanent`; the `Retry-After` header becomes `retryAfterMs`; the 425
 *     body is never read; 429 behaves the same.
 */
import { describe, expect, it } from 'vitest';

import { MAX_RETRY_AFTER_MS, parseRetryAfterMs } from '../retry-after.js';
import { classifyStatus, createSaleSyncClient } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';
import type { SaleSyncResult } from '../sale-sync-client-types.js';

const NOW_MS = Date.parse('2026-10-04T10:00:00.000Z');
/** Backend-Core `IdempotencyInterceptor.replyInProgress` body (Retry-After: 2). */
const IN_PROGRESS_BODY = JSON.stringify({ error: 'idempotency_in_progress', retryAfterSec: 2 });

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

describe('parseRetryAfterMs (RT-194)', () => {
  it.each<[string, string, number]>([
    ['delay-seconds', '2', 2_000],
    ['zero seconds', '0', 0],
    ['surrounding whitespace', ' 7 ', 7_000],
    ['an HTTP-date 30s ahead', 'Sun, 04 Oct 2026 10:00:30 GMT', 30_000],
    ['an HTTP-date in the past (→ 0)', 'Sun, 04 Oct 2026 09:59:00 GMT', 0],
    ['absurd seconds (clamped)', '86400', MAX_RETRY_AFTER_MS],
    ['an overflowing number (clamped)', '9'.repeat(400), MAX_RETRY_AFTER_MS],
    ['an HTTP-date a day ahead (clamped)', 'Mon, 05 Oct 2026 10:00:00 GMT', MAX_RETRY_AFTER_MS],
  ])('%s → %s ms', (_label, header, expected) => {
    expect(parseRetryAfterMs(header, NOW_MS)).toBe(expected);
  });

  it.each<[string, string | null]>([
    ['missing', null],
    ['empty', ''],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['garbage', 'soon'],
    ['a date-like word that does not parse', 'Someday, 99 Foo 2026'],
  ])('%s → undefined (normal backoff applies)', (_label, header) => {
    expect(parseRetryAfterMs(header, NOW_MS)).toBeUndefined();
  });

  it('caps at 5 minutes — the engine backoff ceiling and Backend-Core 429 clamp', () => {
    expect(MAX_RETRY_AFTER_MS).toBe(300_000);
  });
});

function post(response: () => Response): Promise<SaleSyncResult> {
  return createSaleSyncClient({
    baseUrl: 'https://example.invalid',
    fetch: () => Promise.resolve(response()),
    getOperatorToken: () => 'opaque-envelope',
    nowMs: () => NOW_MS,
  }).postSale(PAYLOAD);
}

function answer(status: number, body: string | null, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('createSaleSyncClient — 425 / 429 are transient with Retry-After (RT-194)', () => {
  it('classifyStatus(425) → transient, never permanent', () => {
    expect(classifyStatus(425)).toEqual({ kind: 'transient' });
    expect(classifyStatus(429)).toEqual({ kind: 'transient' });
  });

  it.each<[string, number, string | null, Record<string, string>, SaleSyncResult]>([
    [
      '425 idempotency_in_progress + Retry-After: 2',
      425,
      IN_PROGRESS_BODY,
      { 'Retry-After': '2' },
      { kind: 'transient', retryAfterMs: 2_000 },
    ],
    ['425 with no body and no header', 425, null, {}, { kind: 'transient' }],
    [
      '425 with an HTTP-date Retry-After',
      425,
      null,
      { 'Retry-After': 'Sun, 04 Oct 2026 10:00:05 GMT' },
      { kind: 'transient', retryAfterMs: 5_000 },
    ],
    [
      '425 with an invalid Retry-After',
      425,
      IN_PROGRESS_BODY,
      { 'Retry-After': 'later' },
      { kind: 'transient' },
    ],
    [
      '425 with an absurd Retry-After (clamped)',
      425,
      IN_PROGRESS_BODY,
      { 'Retry-After': '999999' },
      { kind: 'transient', retryAfterMs: MAX_RETRY_AFTER_MS },
    ],
    [
      '429 rate limit + Retry-After: 30',
      429,
      null,
      { 'Retry-After': '30' },
      { kind: 'transient', retryAfterMs: 30_000 },
    ],
    ['429 with no Retry-After', 429, null, {}, { kind: 'transient' }],
  ])('%s', async (_label, status, body, headers, expected) => {
    const result = await post(() => answer(status, body, headers));
    expect(result).toStrictEqual(expected);
  });

  it('a 425 body is never read (status and header alone decide)', async () => {
    const response = answer(425, IN_PROGRESS_BODY, { 'Retry-After': '2' });
    let bodyRead = false;
    response.text = () => {
      bodyRead = true;
      return Promise.reject(new Error('must not be read'));
    };
    const result = await post(() => response);
    expect(result).toStrictEqual({ kind: 'transient', retryAfterMs: 2_000 });
    expect(bodyRead).toBe(false);
  });

  it('Retry-After on another status is ignored (a 503 keeps the normal backoff)', async () => {
    const result = await post(() => answer(503, null, { 'Retry-After': '120' }));
    expect(result).toStrictEqual({ kind: 'transient' });
  });
});
