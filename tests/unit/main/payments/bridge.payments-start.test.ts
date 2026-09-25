/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed mock properties on the shared fixture double trigger this
 * rule on every assertion (`expect(repo.findById).toHaveBeenCalled`).
 * Same posture as `tests/unit/main/operator/cashier-sign-in-handler.test.ts`.
 */
/**
 * T100 — `payments.start` bridge handler test (RED).
 *
 * Asserts the handler at the trust boundary between the renderer and the
 * main process (contracts/bridge-api.md §"payments.start"):
 *
 *   1. requireOperatorSession is the FIRST instruction. No session →
 *      `{ kind: 'refused', reason: 'no_session' }`. Role outside the
 *      allowed set (cashier | manager | admin) → `role_denied`.
 *   2. The handler routes the partial-unique-index race to
 *      `attempt_already_started_on_terminal` via the FSM's `start`
 *      outcome — not via a custom code path.
 *   3. Idempotency is checked via the helper. Identical retry → replay
 *      (no FSM call, returns the original `payment_attempt_id`).
 *      Payload-mismatch retry → `idempotency_payload_mismatch` refusal.
 *   4. Tenant / branch / terminal isolation: the request must come from
 *      a session matching the envelope's scope. (`payments.start` does
 *      not yet bind to an attempt, so tenant_isolation here is vacuous;
 *      the envelope ingest already passed through 005's gate.) The
 *      handler still binds the FSM call to the session-scoped tuple
 *      (tenant_id, branch_id, terminal_id, operator_id, session_id).
 *   5. envelope_version must be 'v1'. Anything else collapses to
 *      `invalid_input` (the closed RefusalReason enum has no
 *      `unsupported_envelope_version` value).
 *
 * **Wave G — TDD RED.** The handler factory does not exist yet; the
 * import below is intentionally forward-referencing the Wave H module
 * `src/main/payments/handlers/payments-start.ts`. Tests are RED until
 * Wave H lands.
 */

import { describe, expect, it, vi } from 'vitest';

// Forward reference — Wave H (T133) creates this module.
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';

import {
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
} from './__fixtures__/bridge-handler-deps.js';
import type { PaymentsStartRequest } from '../../../../src/shared/bridge-api.js';

function validRequest(overrides: Partial<PaymentsStartRequest> = {}): PaymentsStartRequest {
  return {
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    envelope_version: 'v1',
    idempotency_key: 'idem-start-1',
    ...overrides,
  };
}

function setup() {
  const sessionSource = makeSessionSource(makeSession());
  const attemptsRepo = makeAttemptsRepoDouble();
  const fsm = makePaymentAttemptFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const uuid = vi.fn<() => string>(() => 'pa-1');
  const clock = vi.fn<() => Date>(() => new Date('2026-05-23T11:00:00.000Z'));
  const handler = createPaymentsStartHandler({
    getCurrentSession: sessionSource.getCurrentSession,
    attemptsRepo,
    paymentAttemptFsm: fsm,
    idempotency,
    auditEmitter,
    uuid,
    clock,
    // Required since the §A4 cart-eligibility check; these cases are not about it.
    checkCartForPayment: () => ({ kind: 'ok' }),
  });
  return { sessionSource, attemptsRepo, fsm, idempotency, auditEmitter, uuid, clock, handler };
}

