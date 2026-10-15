/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * T101 — `payments.confirm` bridge handler test (RED).
 *
 * Asserts (contracts/bridge-api.md §"payments.confirm"):
 *
 *   1. Session gate (no_session / role_denied).
 *   2. requireOperatorSession with attempt-projection enforces
 *      tenant_isolation, wrong_owner, attempt_terminal — refusal reasons
 *      come straight from the gating helper.
 *   3. Idempotency: identical retry returns the original
 *      `{ kind: 'ok', settled_at }` derived from the persisted row;
 *      payload-mismatch retry refuses with `idempotency_payload_mismatch`.
 *   4. The handler calls `paymentAttemptFsm.confirm`. FSM refusals
 *      (`tender_underpaid`, `internal_error`, `attempt_terminal`) pass
 *      through unchanged.
 *   5. On FSM ok, the handler emits a `payment.settled` audit event with
 *      the full tender breakdown (AD-9 / R-8) — every applied line
 *      carries `tender_line_id`, `tender_type`, `amount_applied_minor`,
 *      `applied_at`, `attribution_operator_id`. `change_due_minor` is
 *      present only on cash; `external_reference` is redacted to '*****'
 *      on external_card_terminal (the audit emitter handles the
 *      redaction — the handler just hands the raw row in).
 *
 * **Wave G — TDD RED.** Forward-references the Wave H module.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';

import {
  gatingProjection,
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
  makeSettlementDeps,
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsConfirmRequest } from '../../../../src/shared/bridge-api.js';

function validRequest(overrides: Partial<PaymentsConfirmRequest> = {}): PaymentsConfirmRequest {
  return {
    payment_attempt_id: 'pa-1',
    idempotency_key: 'idem-confirm-1',
    ...overrides,
  };
}

function setup(opts: { attemptRow?: ReturnType<typeof makeAttemptRow> } = {}) {
  const sessionSource = makeSessionSource(makeSession());
  const row = opts.attemptRow ?? makeAttemptRow();
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const linesRepo = makeLinesRepoDouble([
    makeLineRow({ tender_line_id: 'tl-1', amount_applied_minor: 1500 }),
  ]);
  const fsm = makePaymentAttemptFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const clock = vi.fn<() => Date>(() => new Date('2026-05-23T11:00:05.000Z'));
  const handler = createPaymentsConfirmHandler({
    ...makeSettlementDeps(fsm, auditEmitter),
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    linesRepo,
    paymentAttemptFsm: fsm,
    idempotency,
    auditEmitter,
    clock,
  });
  return {
    sessionSource,
    attemptsRepo,
    linesRepo,
    fsm,
    idempotency,
    auditEmitter,
    clock,
    handler,
    row,
  };
}

