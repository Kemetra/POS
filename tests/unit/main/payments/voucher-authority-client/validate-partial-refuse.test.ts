/**
 * 006 T211 — `vouchers.validate` partial-redemption refuse-not-cap (RED).
 *
 * Asserts (research §R-7): when the cashier-supplied
 * `applied_amount_minor` exceeds the authoritative voucher balance OR
 * the cart's `remaining_balance_minor`, Data-Pulse-2 refuses with
 * `non_cash_overpayment_refused`. The client MUST surface the refusal
 * verbatim — POS-Pulse must NOT cap the amount client-side, because
 * the no-residual-voucher decision is authority-side.
 *
 * Wave 3 RED.
 */
import { describe, expect, it } from 'vitest';

import { validateVoucher } from '../../../../../src/main/payments/voucher-authority-client/validate.js';

import {
  BASE_URL,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_PAYMENT_ATTEMPT_ID,
  captureFetch,
  errorBody,
  jsonResponse,
  makeLogger,
} from './_fixtures.js';

const OVERPAYMENT_INPUT = {
  code: 'V-BIG',
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  // Cashier requested 10_000 but cart only owes 2_000 → authority refuses.
  applied_amount_minor: 10_000,
  remaining_balance_minor: 2_000,
};

describe('validateVoucher — partial-redemption refuse-not-cap (R-7)', () => {
  it('returns the non_cash_overpayment_refused refusal without modifying the amount', async () => {
    const { fetchImpl, captured } = captureFetch(
      jsonResponse(errorBody('non_cash_overpayment_refused'), 400),
    );
    const result = await validateVoucher(OVERPAYMENT_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });

    // Client sent the cashier's amount verbatim — no client-side cap.
    expect(captured).toHaveLength(1);
    const rawBody = captured[0]?.init.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse(rawBody as string) as {
      applied_amount_minor: number;
      remaining_balance_minor: number;
    };
    expect(body.applied_amount_minor).toBe(10_000);
    expect(body.remaining_balance_minor).toBe(2_000);

    // Refusal surfaced verbatim — no client-side retry, no amount mutation.
    expect(result).toEqual({ kind: 'refused', reason: 'non_cash_overpayment_refused' });
  });

  it('does not attempt a second call after a non_cash_overpayment_refused', async () => {
    // If the client foolishly capped + retried, captured.length would be 2.
    const { fetchImpl, captured } = captureFetch(
      jsonResponse(errorBody('non_cash_overpayment_refused'), 400),
    );
    await validateVoucher(OVERPAYMENT_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(captured).toHaveLength(1);
  });
});
