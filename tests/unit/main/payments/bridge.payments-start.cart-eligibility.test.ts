/* eslint-disable @typescript-eslint/unbound-method -- vi.fn doubles, as in bridge.payments-start.test.ts */
/**
 * `payments.start` consults main's cart eligibility BEFORE the FSM opens an
 * attempt. A refusal passes through unchanged and nothing is started; the
 * session scope (never the request) supplies tenant and branch.
 */

import { describe, it, expect, vi } from 'vitest';

import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import type { PaymentsStartRequest } from '../../../../src/shared/bridge-api.js';
import {
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makePaymentAttemptFsmDouble,
  makeSession,
  makeSessionSource,
} from './__fixtures__/bridge-handler-deps.js';

function request(): PaymentsStartRequest {
  return {
    envelope_version: 'v1',
    envelope_cart_id: 'cart-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_subtotal_minor: 5500,
    idempotency_key: 'start-1',
  };
}

function build(checkCartForPayment: ReturnType<typeof vi.fn>) {
  const fsm = makePaymentAttemptFsmDouble();
  const handler = createPaymentsStartHandler({
    getCurrentSession: makeSessionSource(makeSession()).getCurrentSession,
    attemptsRepo: makeAttemptsRepoDouble(),
    paymentAttemptFsm: fsm,
    idempotency: makeIdempotencyHelperDouble(),
    auditEmitter: makeAuditEmitterDouble(),
    uuid: () => 'pa-1',
    clock: () => new Date('2026-09-25T11:00:00.000Z'),
    checkCartForPayment,
    attemptHasLiveTender: () => false,
  });
  return { handler, fsm };
}

describe('payments.start — cart eligibility', () => {
  it.each(['cart_lost', 'stale_handoff', 'attempt_terminal'] as const)(
    'refuses %s from main without starting an attempt',
    async (reason) => {
      const check = vi.fn().mockReturnValue({ kind: 'refused', reason });
      const { handler, fsm } = build(check);
      expect(await handler(request())).toEqual({ kind: 'refused', reason });
      expect(fsm.start).not.toHaveBeenCalled();
    },
  );

  it('checks the request against the session scope, then starts the attempt', async () => {
    const check = vi.fn().mockReturnValue({ kind: 'ok' });
    const { handler, fsm } = build(check);
    const session = makeSession();
    await handler(request());
    expect(check).toHaveBeenCalledWith({
      envelope_cart_id: 'cart-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_subtotal_minor: 5500,
      tenant_id: session.tenant_id,
      branch_id: session.branch_id,
    });
    expect(fsm.start).toHaveBeenCalledOnce();
  });
});
