/**
 * 006 T210 — `vouchers.validate` client (RED).
 *
 * Asserts (per `specs/006-payments-tender/contracts/bridge-api.md`
 * §`vouchers.*` namespace + `scripts/openapi-snapshot.json`
 * `/api/pos/v1/vouchers/validate`):
 *
 *   1. Success path: POST to `/api/pos/v1/vouchers/validate` with
 *      `Idempotency-Key` header → returns the typed `validated`
 *      envelope verbatim from `PosValidateVoucherResponse`.
 *   2. Closed-set refusals: each of `voucher_not_found`,
 *      `voucher_expired`, `voucher_cancelled`,
 *      `voucher_already_redeemed`, `voucher_tenant_mismatch`,
 *      `voucher_branch_mismatch` returns
 *      `{ kind: 'refused', reason: <code> }`.
 *   3. **F-A4B-001 guard:** unknown `error.code` from Data-Pulse-2 must
 *      fall through to `{ kind: 'refused', reason: 'validation_failure' }`
 *      and emit a `logger.warn` for observability (defence-in-depth so
 *      a brand-new server-side code never silently slips past).
 *
 * Wave 3 RED. Forward-references `src/main/payments/voucher-authority-client/validate.ts`.
 */
import { describe, expect, it } from 'vitest';

import { validateVoucher } from '../../../../../src/main/payments/voucher-authority-client/validate.js';

import {
  BASE_URL,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_PAYMENT_ATTEMPT_ID,
  bareResponse,
  captureFetch,
  errorBody,
  jsonResponse,
  makeLogger,
} from './_fixtures.js';

const HAPPY_RESPONSE = {
  kind: 'validated' as const,
  applied_amount_minor: 1_500,
  intent_expires_at: '2026-06-01T10:05:00.000Z',
  redemption_intent_token: 'opaque-intent-token-AAA',
};

const VALIDATE_INPUT = {
  code: 'V-CODE-1',
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  applied_amount_minor: 1_500,
  remaining_balance_minor: 2_000,
};

describe('validateVoucher — happy path', () => {
  it('POSTs to /api/pos/v1/vouchers/validate with Idempotency-Key header and exact body', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(HAPPY_RESPONSE, 200));
    const logger = makeLogger();
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE_URL}/api/pos/v1/vouchers/validate`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBe(FAKE_IDEMPOTENCY_KEY);
    expect(call?.init.body).toBe(JSON.stringify(VALIDATE_INPUT));

    expect(result).toEqual({
      kind: 'validated',
      applied_amount_minor: 1_500,
      intent_expires_at: '2026-06-01T10:05:00.000Z',
      redemption_intent_token: 'opaque-intent-token-AAA',
    });
  });
});

describe('validateVoucher — closed-set refusal mapping', () => {
  const REFUSAL_CODES = [
    'voucher_not_found',
    'voucher_expired',
    'voucher_cancelled',
    'voucher_already_redeemed',
    'voucher_tenant_mismatch',
    'voucher_branch_mismatch',
  ] as const;

  for (const code of REFUSAL_CODES) {
    it(`maps Data-Pulse-2 400 ${code} → { kind: 'refused', reason: '${code}' }`, async () => {
      const { fetchImpl } = captureFetch(jsonResponse(errorBody(code), 400));
      const logger = makeLogger();
      const result = await validateVoucher(VALIDATE_INPUT, {
        baseUrl: BASE_URL,
        fetch: fetchImpl,
        logger,
        idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      });
      expect(result).toEqual({ kind: 'refused', reason: code });
    });
  }

  it('maps 404 voucher_not_found → { kind: "refused", reason: "voucher_not_found" }', async () => {
    // OpenAPI: validate 404 carries error.code = voucher_not_found.
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('voucher_not_found'), 404));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'voucher_not_found' });
  });

  it('F-A4B-001: unknown error.code falls through to validation_failure and warns', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('brand_new_2030_code'), 400));
    const logger = makeLogger();
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // First argument is a structured field bag — assert the unknown code is captured for ops.
    const firstCall = logger.warn.mock.calls[0] as [Record<string, unknown>, string] | undefined;
    expect(firstCall?.[0]).toMatchObject({ unknown_refusal_code: 'brand_new_2030_code' });
  });

  it('400 with no parsable JSON body → validation_failure refusal', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 400 }));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
  });
});

describe('validateVoucher — transport-tier outcomes', () => {
  it('network failure → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(new Error('ECONNREFUSED'));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('5xx → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(bareResponse(503));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('401 → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(bareResponse(401));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('425 Too Early (in-flight idempotency) → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(bareResponse(425));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('200 with malformed body (garbage JSON) → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(new Response('garbage', { status: 200 }));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('200 with body missing kind discriminator → { kind: "authority_unreachable" }', async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ some: 'other shape' }, 200));
    const result = await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });
});
