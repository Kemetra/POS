/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.tender-apply.test.ts for rationale.
 */
/**
 * 006 T222 — `tender.reverse` voucher path test (RED).
 *
 * Wave 4 extension to T106's coverage. Asserts (per
 * `contracts/bridge-api.md` §"tender.reverse" voucher branch +
 * §A4-B brief §3.6 / §3.8):
 *
 *   1. For an `internal_voucher` `applied` line the handler calls the
 *      injected `reverseVoucher` V-A client (pre-FSM; HTTP cannot live
 *      inside `db.transaction()`).
 *   2. On V-A `reversed`: the handler drives `fsm.confirmReversed`
 *      (line transitions to `reversed`); response carries
 *      `{ kind: 'ok', state: 'reversed', reversed_at }`; emits
 *      `tender.reversed`.
 *   3. On V-A `authority_unreachable`: the handler drives
 *      `fsm.markReversalPending` (line → `reversal_pending`); response
 *      carries `{ kind: 'ok', state: 'reversal_pending', reversed_at }`;
 *      emits `tender.reversal_pending` (NOT `tender.reversed`).
 *   4. On V-A refusal (e.g., `redemption_not_found`): the bridge
 *      forwards the closed-set refusal envelope; no state transition,
 *      no audit emission.
 *   5. **Idempotency:** identical retry of a voucher reverse is a no-op
 *      against the persisted state (replay returns the prior outcome).
 */

import { describe, expect, it, vi } from 'vitest';

import { createTenderReverseHandler } from '../../../../src/main/payments/handlers/tender-reverse.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';
import type { TenderReverseRequest } from '../../../../src/shared/bridge-api.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../../../../src/main/payments/voucher-authority-client/reverse.js';

function validRequest(overrides: Partial<TenderReverseRequest> = {}): TenderReverseRequest {
  return {
    tender_line_id: 'tl-voucher-1',
    idempotency_key: 'idem-reverse-voucher-1',
    ...overrides,
  };
}

function makeReverseVoucherDouble(
  outcome: ReverseVoucherOutcome = {
    kind: 'reversed',
    already_reversed: false,
    redemption_id: 'redemption-ABC',
    reversed_at: '2026-05-25T10:00:10.000Z',
  },
) {
  return vi.fn<(input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>>(() =>
    Promise.resolve(outcome),
  );
}

function setup(opts: { reverseOutcome?: ReverseVoucherOutcome } = {}) {
  const sessionSource = makeSessionSource(makeSession());
  const row = makeAttemptRow();
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const voucherLine = makeLineRow({
    tender_line_id: 'tl-voucher-1',
    tender_type: 'internal_voucher',
    amount_applied_minor: 1500,
    voucher_authority_redemption_id: 'redemption-ABC',
    state: 'applied',
    applied_at: '2026-05-25T10:00:01.000Z',
  });
  const linesRepo = makeLinesRepoDouble([voucherLine]);
  const fsm = makeTenderLineFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const reverseVoucher = makeReverseVoucherDouble(opts.reverseOutcome);
  const clock = vi.fn<() => Date>(() => new Date('2026-05-25T10:00:10.000Z'));
  const handler = createTenderReverseHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    linesRepo,
    tenderLineFsm: fsm,
    idempotency,
    auditEmitter,
    reverseVoucher,
    clock,
  });
  return {
    sessionSource,
    attemptsRepo,
    linesRepo,
    fsm,
    idempotency,
    auditEmitter,
    reverseVoucher,
    clock,
    handler,
  };
}

