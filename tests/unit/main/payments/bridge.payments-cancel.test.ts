/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * T102 — `payments.cancel` bridge handler test (RED).
 *
 * Asserts (contracts/bridge-api.md §"payments.cancel" + FR-006B / R-13):
 *
 *   1. Session gate (no_session / role_denied).
 *   2. Gating projection → tenant_isolation / wrong_owner / attempt_terminal
 *      from the unified `requireOperatorSession`.
 *   3. Idempotency: identical retry returns the prior outcome
 *      (cancelled_at + reversed_tender_line_ids list reconstructed from
 *      persisted state); mismatch refuses with `idempotency_payload_mismatch`.
 *   4. The handler routes through `paymentAttemptFsm.cancel` which itself
 *      iterates LIFO and reverses every applied line. The handler does
 *      NOT re-iterate — it forwards the FSM outcome.
 *   5. On FSM ok, the handler emits:
 *        • One `tender.reversed` per reversed line (each with
 *          `manual_void_required: true` on external_card_terminal).
 *        • One `payment.cancelled` event with the operator attribution.
 *      Audit emission order: per-line first, then attempt-level (so the
 *      audit log records every line transition before the attempt
 *      terminal-state).
 *
 * **Wave G — TDD RED.** Forward-references the Wave H module.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';

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
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsCancelRequest } from '../../../../src/shared/bridge-api.js';

function validRequest(overrides: Partial<PaymentsCancelRequest> = {}): PaymentsCancelRequest {
  return {
    payment_attempt_id: 'pa-1',
    idempotency_key: 'idem-cancel-1',
    ...overrides,
  };
}

function setup() {
  const sessionSource = makeSessionSource(makeSession());
  const row = makeAttemptRow();
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const linesRepo = makeLinesRepoDouble([
    makeLineRow({ tender_line_id: 'tl-1', apply_order: 1, tender_type: 'cash' }),
    makeLineRow({
      tender_line_id: 'tl-2',
      apply_order: 2,
      tender_type: 'external_card_terminal',
      external_reference: 'AB12XY',
    }),
  ]);
  const fsm = makePaymentAttemptFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const clock = vi.fn<() => Date>(() => new Date('2026-05-23T11:00:05.000Z'));
  const handler = createPaymentsCancelHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    linesRepo,
    paymentAttemptFsm: fsm,
    idempotency,
    auditEmitter,
    clock,
  });
  return { sessionSource, attemptsRepo, linesRepo, fsm, idempotency, auditEmitter, clock, handler };
}