describe('T101 — payments.confirm bridge handler', () => {
  // ── 1. Session gate ───────────────────────────────────────────────────────

  it('refuses no_session when there is no active session', async () => {
    const handler = createPaymentsConfirmHandler({
      ...makeSettlementDeps(makePaymentAttemptFsmDouble(), makeAuditEmitterDouble()),
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

  // ── 2. Gating projections (tenant_isolation / wrong_owner / attempt_terminal) ─

  it('refuses wrong_owner when the attempt belongs to another operator session', async () => {
    const row = makeAttemptRow({ operator_session_id: 'sess-OTHER' });
    const { handler } = setup({ attemptRow: row });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'wrong_owner' });
    // Sanity — the gating projection helper still resolves the row.
    expect(gatingProjection(row).operator_session_id).toBe('sess-OTHER');
  });

  it('refuses tenant_isolation when the attempt is on a different tenant/branch/terminal', async () => {
    const row = makeAttemptRow({ tenant_id: 'tenant-OTHER' });
    const { handler } = setup({ attemptRow: row });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'tenant_isolation',
    });
  });

  it('refuses attempt_terminal when the attempt is already in a terminal state', async () => {
    const row = makeAttemptRow({ state: 'settled' });
    const { handler } = setup({ attemptRow: row });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'attempt_terminal',
    });
  });

  it('refuses attempt_terminal when the attempt_id is unknown', async () => {
    // No row in the repo.
    const sessionSource = makeSessionSource(makeSession());
    const handler = createPaymentsConfirmHandler({
      ...makeSettlementDeps(makePaymentAttemptFsmDouble(), makeAuditEmitterDouble()),
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

  // ── 3. Idempotency ───────────────────────────────────────────────────────

  it('returns ok with the persisted settled_at when the helper signals replay', async () => {
    const persistedRow = makeAttemptRow({
      state: 'settled',
      settled_at: '2026-05-23T10:59:50.000Z',
    });
    // Replay is checked BEFORE the gate's terminal-state guard so a retry of
    // a previously-successful confirm doesn't surface as attempt_terminal.
    const sessionSource = makeSessionSource(makeSession());
    const attemptsRepo = makeAttemptsRepoDouble([persistedRow]);
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsConfirmHandler({
      ...makeSettlementDeps(fsm, makeAuditEmitterDouble()),
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', settled_at: '2026-05-23T10:59:50.000Z' });
    expect(fsm.confirm).not.toHaveBeenCalled();
  });

  it('refuses idempotency_payload_mismatch when the helper signals mismatch', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsConfirmHandler({
      ...makeSettlementDeps(fsm, makeAuditEmitterDouble()),
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
    expect(fsm.confirm).not.toHaveBeenCalled();
  });

  // ── 4. FSM refusal pass-through ──────────────────────────────────────────

  it('maps FSM tender_underpaid refusal to the bridge response', async () => {
    const { handler, fsm } = setup();
    fsm.confirm.mockReturnValueOnce({ kind: 'refused', reason: 'tender_underpaid' });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'tender_underpaid',
    });
  });

  it('maps FSM internal_error refusal to the bridge response', async () => {
    const { handler, fsm } = setup();
    fsm.confirm.mockReturnValueOnce({ kind: 'refused', reason: 'internal_error' });
    expect(await handler(validRequest())).toEqual({
      kind: 'refused',
      reason: 'internal_error',
    });
  });

  // ── 5. Happy path → audit emission with full tender breakdown ────────────

  it('emits payment.settled with the full tender_lines breakdown on FSM ok', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const row = makeAttemptRow({ envelope_subtotal_minor: 3500 });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const linesRepo = makeLinesRepoDouble([
      makeLineRow({
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        amount_applied_minor: 2000,
        change_due_minor: 500,
        applied_at: '2026-05-23T11:00:01.000Z',
      }),
      makeLineRow({
        tender_line_id: 'tl-2',
        tender_type: 'external_card_terminal',
        amount_applied_minor: 2000,
        external_reference: 'AB12XY',
        applied_at: '2026-05-23T11:00:02.000Z',
      }),
    ]);
    const fsm = makePaymentAttemptFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const handler = createPaymentsConfirmHandler({
      ...makeSettlementDeps(fsm, auditEmitter),
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      linesRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      clock: () => new Date('2026-05-23T11:00:05.000Z'),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', settled_at: '2026-05-23T11:00:05.000Z' });
    expect(fsm.confirm).toHaveBeenCalledTimes(1);
    const fsmArgs = fsm.confirm.mock.calls[0]?.[0];
    expect(fsmArgs).toMatchObject({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-23T11:00:05.000Z',
      action_id: 'idem-confirm-1',
    });
    // Exactly one payment.settled event captured.
    expect(auditEmitter.captured).toHaveLength(1);
    const evt = auditEmitter.captured[0];
    expect(evt?.action_category).toBe('payment.settled');
    expect(evt?.payment_attempt_id).toBe('pa-1');
    expect(evt?.attribution_operator_id).toBe('op-clerk-user-abc');
    // Full tender breakdown forwarded to the emitter. The emitter performs
    // redaction; the handler only assembles the row data.
    const lines = (evt?.payload as { tender_lines: Array<Record<string, unknown>> }).tender_lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      tender_line_id: 'tl-1',
      tender_type: 'cash',
      amount_applied_minor: 2000,
      change_due_minor: 500,
    });
    expect(lines[1]).toMatchObject({
      tender_line_id: 'tl-2',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 2000,
    });
  });

  it('does NOT emit payment.settled when the FSM refuses', async () => {
    const { handler, fsm, auditEmitter } = setup();
    fsm.confirm.mockReturnValueOnce({ kind: 'refused', reason: 'tender_underpaid' });
    await handler(validRequest());
    expect(auditEmitter.captured).toHaveLength(0);
  });
});