describe('T100 — payments.start bridge handler', () => {
  // ── 1. Session gate ───────────────────────────────────────────────────────

  it('refuses no_session when there is no active operator session', async () => {
    const { handler } = setup();
    // Re-create with null session.
    const nullHandler = createPaymentsStartHandler({
      getCurrentSession: makeSessionSource(null).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'pa-1',
      clock: () => new Date('2026-05-23T11:00:00.000Z'),
      // Required since the §A4 cart-eligibility check; these cases are not about it.
      checkCartForPayment: () => ({ kind: 'ok' }),
    });
    const result = await nullHandler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'no_session' });
    // Sanity — first-setup handler is still usable.
    expect(handler).toBeDefined();
  });

  it('refuses role_denied when the session role is not cashier/manager/admin', async () => {
    // The Role union is closed at `cashier | manager | admin`, so the only
    // way to provoke role_denied at the handler boundary is to inject a
    // session whose role is out-of-set. We cast through unknown so the test
    // can simulate a future role being added.
    const sessionSource = makeSessionSource(
      makeSession({ role: 'support' as unknown as 'cashier' }),
    );
    const handler = createPaymentsStartHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      paymentAttemptFsm: makePaymentAttemptFsmDouble(),
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'pa-1',
      clock: () => new Date('2026-05-23T11:00:00.000Z'),
      // Required since the §A4 cart-eligibility check; these cases are not about it.
      checkCartForPayment: () => ({ kind: 'ok' }),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'role_denied' });
  });

  it('admits all three permitted roles (cashier, manager, admin)', async () => {
    for (const role of ['cashier', 'manager', 'admin'] as const) {
      const sessionSource = makeSessionSource(makeSession({ role }));
      const handler = createPaymentsStartHandler({
        getCurrentSession: sessionSource.getCurrentSession,
        attemptsRepo: makeAttemptsRepoDouble(),
        paymentAttemptFsm: makePaymentAttemptFsmDouble(),
        idempotency: makeIdempotencyHelperDouble(),
        auditEmitter: makeAuditEmitterDouble(),
        uuid: () => `pa-${role}`,
        clock: () => new Date('2026-05-23T11:00:00.000Z'),
        // Required since the §A4 cart-eligibility check; these cases are not about it.
        checkCartForPayment: () => ({ kind: 'ok' }),
      });
      const result = await handler(validRequest({ idempotency_key: `idem-${role}` }));
      expect(result).toEqual({ kind: 'ok', payment_attempt_id: `pa-${role}` });
    }
  });

  // ── 2. Envelope version gate ──────────────────────────────────────────────

  it('refuses invalid_input when envelope_version is not v1', async () => {
    const { handler } = setup();
    const result = await handler(validRequest({ envelope_version: 'v2' as unknown as 'v1' }));
    expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  it('refuses invalid_input when envelope_subtotal_minor is not a safe non-negative integer', async () => {
    const { handler } = setup();
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const result = await handler(validRequest({ envelope_subtotal_minor: bad }));
      expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
    }
  });

  // ── 3. Idempotency replay ────────────────────────────────────────────────

  it('returns the original outcome (no FSM call) when the idempotency helper says replay', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const attemptsRepo = makeAttemptsRepoDouble();
    const fsm = makePaymentAttemptFsmDouble();
    const idempotency = makeIdempotencyHelperDouble({ kind: 'replay' });
    // The replay must produce the prior outcome from outbox-row state. The
    // outbox stores `last_action_id` keyed to the same idempotency_key; the
    // handler reads it back via the attempts repo. We seed one started row
    // so the handler has somewhere to read from.
    attemptsRepo.findStartedByTerminal.mockReturnValueOnce({
      payment_attempt_id: 'pa-existing',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-clerk-user-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1500,
      state: 'started',
      started_at: '2026-05-23T11:00:00.000Z',
      settled_at: null,
      cancelled_at: null,
      failed_at: null,
      force_failed_at: null,
      failure_reason: null,
      force_fail_attribution_operator_id: null,
      last_action_id: 'idem-start-1',
    });
    const handler = createPaymentsStartHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo,
      paymentAttemptFsm: fsm,
      idempotency,
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'pa-NEW',
      clock: () => new Date('2026-05-23T11:00:00.000Z'),
      // Required since the §A4 cart-eligibility check; these cases are not about it.
      checkCartForPayment: () => ({ kind: 'ok' }),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', payment_attempt_id: 'pa-existing' });
    // Replay path MUST NOT call the FSM again.
    expect(fsm.start).not.toHaveBeenCalled();
  });

  it('refuses idempotency_payload_mismatch when the helper signals payload divergence', async () => {
    const sessionSource = makeSessionSource(makeSession());
    const idempotency = makeIdempotencyHelperDouble({ kind: 'mismatch' });
    const fsm = makePaymentAttemptFsmDouble();
    const handler = createPaymentsStartHandler({
      getCurrentSession: sessionSource.getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble(),
      paymentAttemptFsm: fsm,
      idempotency,
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'pa-1',
      clock: () => new Date('2026-05-23T11:00:00.000Z'),
      // Required since the §A4 cart-eligibility check; these cases are not about it.
      checkCartForPayment: () => ({ kind: 'ok' }),
    });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(fsm.start).not.toHaveBeenCalled();
  });

  // ── 4. Happy path → FSM call shape ───────────────────────────────────────

  it('routes the fresh path through the FSM with session-scoped fields', async () => {
    const { handler, fsm, sessionSource, uuid, clock } = setup();
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'ok', payment_attempt_id: 'pa-1' });
    expect(fsm.start).toHaveBeenCalledTimes(1);
    const args = fsm.start.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      payment_attempt_id: 'pa-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-clerk-user-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-23T11:00:00.000Z',
      action_id: 'idem-start-1',
    });
    expect(uuid).toHaveBeenCalled();
    expect(clock).toHaveBeenCalled();
    // Sanity: session source was consulted.
    expect(sessionSource.getCurrentSession()).not.toBeNull();
  });

  // ── 5. FSM refusal pass-through ───────────────────────────────────────────

  it('maps FSM attempt_already_started_on_terminal refusal directly to the bridge response', async () => {
    const { handler, fsm } = setup();
    fsm.start.mockReturnValueOnce({
      kind: 'refused',
      reason: 'attempt_already_started_on_terminal',
    });
    const result = await handler(validRequest());
    expect(result).toEqual({
      kind: 'refused',
      reason: 'attempt_already_started_on_terminal',
    });
  });

  it('maps any FSM refusal reason directly to the bridge response (closed-set pass-through)', async () => {
    const { handler, fsm } = setup();
    fsm.start.mockReturnValueOnce({ kind: 'refused', reason: 'invalid_input' });
    const result = await handler(validRequest());
    expect(result).toEqual({ kind: 'refused', reason: 'invalid_input' });
  });

  // ── 6. Audit emission — payments.start does NOT emit (FR-025) ────────────

  it('does NOT emit a payment.* audit on payments.start (audits fire on terminal transitions only)', async () => {
    const { handler, auditEmitter } = setup();
    await handler(validRequest());
    expect(auditEmitter.captured).toHaveLength(0);
  });
});
