/**
 * 006 Wave 3 — shared test fixtures for voucher V-A client tests.
 *
 * Provides `captureFetch` (used in 004 backend-client tests) and a
 * `makeLogger` factory matching the pino-style `(fields, msg)` shape
 * used by `src/main/observability/sentry-main.ts`. Local to the
 * voucher-authority-client test directory; not exported beyond it.
 */
import { vi } from 'vitest';

import type { components } from '../../../../../src/shared/api-types.js';

type ErrorBody = components['schemas']['Error'];

export interface CapturedRequest {
  url: string;
  init: RequestInit;
}

export interface CaptureFetchResult {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
}

/**
 * Build a fetch double that captures every call and replays the given
 * sequence of responses (one per call). If `responses` has a single
 * entry it is reused for every call. If a response slot is an `Error`,
 * fetch rejects with it (transport failure).
 */
export function captureFetch(...responses: Array<Response | Error>): CaptureFetchResult {
  const captured: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    const slot = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (slot instanceof Error) return Promise.reject(slot);
    if (slot === undefined) throw new Error('captureFetch: no response configured');
    return Promise.resolve(slot.clone());
  };
  return { fetchImpl, captured };
}

function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface TestLogger {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

/** pino-style `(fields, msg)` logger with `vi.fn` spies. */
export function makeLogger(): TestLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

/** Build the Error envelope returned by Data-Pulse-2 on 4xx. */
export function errorBody(code: string, message = 'refused'): ErrorBody {
  return { error: { code, message } };
}

/** Build a JSON `Response` with the given body and status. */
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Empty body 5xx / 401 response for transport-tier failures. */
export function bareResponse(status: number): Response {
  return new Response('', { status });
}

export const BASE_URL = 'https://api.example.test';

/** Reusable canonical UUIDs. */
export const FAKE_IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';
export const FAKE_PAYMENT_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
export const FAKE_REDEMPTION_ID = '33333333-3333-4333-8333-333333333333';