describe('T102 — payments.cancel bridge handler', () => {
  it('refuses no_session when there is no active session', async () => {
    const handler = createPaymentsCancelHandler({
      getCurrentSession: makeSessionSource(null).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('refuses attempt_terminal when the attempt is unknown', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'attempt_terminal',
    });
  });

  it('refuses wrong_owner when the attempt is on another operator session', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ operator_session_id: 'sess-OTHER' });
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'wrong_owner',
    });
  });

  it('refuses tenant_isolation on cross-tenant access', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ tenant_id: 'tenant-OTHER' });
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'tenant_isolation',
    });
  });

  it('returns ok with the persisted cancelled_at + reversed_tender_line_ids on replay', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const persistedRow = makeAttemptRow({
      state: 'cancelled',
      cancelled_at: '2026-05-23T10:59:50.000Z',
    });
    // Mixed line states — exercises BOTH the `.filter(l => state === 'reversed')`
    // and the `.filter(l => state === 'reversal_pending')` predicate functions
    // in the replay reconstruction path (Slice-4 voucher reversal_pending may
    // co-occur with Slice-3 reversed lines after S4 ships; testing the mixed
    // case here keeps the replay reconstruction honest).
    // The sweep stamps every line it reverses with `<cancel key>:rev:<line id>`;
    // only those belong in the replayed answer. `tl-manual` was reversed by a
    // cashier before the cancel (its own action id) and must stay out.
    const sweep = (id: string) => `idem-cancel-1:rev:${id}`;
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-manual',
        state: 'reversed',
        apply_order: 0,
        last_action_id: 'idem-manual-reverse',
      }),
      makeLineRow({
        tender_line_id: 'tl-1',
        state: 'reversed',
        apply_order: 1,
        last_action_id: sweep('tl-1'),
      }),
      makeLineRow({
        tender_line_id: 'tl-2',
        state: 'reversed',
        apply_order: 2,
        last_action_id: sweep('tl-2'),
      }),
      makeLineRow({
        tender_line_id: 'tl-3',
        state: 'reversal_pending',
        apply_order: 3,
        reversal_pending_since: '2026-05-23T10:59:50.000Z',
        last_action_id: sweep('tl-3'),
      }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([persistedRow]),
      linesRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      cancelled_at: '2026-05-23T10:59:50.000Z',
      // LIFO replay — ids sorted by apply_order DESC within each bucket.
      reversed_tender_line_ids: ['tl-2', 'tl-1'],
      reversal_pending_tender_line_ids: ['tl-3'],
    });
    expect(fsm.cancel).not.toHaveBeenCalled();
  });

  it('refuses idempotency_payload_mismatch when the helper signals mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('routes through paymentAttemptFsm.cancel with the session-derived action_id', async () => {
    const { handler, fsm } = setup();
    await handler(validRequest());
    expect(fsm.cancel).toHaveBeenCalledTimes(1);
    expect(fsm.cancel.mock.calls[0]?.[0]).toMatchObject({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-23T11:00:05.000Z',
      action_id: 'idem-cancel-1',
    });
  });

  it('emits one tender.reversed per reversed line + one payment.cancelled, in line-first order', async () => {
    const { handler, fsm, auditEmitter } = setup();
    fsm.cancel.mockReturnValueOnce({
      kind: 'ok',
      cancelled_at: '2026-05-23T11:00:05.000Z',
      reversed_tender_line_ids: ['tl-2', 'tl-1'], // LIFO
      reversal_pending_tender_line_ids: [],
    });
    const result = await handler(validRequest());
    expect(result.kind).toBe('ok');
    const evts = auditEmitter.captured;
    // Two per-line + one attempt-level → 3 total.
    expect(evts).toHaveLength(3);
    expect(evts[0]?.action_category).toBe('tender.reversed');
    expect(evts[1]?.action_category).toBe('tender.reversed');
    expect(evts[2]?.action_category).toBe('payment.cancelled');
    // First per-line is the LIFO-first line (tl-2 — apply_order 2).
    expect(evts[0]?.payload).toMatchObject({
      tender_line_id: 'tl-2',
      tender_type: 'external_card_terminal',
      // external_card_terminal lines emit with manual_void_required: true.
      manual_void_required: true,
    });
    expect(evts[1]?.payload).toMatchObject({
      tender_line_id: 'tl-1',
      tender_type: 'cash',
      manual_void_required: false,
    });
    expect(evts[2]?.payload).toMatchObject({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-23T11:00:05.000Z',
    });
  });

  it('does NOT emit any audit event when the FSM refuses', async () => {
    const { handler, fsm, auditEmitter } = setup();
    fsm.cancel.mockReturnValueOnce({ kind: 'refused', reason: 'attempt_terminal' });
    await handler(validRequest());
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('forwards reversal_pending_tender_line_ids in the response without emitting tender.reversed for them', async () => {
    const { handler, fsm, auditEmitter } = setup();
    // Lines repo has tl-1 (cash, apply_order 1) and tl-2 (external, apply_order 2).
    fsm.cancel.mockReturnValueOnce({
      kind: 'ok',
      cancelled_at: '2026-05-23T11:00:05.000Z',
      reversed_tender_line_ids: ['tl-2'],
      reversal_pending_tender_line_ids: ['tl-1'],
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'ok',
      cancelled_at: '2026-05-23T11:00:05.000Z',
      reversed_tender_line_ids: ['tl-2'],
      reversal_pending_tender_line_ids: ['tl-1'],
    });
    // Only tl-2 produces a tender.reversed event; tl-1's reversal_pending
    // emission is a Slice-4 path (voucher) and not exercised here.
    const reversed = auditEmitter.captured.filter((e) => e.action_category === 'tender.reversed');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.payload).toMatchObject({ tender_line_id: 'tl-2' });
  });

  // ── Defence-in-depth coverage ────────────────────────────────────────────

  it('replay on a non-cancelled attempt refuses with internal_error (race defence)', async () => {
    // The idempotency helper says "replay" but the row state is `started`
    // — an inconsistency that can only occur via concurrent-writer race in
    // production. The handler refuses generically rather than fabricate
    // a cancelled_at value.
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ state: 'started', cancelled_at: null });
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'internal_error',
    });
  });

  it('skips audit emission when the FSM reports a reversed id with no matching line row', async () => {
    // Defence path inside the per-line loop: the FSM returned an id the
    // lines repo cannot resolve (impossible under atomic-tx guarantees,
    // but the handler must not throw or emit a phantom audit for it).
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow();
    const linesRepo = makeLinesRepoDouble([
      // Only tl-1 exists in the post-FSM line state.
      makeLineRow({ tender_line_id: 'tl-1', tender_type: 'cash', apply_order: 1 }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const handler = createPaymentsCancelHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([row]),
      linesRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    fsm.cancel.mockReturnValueOnce({
      kind: 'ok',
      cancelled_at: '2026-05-23T11:00:05.000Z',
      reversed_tender_line_ids: ['tl-1', 'tl-PHANTOM'],
      reversal_pending_tender_line_ids: [],
    });
    const result = await handler(validRequest());
    expect(result.kind).toBe('ok');
    // tl-1 emits an audit; tl-PHANTOM is silently skipped via the
    // `if (line === undefined) continue` defence.
    const reversed = auditEmitter.captured.filter((e) => e.action_category === 'tender.reversed');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.payload).toMatchObject({ tender_line_id: 'tl-1' });
  });
});
