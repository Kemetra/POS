/**
 * Regression — stale started-attempt MUST NOT block/leak into a new cart's checkout.
 *
 * Root cause (DB-evidenced 2026-06-19): a `started` payment attempt for cart A
 * persists on terminal T (never settled/cancelled). When a NEW checkout begins
 * for cart B on the same terminal, `payments.start` calls
 * `findStartedByTerminal(T)`, finds cart A's attempt, and the FSM refuses
 * `attempt_already_started_on_terminal`. Cart B can then never open a clean
 * payment attempt — it inherits cart A's state (remaining already 0) → cashier
 * cannot settle.
 *
 * Required behavior: a fresh checkout for a DIFFERENT cart must recover safely —
 * the stale attempt is discarded and a clean attempt is started for cart B.
 *
 * Fake-driven (DI seams on the handler) — no better-sqlite3, no Electron, no DB.
 */

import { describe, it, expect } from 'vitest';

import { createPaymentsStartHandler } from '../payments-start.js';
import type { PaymentsStartHandlerDeps } from '../payments-start.js';
import type { OperatorSessionForPayments } from '../../require-operator-session.js';
import type { PaymentAttemptRow } from '../../repositories/payment-attempts.repository.js';

const TERMINAL = 'terminal-T';
const CART_A = 'cart-A-0000-0000-0000-000000000001';
const CART_B = 'cart-B-0000-0000-0000-000000000002';

const SESSION: OperatorSessionForPayments = {
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: TERMINAL,
  role: 'manager',
} as OperatorSessionForPayments;

/** A stale `started` attempt bound to cart A on terminal T. */
function staleAttemptForCartA(): PaymentAttemptRow {
  return {
    payment_attempt_id: 'attempt-A',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: TERMINAL,
    acting_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-A',
    envelope_cart_id: CART_A,
    envelope_subtotal_minor: 1250,
    state: 'started',
    started_at: '2026-06-19T06:00:00.000Z',
    settled_at: null,
    cancelled_at: null,
    failed_at: null,
    force_failed_at: null,
    failure_reason: null,
    force_fail_attribution_operator_id: null,
    last_action_id: 'action-A',
  } as unknown as PaymentAttemptRow;
}

function makeDeps(overrides: Partial<PaymentsStartHandlerDeps>): PaymentsStartHandlerDeps {
  return {
    getCurrentSession: () => SESSION,
    attemptsRepo: { findStartedByTerminal: () => undefined },
    // Default FSM mirrors production: it refuses if a started attempt exists on
    // the terminal. Tests that need a clean start inject a fake that succeeds.
    paymentAttemptFsm: {
      start: () => ({ kind: 'ok', payment_attempt_id: 'attempt-B' }),
      cancel: () => ({
        kind: 'ok',
        cancelled_at: '2026-06-19T09:00:00.000Z',
        reversed_tender_line_ids: [],
        reversal_pending_tender_line_ids: [],
      }),
    },
    idempotency: {
      checkOrReserve: () => ({ kind: 'fresh', commit: () => {} }),
    },
    auditEmitter: {} as PaymentsStartHandlerDeps['auditEmitter'],
    uuid: () => 'attempt-B',
    clock: () => new Date('2026-06-19T09:00:00.000Z'),
    // Required since the §A4 cart-eligibility check; these cases are not about it.
    checkCartForPayment: () => ({ kind: 'ok' }),
    ...overrides,
  };
}

