/**
 * 006 T212 — `vouchers.redeem` client (RED).
 *
 * Asserts (per contracts/bridge-api.md §`vouchers.redeem` + the
 * pinned OpenAPI snapshot `/api/pos/v1/vouchers/redeem`):
 *
 *   1. POSTs to `/api/pos/v1/vouchers/redeem` with the
 *      `Idempotency-Key` header (mutating); success returns the typed
 *      `{ kind: 'redeemed', redemption_id, redeemed_at, idempotent_replayed: false }`
 *      envelope.
 *   2. Idempotent replay: the same Idempotency-Key + same body returns
 *      a `redeemed` envelope with `idempotent_replayed: true`
 *      (the `Idempotent-Replayed: true` response header carries the
 *      same signal at the wire layer, but the client reads
 *      `idempotent_replayed` from the body — that's the source of
 *      truth POS-Pulse persists for audit).
 *   3. Double-redeem with a DIFFERENT Idempotency-Key + same token →
 *      Data-Pulse-2 returns 409 `voucher_already_redeemed`. Client
 *      surfaces `{ kind: 'refused', reason: 'voucher_already_redeemed' }`.
 *
 * Wave 3 RED.
 */
import { describe, expect, it } from 'vitest';

import { redeemVoucher } from '../../../../../src/main/payments/voucher-authority-client/redeem.js';

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

const REDEEM_INPUT = {
  payment_attempt_id: FAKE_PAYMENT_ATTEMPT_ID,
  redemption_intent_token: 'opaque-intent-token-AAA',
};

const REDEEM_OK = {
  kind: 'redeemed' as const,
  redemption_id: FAKE_REDEMPTION_ID,
  redeemed_at: '2026-06-01T10:00:00.000Z',
  idempotent_replayed: false,
};

const REDEEM_REPLAY = {
  ...REDEEM_OK,
  idempotent_replayed: true,
};

describe('redeemVoucher — happy path', () => {
  it('POSTs /vouchers/redeem with Idempotency-Key and returns redeemed envelope', async () => {
    const { fetchImpl, captured } = captureFetch(jsonResponse(REDEEM_OK, 200));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(`${BASE_URL}/api/pos/v1/vouchers/redeem`);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(FAKE_IDEMPOTENCY_KEY);
    expect(call?.init.body).toBe(JSON.stringify(REDEEM_INPUT));

    expect(result).toEqual(REDEEM_OK);
  });
});

describe('redeemVoucher — idempotent replay', () => {
  it('returns idempotent_replayed: true when Data-Pulse-2 reports the replay', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(REDEEM_REPLAY, 200));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });

    expect(result).toEqual(REDEEM_REPLAY);
    expect(result.kind).toBe('redeemed');
    if (result.kind === 'redeemed') {
      expect(result.idempotent_replayed).toBe(true);
    }
  });
});

describe('redeemVoucher — double-redeem refusal', () => {
  it('maps 409 voucher_already_redeemed → refused', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('voucher_already_redeemed'), 409));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(result).toEqual({ kind: 'refused', reason: 'voucher_already_redeemed' });
  });

  it('maps 404 intent_token_not_found → refused', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('intent_token_not_found'), 404));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'intent_token_not_found' });
  });

  it('maps 409 idempotency_key_conflict → refused', async () => {
    const { fetchImpl } = captureFetch(jsonResponse(errorBody('idempotency_key_conflict'), 409));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'idempotency_key_conflict' });
  });
});

describe('redeemVoucher — malformed responses', () => {
  it('200 with garbage JSON body → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(new Response('not-json', { status: 200 }));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('200 with body missing kind discriminator → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(jsonResponse({ some: 'other shape' }, 200));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('400 with non-parsable body → validation_failure refusal', async () => {
    const { fetchImpl } = captureFetch(new Response('garbage', { status: 400 }));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'refused', reason: 'validation_failure' });
  });
});

describe('redeemVoucher — transport-tier outcomes', () => {
  it('network failure → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(new Error('ETIMEDOUT'));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });

  it('5xx → authority_unreachable', async () => {
    const { fetchImpl } = captureFetch(bareResponse(502));
    const result = await redeemVoucher(REDEEM_INPUT, {
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      logger: makeLogger(),
      idempotencyKey: FAKE_IDEMPOTENCY_KEY,
    });
    expect(result).toEqual({ kind: 'authority_unreachable' });
  });
});
