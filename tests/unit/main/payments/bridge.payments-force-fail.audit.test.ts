/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * 006 T241 — `payments.forceFail` audit dual-attribution test (Wave 5b RED).
 *
 * Asserts (FR-021):
 *
 *   When a manager force-fails a cashier's stuck attempt, the
 *   `payment.force_failed` audit row carries DUAL ATTRIBUTION:
 *     • Manager actor — `attribution_operator_id` (top-level field) +
 *       `payload.force_fail_attribution_operator_id` (structured).
 *     • Original cashier — `payload.original_cashier_operator_id`
 *       (structured; immutable since `payments.start`).
 *
 *   The top-level `session_id` is the MANAGER's session (the one that
 *   actually authorised the audit-emitting bridge call).
 *
 *   `force_failed_at` (top-level `created_at` + payload echo) is the
 *   timestamp at which the FSM transitioned the row.
 *
 *   The attempt transitions to `force_failed` exactly once per
 *   idempotency key; an identical-payload retry returns the prior
 *   `force_failed_at` without re-emitting the audit row.
 *
 * **Wave 5b — TDD RED.**
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaymentsForceFailHandler } from '../../../../src/main/payments/handlers/payments-force-fail.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsForceFailRequest } from '../../../../src/shared/bridge-api.js';

const CASHIER_ID = 'op-clerk-user-abc';
const MANAGER_ID = 'op-manager-supervisor';
const MANAGER_SESSION = 'sess-manager-1';

function setup() {
  // Attempt started by the cashier.
  const row = makeAttemptRow({
    acting_operator_id: CASHIER_ID,
    operator_session_id: 'sess-cashier-1',
  });
  // The current session is the manager.
  const session = makeSession({
    role: 'manager',
    operator_id: MANAGER_ID,
    operator_session_id: MANAGER_SESSION,
  });
  const sessionSource = makeSessionSource(session);
  const attemptsRepo = makeAttemptsRepoDouble([row]);
  const fsm = makePaymentAttemptFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const clock = vi.fn<() => Date>(() => new Date('2026-05-25T11:45:30.000Z'));
  const handler = createPaymentsForceFailHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    paymentAttemptFsm: fsm,
    idempotency,
    auditEmitter,
    clock,
  });
  return { row, session, attemptsRepo, fsm, idempotency, auditEmitter, handler };
}

function req(): PaymentsForceFailRequest {
  return {
    payment_attempt_id: 'pa-1',
    idempotency_key: 'idem-ff-audit-1',
  };
}