describe('payments.start — stale started-attempt for a different cart must not block a new checkout', () => {
  it('starts a CLEAN attempt for cart B even though a stale started attempt for cart A exists on the terminal', async () => {
    const stale = staleAttemptForCartA();

    // Production-faithful FSM: refuses when a started attempt already exists on
    // the terminal (this is exactly payment-attempt-fsm.ts:152-155). Cancelling
    // the stale attempt clears that `started` row so a subsequent start succeeds.
    let cancelledStale = false;
    const fsmStart: PaymentsStartHandlerDeps['paymentAttemptFsm']['start'] = (input) => {
      if (!cancelledStale && stale.state === 'started' && stale.terminal_id === input.terminal_id) {
        return { kind: 'refused', reason: 'attempt_already_started_on_terminal' };
      }
      return { kind: 'ok', payment_attempt_id: input.payment_attempt_id };
    };
    const fsmCancel: PaymentsStartHandlerDeps['paymentAttemptFsm']['cancel'] = (input) => {
      if (input.payment_attempt_id === stale.payment_attempt_id) cancelledStale = true;
      return {
        kind: 'ok',
        cancelled_at: '2026-06-19T09:00:00.000Z',
        reversed_tender_line_ids: [],
        reversal_pending_tender_line_ids: [],
      };
    };

    const handler = createPaymentsStartHandler(
      makeDeps({
        attemptsRepo: { findStartedByTerminal: () => stale },
        paymentAttemptFsm: { start: fsmStart, cancel: fsmCancel },
      }),
    );

    const res = await handler({
      envelope_handoff_action_id: 'handoff-B',
      envelope_cart_id: CART_B,
      envelope_subtotal_minor: 1250,
      envelope_version: 'v1',
      idempotency_key: 'idem-B',
    });

    // Cart B must get a clean started attempt — NOT a refusal caused by cart A's
    // orphan. (Today this FAILS: the orphan makes the FSM refuse
    // attempt_already_started_on_terminal.)
    expect(res.kind).toBe('ok');
  });

  it('cancels the stale attempt exactly once, for the orphan id, before starting cart B', async () => {
    const stale = staleAttemptForCartA();
    const cancelCalls: string[] = [];
    let cancelled = false;
    const handler = createPaymentsStartHandler(
      makeDeps({
        attemptsRepo: { findStartedByTerminal: () => stale },
        paymentAttemptFsm: {
          start: (input) =>
            !cancelled && stale.terminal_id === input.terminal_id
              ? { kind: 'refused', reason: 'attempt_already_started_on_terminal' }
              : { kind: 'ok', payment_attempt_id: input.payment_attempt_id },
          cancel: (input) => {
            cancelCalls.push(input.payment_attempt_id);
            cancelled = true;
            return {
              kind: 'ok',
              cancelled_at: '2026-06-19T09:00:00.000Z',
              reversed_tender_line_ids: [],
              reversal_pending_tender_line_ids: [],
            };
          },
        },
      }),
    );

    const res = await handler({
      envelope_handoff_action_id: 'handoff-B',
      envelope_cart_id: CART_B,
      envelope_subtotal_minor: 1250,
      envelope_version: 'v1',
      idempotency_key: 'idem-B',
    });

    expect(res.kind).toBe('ok');
    expect(cancelCalls).toEqual([stale.payment_attempt_id]); // exactly once, the orphan
  });

  it('does NOT cancel when the existing started attempt belongs to the SAME cart (split-tender / duplicate-start is the FSM’s concern)', async () => {
    const sameCart = staleAttemptForCartA();
    const cancelCalls: string[] = [];
    const handler = createPaymentsStartHandler(
      makeDeps({
        attemptsRepo: { findStartedByTerminal: () => sameCart },
        paymentAttemptFsm: {
          // Same cart → FSM owns the duplicate/split-tender decision; the handler
          // must NOT discard it. Here the FSM refuses (duplicate start), which is
          // the correct pre-existing behavior — the handler passes it through.
          start: () => ({ kind: 'refused', reason: 'attempt_already_started_on_terminal' }),
          cancel: (input) => {
            cancelCalls.push(input.payment_attempt_id);
            return {
              kind: 'ok',
              cancelled_at: '2026-06-19T09:00:00.000Z',
              reversed_tender_line_ids: [],
              reversal_pending_tender_line_ids: [],
            };
          },
        },
      }),
    );

    const res = await handler({
      envelope_handoff_action_id: 'handoff-A2',
      envelope_cart_id: CART_A, // SAME cart as the existing started attempt
      envelope_subtotal_minor: 1250,
      envelope_version: 'v1',
      idempotency_key: 'idem-A2',
    });

    expect(cancelCalls).toEqual([]); // never cancels a same-cart attempt
    expect(res.kind).toBe('refused'); // pre-existing duplicate-start behavior preserved
  });

  it('starts cleanly when there is NO existing started attempt (baseline — no cancel)', async () => {
    const cancelCalls: string[] = [];
    const handler = createPaymentsStartHandler(
      makeDeps({
        attemptsRepo: { findStartedByTerminal: () => undefined },
        paymentAttemptFsm: {
          start: (input) => ({ kind: 'ok', payment_attempt_id: input.payment_attempt_id }),
          cancel: (input) => {
            cancelCalls.push(input.payment_attempt_id);
            return {
              kind: 'ok',
              cancelled_at: '2026-06-19T09:00:00.000Z',
              reversed_tender_line_ids: [],
              reversal_pending_tender_line_ids: [],
            };
          },
        },
      }),
    );

    const res = await handler({
      envelope_handoff_action_id: 'handoff-C',
      envelope_cart_id: 'cart-C-0000-0000-0000-000000000003',
      envelope_subtotal_minor: 1250,
      envelope_version: 'v1',
      idempotency_key: 'idem-C',
    });

    expect(res.kind).toBe('ok');
    expect(cancelCalls).toEqual([]); // nothing to discard
  });
});