describe('T222 — tender.reverse voucher path', () => {
  // ── 1. V-A reversed → fsm.confirmReversed + tender.reversed ───────────────

  it('calls reverseVoucher with the persisted redemption_id and transitions the line to reversed', async () => {
    const { handler, fsm, reverseVoucher } = setup();
    const result = await handler(validRequest());
    expect(reverseVoucher).toHaveBeenCalledTimes(1);
    expect(reverseVoucher.mock.calls[0]?.[0]).toEqual({ redemption_id: 'redemption-ABC' });
    expect(result).toEqual({
      kind: 'ok',
      reversed_at: '2026-05-25T10:00:10.000Z',
      state: 'reversed',
    });
    expect(fsm.confirmReversed).toHaveBeenCalledTimes(1);
    expect(fsm.confirmReversed.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-voucher-1',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T10:00:10.000Z',
      action_id: 'idem-reverse-voucher-1',
    });
    expect(fsm.markReversalPending).not.toHaveBeenCalled();
    expect(fsm.reverse).not.toHaveBeenCalled();
  });

  it('emits tender.reversed on V-A reversed success', async () => {
    const { handler, auditEmitter } = setup();
    await handler(validRequest());
    expect(auditEmitter.captured).toHaveLength(1);
    expect(auditEmitter.captured[0]?.action_category).toBe('tender.reversed');
    expect(auditEmitter.captured[0]?.payload).toMatchObject({
      tender_line_id: 'tl-voucher-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
    });
  });

  // ── 2. V-A authority_unreachable → markReversalPending + audit ────────────

  it('transitions the line to reversal_pending on V-A authority_unreachable', async () => {
    const { handler, fsm } = setup({ reverseOutcome: { kind: 'authority_unreachable' } });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      reversed_at: '2026-05-25T10:00:10.000Z',
      state: 'reversal_pending',
    });
    expect(fsm.markReversalPending).toHaveBeenCalledTimes(1);
    expect(fsm.markReversalPending.mock.calls[0]?.[0]).toMatchObject({
      tender_line_id: 'tl-voucher-1',
      payment_attempt_id: 'pa-1',
      reversal_pending_since: '2026-05-25T10:00:10.000Z',
      action_id: 'idem-reverse-voucher-1',
    });
    expect(fsm.confirmReversed).not.toHaveBeenCalled();
  });

  it('emits tender.reversal_pending on V-A authority_unreachable (NOT tender.reversed)', async () => {
    const { handler, auditEmitter } = setup({ reverseOutcome: { kind: 'authority_unreachable' } });
    await handler(validRequest());
    const categories = auditEmitter.captured.map((e) => e.action_category);
    expect(categories).toContain('tender.reversal_pending');
    expect(categories).not.toContain('tender.reversed');
    const evt = auditEmitter.captured.find((e) => e.action_category === 'tender.reversal_pending');
    expect(evt?.payload).toMatchObject({
      tender_line_id: 'tl-voucher-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      reversal_pending_since: '2026-05-25T10:00:10.000Z',
    });
  });

  // ── 3. V-A refusal → bridge refusal pass-through ──────────────────────────

  it('maps V-A refusal (redemption_not_found) to the bridge closed-set refusal envelope', async () => {
    // Per F-A4B-003 / bridge-api.md §"tender.reverse" closed reason
    // set, V-A reverse refusals collapse to `line_not_applied` on the
    // bridge — the renderer renders one generic copy string regardless
    // of which V-A code fired. The structured V-A code stays in the
    // V-A client's logger / Sentry for ops triage.
    const { handler, fsm, auditEmitter } = setup({
      reverseOutcome: { kind: 'refused', reason: 'redemption_not_found' },
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'line_not_applied' });
    expect(fsm.confirmReversed).not.toHaveBeenCalled();
    expect(fsm.markReversalPending).not.toHaveBeenCalled();
    expect(auditEmitter.captured).toHaveLength(0);
  });

  // ── 4. Idempotency ────────────────────────────────────────────────────────

  it('returns the prior outcome on idempotency replay (reversed line)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-voucher-1',
        tender_type: 'internal_voucher',
        state: 'reversed',
        reversed_at: '2026-05-25T09:59:50.000Z',
        last_action_id: 'idem-reverse-voucher-1',
      }),
    ]);
    const reverseVoucher = makeReverseVoucherDouble();
    const handler = createTenderReverseHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      reverseVoucher,
      clock: () => new Date('2026-05-25T10:00:10.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      reversed_at: '2026-05-25T09:59:50.000Z',
      state: 'reversed',
    });
    expect(reverseVoucher).not.toHaveBeenCalled();
  });

  it('refuses tender_not_yet_supported when reverseVoucher is not injected (defence-in-depth)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-voucher-1',
        tender_type: 'internal_voucher',
        state: 'applied',
        voucher_authority_redemption_id: 'redemption-ABC',
      }),
    ]);
    const handler = createTenderReverseHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      // reverseVoucher omitted — pre-Wave-4 wiring scenario.
      clock: () => new Date('2026-05-25T10:00:10.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'tender_not_yet_supported',
    });
  });

  it('refuses line_not_applied when the voucher line lacks a voucher_authority_redemption_id', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-voucher-1',
        tender_type: 'internal_voucher',
        state: 'applied',
        voucher_authority_redemption_id: null,
      }),
    ]);
    const handler = createTenderReverseHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      reverseVoucher: makeReverseVoucherDouble(),
      clock: () => new Date('2026-05-25T10:00:10.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'line_not_applied',
    });
  });

  it('forwards FSM markReversalPending refusal when the line is no longer in `applied` state', async () => {
    const { handler, fsm } = setup({ reverseOutcome: { kind: 'authority_unreachable' } });
    fsm.markReversalPending.mockReturnValueOnce({
      kind: 'refused',
      reason: 'line_not_applied',
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'line_not_applied',
    });
  });

  it('forwards FSM confirmReversed refusal when the line is no longer reversible', async () => {
    const { handler, fsm } = setup();
    fsm.confirmReversed.mockReturnValueOnce({
      kind: 'refused',
      reason: 'line_not_applied',
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'line_not_applied',
    });
  });

  it('returns the prior outcome on idempotency replay (reversal_pending line)', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-voucher-1',
        tender_type: 'internal_voucher',
        state: 'reversal_pending',
        reversed_at: '2026-05-25T09:59:50.000Z',
        reversal_pending_since: '2026-05-25T09:59:50.000Z',
        last_action_id: 'idem-reverse-voucher-1',
      }),
    ]);
    const handler = createTenderReverseHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo,
      tenderLineFsm: makeTenderLineFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      reverseVoucher: makeReverseVoucherDouble(),
      clock: () => new Date('2026-05-25T10:00:10.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      reversed_at: '2026-05-25T09:59:50.000Z',
      state: 'reversal_pending',
    });
  });
});
