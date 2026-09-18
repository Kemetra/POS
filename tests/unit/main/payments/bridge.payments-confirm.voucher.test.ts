/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.tender-apply.test.ts for rationale.
 */
/**
 * 006 T221 — `payments.confirm` voucher path test (RED).
 *
 * Wave 4 extension to T101's coverage. Asserts (per
 * `contracts/bridge-api.md` §"payments.confirm" voucher branch +
 * §A4-B brief §3.6 / §3.8):
 *
 *   1. For each `internal_voucher` `applied` line on the attempt, the
 *      handler calls the injected `redeemVoucher` V-A client BEFORE
 *      driving the PaymentAttempt FSM. HTTP cannot live inside a SQLite
 *      transaction, so the redeem sweep is pre-FSM and the
 *      `fsm.confirm` call follows only if every redeem returned
 *      `redeemed`.
 *   2. On success: each voucher line is stamped with the V-A
 *      `redemption_id` via `linesRepo.persistAuthorityRedemptionId`;
 *      the attempt transitions to `settled` and `payment.settled` is
 *      emitted with the voucher line in the breakdown.
 *   3. On any redeem `authority_unreachable`: the attempt transitions
 *      to `failed` with `failure_reason: 'dependency_unavailable'`;
 *      each affected voucher line transitions to `reversal_pending`
 *      via `fsm.markReversalPending`; a `tender.reversal_pending`
 *      audit event is emitted per voucher line. `payment.settled` is
 *      NOT emitted; `payment.failed` IS.
 *   4. **FR-017 guard:** `voucher_authority_redemption_id` MAY appear
 *      in the projection / audit payload; `voucher_redemption_intent_token`
 *      MUST NOT appear anywhere in the bridge response or audit
 *      breakdown.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsConfirmRequest } from '../../../../src/shared/bridge-api.js';
import type {
  RedeemVoucherInput,
  RedeemVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/redeem.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/reverse.js';

function validRequest(overrides: Partial<PaymentsConfirmRequest> = {}): PaymentsConfirmRequest {
  return {
    payment_attempt_id: 'pa-1',
    idempotency_key: 'idem-confirm-voucher-1',
    ...overrides,
  };
}

function makeRedeemVoucherDouble(...outcomes: ReadonlyArray<RedeemVoucherOutcome>) {
  let i = 0;
  return vi.fn<(input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>>(() => {
    const slot = outcomes[Math.min(i, outcomes.length - 1)] ?? {
      kind: 'redeemed',
      idempotent_replayed: false,
      redeemed_at: '2026-05-25T10:00:05.000Z',
      redemption_id: 'redemption-default',
    };
    i += 1;
    return Promise.resolve(slot);
  });
}

function makeReverseVoucherDouble(...outcomes: ReadonlyArray<ReverseVoucherOutcome>) {
  let i = 0;
  return vi.fn<(input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>>(() => {
    const slot = outcomes[Math.min(i, outcomes.length - 1)] ?? {
      kind: 'reversed' as const,
      already_reversed: false,
      redemption_id: 'redemption-default',
      reversed_at: '2026-05-25T10:00:06.000Z',
    };
    i += 1;
    return Promise.resolve(slot);
  });
}

describe('T221 — payments.confirm voucher path', () => {
  // ── 1. Successful voucher redeem → settle ─────────────────────────────────

  it('calls vouchers.redeem for each internal_voucher applied line before confirming the attempt', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN-SECRET',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const linesRepo = makeLinesRepoDouble([voucherLine]);
    const fsm = makePaymentAttemptFsmDouble();
    const tenderFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const redeemVoucher = makeRedeemVoucherDouble({
      kind: 'redeemed',
      idempotent_replayed: false,
      redeemed_at: '2026-05-25T10:00:05.000Z',
      redemption_id: 'redemption-ABC',
    });
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: tenderFsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher,
      reverseVoucher: makeReverseVoucherDouble(),
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', settled_at: '2026-05-25T10:00:05.000Z' });
    expect(redeemVoucher).toHaveBeenCalledTimes(1);
    expect(redeemVoucher.mock.calls[0]?.[0]).toEqual({
      payment_attempt_id: 'pa-1',
      redemption_intent_token: 'TOKEN-SECRET',
    });
    expect(fsm.confirm).toHaveBeenCalledTimes(1);
    // The redemption_id is stamped on the line via the new repo setter.
    expect(linesRepo.persistAuthorityRedemptionId).toHaveBeenCalledWith({
      tender_line_id: 'tl-voucher-1',
      voucher_authority_redemption_id: 'redemption-ABC',
      last_action_id: 'idem-confirm-voucher-1',
    });
  });

  it('does NOT call redeemVoucher when the attempt has no internal_voucher applied lines', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow();
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({ tender_line_id: 'tl-cash', tender_type: 'cash', amount_applied_minor: 1500 }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const redeemVoucher = makeRedeemVoucherDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      redeemVoucher,
      reverseVoucher: makeReverseVoucherDouble(),
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    await handler(validRequest());
    expect(redeemVoucher).not.toHaveBeenCalled();
    expect(fsm.confirm).toHaveBeenCalledTimes(1);
  });

  // ── 2. authority_unreachable → fail + reversal_pending ────────────────────

  it('CR-3 — single voucher line + V-A authority_unreachable: line stays applied (nothing was redeemed)', async () => {
    // CR-3 — with only ONE voucher line that fails on the very first
    // redeem attempt, `persistedRedemptions` is empty. The line was
    // never redeemed at V-A, so there is no V-A redemption to reverse
    // and the line MUST NOT be marked `reversal_pending`. The attempt
    // itself still transitions to `failed` (dependency_unavailable).
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN-SECRET',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const linesRepo = makeLinesRepoDouble([voucherLine]);
    const fsm = makePaymentAttemptFsmDouble();
    const tenderFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const redeemVoucher = makeRedeemVoucherDouble({ kind: 'authority_unreachable' });
    const reverseVoucher = makeReverseVoucherDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: tenderFsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher,
      reverseVoucher,
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
    expect(fsm.fail).toHaveBeenCalledTimes(1);
    expect(fsm.fail.mock.calls[0]?.[0]).toMatchObject({
      payment_attempt_id: 'pa-1',
      failure_reason: 'dependency_unavailable',
    });
    expect(fsm.confirm).not.toHaveBeenCalled();
    // Never-redeemed line — no compensating-reverse, no markReversalPending.
    expect(reverseVoucher).not.toHaveBeenCalled();
    expect(tenderFsm.markReversalPending).not.toHaveBeenCalled();
    expect(tenderFsm.reverse).not.toHaveBeenCalled();
    const categories = auditEmitter.captured.map((e) => e.action_category);
    expect(categories).toContain('payment.failed');
    expect(categories).not.toContain('tender.reversal_pending');
    expect(categories).not.toContain('tender.reversed');
  });

  it('does NOT emit payment.settled when redeem fails', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const auditEmitter = makeAuditEmitterDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble([voucherLine]),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher: makeRedeemVoucherDouble({ kind: 'authority_unreachable' }),
      reverseVoucher: makeReverseVoucherDouble(),
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    await handler(validRequest());
    expect(
      auditEmitter.captured.find((e) => e.action_category === 'payment.settled'),
    ).toBeUndefined();
  });

  it('fails the attempt when V-A redeem refuses (e.g., intent_token_expired)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN-SECRET',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const fsm = makePaymentAttemptFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble([voucherLine]),
      paymentAttemptFsm: fsm,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher: makeRedeemVoucherDouble({
        kind: 'refused',
        reason: 'intent_token_expired',
      }),
      reverseVoucher: makeReverseVoucherDouble(),
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
    expect(fsm.fail).toHaveBeenCalledTimes(1);
    expect(fsm.confirm).not.toHaveBeenCalled();
  });

  it('refuses dependency_unavailable when voucher lines exist but redeemVoucher dep is missing (pre-Wave-4)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN-SECRET',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble([voucherLine]),
      paymentAttemptFsm: fsm,
      // tenderLineFsm + redeemVoucher + uuid omitted (pre-Wave-4).
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'dependency_unavailable',
    });
    expect(fsm.confirm).not.toHaveBeenCalled();
  });

  // ── CR-3 — compensating-reverse for partial-redemption rollback ──────────

  it('CR-3 — multi-voucher partial sweep: redeemed line is compensating-reversed; unredeemed line stays applied', async () => {
    // Two voucher lines. Line 1 redeems ok → V-A stamps redemption-1.
    // Line 2 fails authority_unreachable. CR-3 requires:
    //   • V-A reverseVoucher called for line 1 (because we already redeemed it).
    //   • fsm.reverse driven for line 1 → tender.reversed audit emitted.
    //   • Line 2 stays applied — no compensating-reverse, no markReversalPending.
    //   • Attempt → failed (dependency_unavailable); payment.failed emitted.
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 2000 });
    const voucherLine1 = makeLineRow({
      tender_line_id: 'tl-v-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_redemption_intent_token: 'TOKEN-1',
      applied_at: '2026-05-25T10:00:01.000Z',
      apply_order: 1,
    });
    const voucherLine2 = makeLineRow({
      tender_line_id: 'tl-v-2',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_redemption_intent_token: 'TOKEN-2',
      applied_at: '2026-05-25T10:00:02.000Z',
      apply_order: 2,
    });
    const linesRepo = makeLinesRepoDouble([voucherLine1, voucherLine2]);
    const fsm = makePaymentAttemptFsmDouble();
    const tenderFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const redeemVoucher = makeRedeemVoucherDouble(
      {
        kind: 'redeemed',
        idempotent_replayed: false,
        redeemed_at: '2026-05-25T10:00:05.000Z',
        redemption_id: 'redemption-1',
      },
      { kind: 'authority_unreachable' },
    );
    const reverseVoucher = makeReverseVoucherDouble({
      kind: 'reversed',
      already_reversed: false,
      redemption_id: 'redemption-1',
      reversed_at: '2026-05-25T10:00:06.000Z',
    });
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: tenderFsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher,
      reverseVoucher,
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
    // Attempt failed.
    expect(fsm.fail).toHaveBeenCalledTimes(1);
    expect(fsm.confirm).not.toHaveBeenCalled();
    // Line 1 was redeemed at V-A (persistAuthorityRedemptionId called).
    expect(linesRepo.persistAuthorityRedemptionId).toHaveBeenCalledTimes(1);
    expect(linesRepo.persistAuthorityRedemptionId).toHaveBeenCalledWith({
      tender_line_id: 'tl-v-1',
      voucher_authority_redemption_id: 'redemption-1',
      last_action_id: 'idem-confirm-voucher-1',
    });
    // Compensating-reverse called for line 1 only (line 2 was never redeemed).
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledWith({ redemption_id: 'redemption-1' });
    // V-A returned `reversed` → fsm.reverse drove the line to reversed
    // (NOT markReversalPending).
    expect(tenderFsm.reverse).toHaveBeenCalledTimes(1);
    expect(tenderFsm.reverse.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-v-1',
      payment_attempt_id: 'pa-1',
    });
    expect(tenderFsm.markReversalPending).not.toHaveBeenCalled();
    // Audit: payment.failed + tender.reversed for line 1; nothing for line 2.
    const categories = auditEmitter.captured.map((e) => e.action_category);
    expect(categories).toContain('payment.failed');
    expect(categories).toContain('tender.reversed');
    expect(categories).not.toContain('tender.reversal_pending');
    const reversedEvents = auditEmitter.captured.filter(
      (e) => e.action_category === 'tender.reversed',
    );
    expect(reversedEvents).toHaveLength(1);
    expect(reversedEvents[0]?.payload).toMatchObject({
      tender_line_id: 'tl-v-1',
      tender_type: 'internal_voucher',
    });
  });

  it('CR-3 — multi-voucher partial sweep + compensating-reverse also unreachable → line 1 → reversal_pending', async () => {
    // Line 1 redeems ok → redemption-1. Line 2 → authority_unreachable.
    // Compensating-reverse on line 1 ALSO returns authority_unreachable.
    // CR-3 then falls back to markReversalPending for line 1; the
    // Wave-5 deferred resolver picks it up later. Line 2 still stays
    // applied — never redeemed → no V-A redemption to reverse.
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 2000 });
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-v-1',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_redemption_intent_token: 'TOKEN-1',
        applied_at: '2026-05-25T10:00:01.000Z',
        apply_order: 1,
      }),
      makeLineRow({
        tender_line_id: 'tl-v-2',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_redemption_intent_token: 'TOKEN-2',
        applied_at: '2026-05-25T10:00:02.000Z',
        apply_order: 2,
      }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const tenderFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const redeemVoucher = makeRedeemVoucherDouble(
      {
        kind: 'redeemed',
        idempotent_replayed: false,
        redeemed_at: '2026-05-25T10:00:05.000Z',
        redemption_id: 'redemption-1',
      },
      { kind: 'authority_unreachable' },
    );
    const reverseVoucher = makeReverseVoucherDouble({ kind: 'authority_unreachable' });
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: tenderFsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher,
      reverseVoucher,
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'dependency_unavailable' });
    // Compensating-reverse attempted on line 1.
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    expect(reverseVoucher).toHaveBeenCalledWith({ redemption_id: 'redemption-1' });
    // V-A unreachable on reverse → markReversalPending on line 1.
    expect(tenderFsm.reverse).not.toHaveBeenCalled();
    expect(tenderFsm.markReversalPending).toHaveBeenCalledTimes(1);
    expect(tenderFsm.markReversalPending.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-v-1',
      payment_attempt_id: 'pa-1',
    });
    // Audit: payment.failed + tender.reversal_pending for line 1 only.
    const categories = auditEmitter.captured.map((e) => e.action_category);
    expect(categories).toContain('payment.failed');
    expect(categories).toContain('tender.reversal_pending');
    expect(categories).not.toContain('tender.reversed');
    const pendingEvents = auditEmitter.captured.filter(
      (e) => e.action_category === 'tender.reversal_pending',
    );
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.payload).toMatchObject({
      tender_line_id: 'tl-v-1',
      tender_type: 'internal_voucher',
    });
  });

  it('CR-3 — two voucher lines, both redeem ok → both settle, no compensation', async () => {
    // Happy path — both vouchers redeem; attempt settles cleanly; no
    // compensating-reverse invoked.
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 2000 });
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-v-1',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_redemption_intent_token: 'TOKEN-1',
        applied_at: '2026-05-25T10:00:01.000Z',
        apply_order: 1,
      }),
      makeLineRow({
        tender_line_id: 'tl-v-2',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_redemption_intent_token: 'TOKEN-2',
        applied_at: '2026-05-25T10:00:02.000Z',
        apply_order: 2,
      }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const tenderFsm = makeTenderLineFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const redeemVoucher = makeRedeemVoucherDouble(
      {
        kind: 'redeemed',
        idempotent_replayed: false,
        redeemed_at: '2026-05-25T10:00:05.000Z',
        redemption_id: 'redemption-1',
      },
      {
        kind: 'redeemed',
        idempotent_replayed: false,
        redeemed_at: '2026-05-25T10:00:05.500Z',
        redemption_id: 'redemption-2',
      },
    );
    const reverseVoucher = makeReverseVoucherDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      tenderLineFsm: tenderFsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher,
      reverseVoucher,
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', settled_at: '2026-05-25T10:00:05.000Z' });
    expect(redeemVoucher).toHaveBeenCalledTimes(2);
    expect(reverseVoucher).not.toHaveBeenCalled();
    expect(fsm.confirm).toHaveBeenCalledTimes(1);
    expect(fsm.fail).not.toHaveBeenCalled();
    expect(tenderFsm.reverse).not.toHaveBeenCalled();
    expect(tenderFsm.markReversalPending).not.toHaveBeenCalled();
  });

  // ── 3. FR-017 guard ───────────────────────────────────────────────────────

  it('redemption_intent_token NEVER appears in the bridge response or audit payload', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 1500 });
    const voucherLine = makeLineRow({
      tender_line_id: 'tl-voucher-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_redemption_intent_token: 'TOKEN-SECRET-LEAK-TEST',
      applied_at: '2026-05-25T10:00:01.000Z',
    });
    const auditEmitter = makeAuditEmitterDouble();
    const handler = createPaymentsConfirmHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble([voucherLine]),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      redeemVoucher: makeRedeemVoucherDouble({
        kind: 'redeemed',
        idempotent_replayed: false,
        redeemed_at: '2026-05-25T10:00:05.000Z',
        redemption_id: 'redemption-ABC',
      }),
      reverseVoucher: makeReverseVoucherDouble(),
      uuid: () => 'uuid-confirm-v',
      clock: () => new Date('2026-05-25T10:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(JSON.stringify(result)).not.toContain('TOKEN-SECRET-LEAK-TEST');
    for (const evt of auditEmitter.captured) {
      expect(JSON.stringify(evt)).not.toContain('TOKEN-SECRET-LEAK-TEST');
      expect(JSON.stringify(evt)).not.toContain('voucher_redemption_intent_token');
    }
  });
});
