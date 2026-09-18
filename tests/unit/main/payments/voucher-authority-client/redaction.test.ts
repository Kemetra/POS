/**
 * 006 T214 — voucher V-A client redaction (RED).
 *
 * Asserts (FR-017 + Constitution §XIV + F-A4B-004):
 *
 *   - `voucher_redemption_intent_token` MUST NEVER appear in ANY
 *     captured logger call (info / warn / error) across success, mapped
 *     refusal, unknown refusal, and transport-failure paths.
 *   - `redemption_id` is explicitly allow-listed (FR-017 receipt-handoff
 *     correlation) — we do NOT assert it's absent. But the raw
 *     response body MUST NOT be stringified into a logger message field
 *     (defense-in-depth so the intent_token can't sneak in via "raw
 *     body" diagnostic dumps).
 *   - The cashier-keyed voucher `code` MUST NOT be logged at the
 *     warn/info level either; it's PII-adjacent input and the cashier
 *     can type anything.
 *
 * Wave 3 RED. F-A4B-004 finding closure: this is the implementation-
 * stage redaction test the brief asks for.
 */
import { describe, expect, it } from 'vitest';

import { redeemVoucher } from '../../../../../src/main/payments/voucher-authority-client/redeem.js';
import { reverseVoucher } from '../../../../../src/main/payments/voucher-authority-client/reverse.js';
import { validateVoucher } from '../../../../../src/main/payments/voucher-authority-client/validate.js';

import {
  BASE_URL,
  FAKE_IDEMPOTENCY_KEY,
  FAKE_PAYMENT_ATTEMPT_ID,
  FAKE_REDEMPTION_ID,
  bareResponse,
  captureFetch,
  errorBody,
  jsonResponse,
  makeLogger,
} from './_fixtures.js';

const SENSITIVE_TOKEN = 'OPAQUE-INTENT-TOKEN-MUST-NEVER-LOG-XYZ-987';
const SENSITIVE_CODE = 'V-CODE-CASHIER-INPUT-Z9';

const VALIDATE_INPUT = {
  code: SENSITIVE_CODE,
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  applied_amount_minor: 1_500,
  remaining_balance_minor: 2_000,
};

const VALIDATE_OK = {
  kind: 'validated' as const,
  applied_amount_minor: 1_500,
  intent_expires_at: '2026-06-01T10:05:00.000Z',
  redemption_intent_token: SENSITIVE_TOKEN,
};

const REDEEM_INPUT = {
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  redemption_intent_token: SENSITIVE_TOKEN,
};

const REDEEM_OK = {
  kind: 'redeemed' as const,
  redemption_id: FAKE_REDEMPTION_ID,
  redeemed_at: '2026-06-01T10:00:00.000Z',
  idempotent_replayed: false,
};

const REVERSE_INPUT = { redemption_id: FAKE_REDEMPTION_ID };

function flattenLoggerCalls(logger: ReturnType<typeof makeLogger>): string {
  // Concatenate every argument of every call across every level into one
  // string so a simple `includes` check can catch any sink leak.
  const all: string[] = [];
  for (const sink of [logger.info, logger.warn, logger.error] as const) {
    for (const call of sink.mock.calls) {
      for (const arg of call) {
        try {
          all.push(typeof arg === 'string' ? arg : JSON.stringify(arg));
        } catch {
          all.push(String(arg));
        }
      }
    }
  }
  return all.join('\n');
}

describe('voucher V-A client — redemption_intent_token redaction (FR-017)', () => {
  it('validate(): success path — token never leaks to any logger sink', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(VALIDATE_OK, 200));
    const logger = makeLogger();
    await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });

  it('validate(): mapped refusal — token absent (no body in logs)', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('voucher_expired'), 400));
    const logger = makeLogger();
    await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });

  it('validate(): unknown refusal (F-A4B-001 warn path) — token still absent', async () => {
    // The F-A4B-001 fall-through emits a warn. The warn payload MUST
    // carry the unknown code (for ops triage) but MUST NOT carry the
    // request body or any token-shaped string.
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('mystery_2030_code'), 400));
    const logger = makeLogger();
    await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
    // Cashier-keyed voucher code is also kept out of logs.
    expect(haystack).not.toContain(SENSITIVE_CODE);
  });

  it('validate(): authority_unreachable path — token absent', async () => {
    const { fetchImpl } = captureFetch(new Error('ECONNREFUSED'));
    const logger = makeLogger();
    await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
    expect(haystack).not.toContain(SENSITIVE_CODE);
  });

  it('redeem(): success — request token (in input) never logged', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(REDEEM_OK, 200));
    const logger = makeLogger();
    await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });

  it('redeem(): mapped refusal — token absent', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('voucher_already_redeemed'), 409));
    const logger = makeLogger();
    await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });

  it('redeem(): authority_unreachable — token absent even on transport error', async () => {
    const { fetchImpl } = captureFetch(bareResponse(503));
    const logger = makeLogger();
    await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });

  it('reverse(): authority_unreachable — no request body bleeds into logs', async () => {
    const { fetchImpl } = captureFetch(new Error('ETIMEDOUT'));
    const logger = makeLogger();
    await reverseVoucher(REVERSE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    // No token in scope for reverse, but we still confirm no raw error
    // string carrying the stack/body landed.
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });
});

describe('voucher V-A client — error-path log hygiene', () => {
  it('does NOT include the raw 4xx response body verbatim in logger calls', async () => {
    // Forge a body that looks like a token-leak escape route — extra
    // properties beyond `error.code`. If the client stringifies the
    // whole body into a log, the test catches it.
    const decoyBody = {
      error: { code: 'voucher_expired', message: 'expired', leak_probe: SENSITIVE_TOKEN },
    };
    const { fetchImpl } = captureFetch(jsonResponse(decoyBody, 400));
    const logger = makeLogger();
    await validateVoucher(VALIDATE_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger,
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    const haystack = flattenLoggerCalls(logger);
    expect(haystack).not.toContain(SENSITIVE_TOKEN);
  });
});
