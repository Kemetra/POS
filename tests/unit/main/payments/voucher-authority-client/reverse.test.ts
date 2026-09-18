/**
 * 006 T213 — `vouchers.reverse` client (RED).
 *
 * Asserts (per contracts/bridge-api.md §`vouchers.reverse` +
 * `scripts/openapi-snapshot.json` `/api/pos/v1/vouchers/reverse` + R-13
 * deferred-reversal posture):
 *
 *   1. Success: POSTs `/api/pos/v1/vouchers/reverse` with the
 *      `Idempotency-Key` header (mutating); returns the typed
 *      `reversed` envelope with `already_reversed: false` on first
 *      call.
 *   2. Idempotent replay: same Idempotency-Key + same body returns
 *      `already_reversed: true`.
 *   3. Closed-set refusal: `redemption_not_found` 404 surfaces as
 *      `{ kind: 'refused', reason: 'redemption_not_found' }`.
 *   4. **Authority-unreachable sentinel (R-13):** transport failure
 *      (timeout / ECONNREFUSED / 5xx / 425 Too Early) MUST resolve to
 *      `{ kind: 'authority_unreachable' }` so the Wave-4 FSM consumer
 *      can drive `applied → reversal_pending`. The client itself MUST
 *      NOT touch the FSM — that is Wave 4 scope.
 *
 * Wave 3 RED.
 */
import { describe, expect, it } from 'vitest';

import { reverseVoucher } from '../../../../../src/main/payments/voucher-authority-client/reverse.js';

import {
  BASE_URL,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_REDEMPTION_ID,
  bareResponse,
  captureFetch,
  errorBody,
  jsonResponse,
  makeLogger,
} from './_fixtures.js';

const REVERSE_INPUT = { redemption_id: FAKE_REDEMPTION_ID };

const REVERSE_OK = {
  kind: 'reversed' as const,
  redemption_id: FAKE_REDEMPTION_ID,
  reversed_at: '2026-06-01T10:10:00.000Z',
  already_reversed: false,
};

const REVERSE_REPLAY = { ...REVERSE_OK, already_reversed: true };

describe('reverseVoucher — happy path', () => {
  it('POSTs /vouchers/reverse with Idempotency-Key and returns reversed envelope', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(REVERSE_OK, 200));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE_URL}/api/pos/v1/vouchers/reverse`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(FAKE_IDEMPOTENCY_KEY);
    expect(call?.init.body).toBe(JSON.stringify(REVERSE_INPUT));
    expect(result).toEqual(REVERSE_OK);
  });
});

describe('reverseVoucher — idempotent replay', () => {
  it('returns already_reversed: true from the body', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(REVERSE_REPLAY, 200));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result.kind).toBe('reversed');
    if (result.kind === 'reversed') {
      expect(result.already_reversed).toBe(true);
    }
  });
});

describe('reverseVoucher — refusal mapping', () => {
  it('maps 404 redemption_not_found → refused', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('redemption_not_found'), 404));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'redemption_not_found' });
  });

  it('maps 400 validation_failure → refused', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('validation_failure'), 400));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
  });
});

describe('reverseVoucher — malformed responses', () => {
  it('200 with garbage JSON body → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('200 with body missing kind discriminator → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ some: 'other shape' }, 200));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('400 with non-parsable body → validation_failure refusal', async () => {
    const { fetchImpl } = captureFetch(new Response('garbage', { status: 400 }));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
  });
});

describe('reverseVoucher — authority-unreachable sentinel (R-13 / FSM driver)', () => {
  it('network failure → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(new Error('ECONNREFUSED'));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('AbortSignal timeout (signal.aborted) → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(new DOMException('aborted', 'AbortError'));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('5xx → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(bareResponse(500));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('425 Too Early (idempotency in-flight) → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(bareResponse(425));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('sentinel is the ONLY signal on transport failure (no exception thrown)', async () => {
    // R-13 contract: the client must resolve, not reject, on transport
    // failure — the Wave-4 FSM consumer drives `applied →
    // reversal_pending` off this sentinel. Confirm the function never
    // throws and returns a structurally-stable sentinel.
    const { fetchImpl } = captureFetch(new Error('ECONNREFUSED'));
    const result = await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result.kind).toBe('authority_unreachable');
    // No other fields on the sentinel — it's literally `{ kind: ... }`.
    expect(Object.keys(result)).toEqual(['kind']);
  });
});