describe('T241 — payments.forceFail audit dual-attribution', () => {
  it('emits payment.force_failed with manager + cashier attribution', async () => {
    const { auditEmitter, handler } = setup();
    const result = await handler(req());
    expect(result.kind).toBe('ok');
    expect(auditEmitter.captured).toHaveLength(1);
    const event = auditEmitter.captured[0];
    if (event === undefined) throw new Error('expected one captured audit event');
    // Top-level dual attribution:
    expect(event.action_category).toBe('payment.force_failed');
    expect(event.attribution_operator_id).toBe(MANAGER_ID);
    expect(event.session_id).toBe(MANAGER_SESSION);
    expect(event.created_at).toBe('2026-05-25T11:45:30.000Z');
    // Structured payload dual attribution:
    expect(event.payload).toMatchObject({
      force_failed_at: '2026-05-25T11:45:30.000Z',
      force_fail_attribution_operator_id: MANAGER_ID,
      original_cashier_operator_id: CASHIER_ID,
    });
  });

  it('FSM transition is driven with manager_operator_id (force_fail_attribution_operator_id on row)', async () => {
    const { fsm, handler } = setup();
    await handler(req());
    expect(fsm.forceFail).toHaveBeenCalledTimes(1);
    expect(fsm.forceFail.mock.calls[0]?.[0]).toMatchObject({
      payment_attempt_id: 'pa-1',
      manager_operator_id: MANAGER_ID,
      force_failed_at: '2026-05-25T11:45:30.000Z',
    });
  });

  it('RT-304: never calls the reservation commit(); the FSM owns the outbox write', async () => {
    // This pinned the opposite (CR-1, PR #223: commit() called once). That was
    // the bug: `paymentAttemptFsm.forceFail` already inserts the outbox row in
    // its own transaction, so a second insert of the same `action_id` threw a
    // UNIQUE violation after the force-fail had committed. Same-key replay is
    // proven against the real stack in idempotency-replay.real-stack.test.ts.
    const { idempotency, handler } = setup();
    expect(idempotency.commitCalls).toBe(0);
    const result = await handler(req());
    expect(result.kind).toBe('ok');
    expect(idempotency.commitCalls).toBe(0);
  });

  it('idempotency_payload_mismatch: refused; no FSM transition; no audit', async () => {
    const row = makeAttemptRow({
      acting_operator_id: CASHIER_ID,
      operator_session_id: 'sess-cashier-1',
    });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const session = makeSession({
      role: 'manager',
      operator_id: MANAGER_ID,
      operator_session_id: MANAGER_SESSION,
    });
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'mismatch' }),
      auditEmitter,
      clock: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    const result = await handler(req());
    expect(result).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(fsm.forceFail).not.toHaveBeenCalled();
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('replay with row in non-force_failed state: refused with internal_error (defence-in-depth)', async () => {
    // Pathological branch: the idempotency store says "replay" but the
    // row state does not match what a replay should look like. The
    // handler refuses defensively with `internal_error` (a closed
    // refusal value) rather than fabricating a success.
    const row = makeAttemptRow({
      state: 'started', // inconsistent with `kind: 'replay'`
      acting_operator_id: CASHIER_ID,
      operator_session_id: 'sess-cashier-1',
    });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    const session = makeSession({
      role: 'manager',
      operator_id: MANAGER_ID,
      operator_session_id: MANAGER_SESSION,
    });
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter: makeAuditEmitterDouble(),
      clock: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    const result = await handler(req());
    expect(result).toEqual({ kind: 'refused', reason: 'internal_error' });
    expect(fsm.forceFail).not.toHaveBeenCalled();
  });

  it('FSM refuses transition (race): handler forwards the FSM refusal reason', async () => {
    // The handler reaches the FSM call, but the FSM refuses (e.g.,
    // attempt_terminal raced in between findById and the FSM call).
    // The handler MUST forward the FSM refusal as the bridge response.
    const row = makeAttemptRow({
      acting_operator_id: CASHIER_ID,
      operator_session_id: 'sess-cashier-1',
    });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    fsm.forceFail.mockReturnValueOnce({ kind: 'refused', reason: 'attempt_terminal' });
    const auditEmitter = makeAuditEmitterDouble();
    const session = makeSession({
      role: 'manager',
      operator_id: MANAGER_ID,
      operator_session_id: MANAGER_SESSION,
    });
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      clock: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    const result = await handler(req());
    expect(result).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
    expect(auditEmitter.captured).toHaveLength(0);
  });

  it('idempotent replay: returns prior force_failed_at; does NOT re-emit audit', async () => {
    // First call — proceeds normally.
    const first = setup();
    await first.handler(req());
    expect(first.auditEmitter.captured).toHaveLength(1);

    // Second call — replay: rebuild handler with a row already in
    // force_failed state + idempotency double that returns the
    // 'replay' outcome.
    const row = makeAttemptRow({
      state: 'force_failed',
      force_failed_at: '2026-05-25T11:45:30.000Z',
      acting_operator_id: CASHIER_ID,
      operator_session_id: 'sess-cashier-1',
    });
    const attemptsRepo = makeAttemptsRepoDouble([row]);
    const fsm = makePaymentAttemptFsmDouble();
    const auditEmitter = makeAuditEmitterDouble();
    const session = makeSession({
      role: 'manager',
      operator_id: MANAGER_ID,
      operator_session_id: MANAGER_SESSION,
    });
    const handler = createPaymentsForceFailHandler({
      getCurrentSession: () => session,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay' }),
      auditEmitter,
      clock: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    const result = await handler(req());
    expect(result).toEqual({
      kind: 'ok',
      force_failed_at: '2026-05-25T11:45:30.000Z',
    });
    // No FSM transition + no audit on replay.
    expect(fsm.forceFail).not.toHaveBeenCalled();
    expect(auditEmitter.captured).toHaveLength(0);
  });
});
