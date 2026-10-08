/**
 * RT-26 — payments-side authority for Checkout Back.
 *
 * `cart.returnToSale` may return a handed-off cart to `editing` only when the
 * payments record PROVES nothing about money or an external payment happened
 * for that cart. The proof is deliberately strict and read from the durable
 * tables, never from the renderer:
 *
 *   - no `settled` attempt              (the sale is paid);
 *   - no `force_failed` attempt         (tender may have been taken);
 *   - no tender line, in ANY state, on ANY attempt for the cart. An `applied`
 *     line is money; `applying` / `reversal_pending` are external operations
 *     in flight or unresolved (UNKNOWN); a `refused` or `reversed` line means
 *     the cashier already interacted with a tender (a card terminal may need a
 *     manual void). Any of those keeps the cashier in the controlled payment /
 *     recovery flow (payments.cancel, manager post-handoff cancel) instead.
 *
 * Cancelled / failed attempts WITHOUT tender lines are history (a stale-attempt
 * discard, a session-end sweep, a payments.cancel before any tender) and do not
 * block.
 *
 * A `started` attempt that passes the proof is a zero-funds open attempt: it is
 * cancelled here through the payment FSM (its own outbox row) with its
 * `payment.cancelled` audit, so there is never a second open attempt and the
 * old one can never be confirmed. `release` runs INSIDE the cart transaction
 * (`returnFrozenCartToSaleAndOutbox`), so the attempt cancel, the cart
 * transition, the envelope invalidation and both audit rows commit or roll back
 * together. Everything is synchronous: main is single-threaded and no await
 * separates this check from the writes, so a concurrent `payments.confirm` /
 * `tender.apply` / `payments.start` is ordered strictly before or after it.
 */

import type { DatabaseHandle } from '../db/client.js';
import type { PaymentAttemptFsm } from './fsm/payment-attempt-fsm.js';
import type { PaymentAuditEmitter } from './audit-emitter.js';

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

export interface CartAttemptRow {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  state: string;
}

export interface CheckoutReturnRequest {
  readonly cart_id: string;
  /** The handoff the renderer is leaving (already verified as the cart's latest). */
  readonly handoff_action_id: string;
  /** The Back's idempotency key; namespaces the attempt-cancel action id. */
  readonly action_id: string;
  /** ISO timestamp shared with the cart transition. */
  readonly at: string;
  /** Operator session performing the Back (audit attribution). */
  readonly session_id: string;
}

/**
 * `released` — nothing blocks the return; `cancelled_attempt_id` names the
 * zero-funds started attempt this call cancelled, or null when there was none.
 * `blocked` — the payments record cannot prove no money / external activity;
 * nothing was written.
 */
export type CheckoutReturnOutcome =
  | { readonly kind: 'released'; readonly cancelled_attempt_id: string | null }
  | { readonly kind: 'blocked' };

export type ReleaseCheckoutPayment = (req: CheckoutReturnRequest) => CheckoutReturnOutcome;

export interface CheckoutReturnGuardDeps {
  db: DatabaseHandle;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'cancel'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitPaymentCancelled'>;
}

/** Attempt states that close a cart to Back regardless of tender lines. */
const BLOCKING_ATTEMPT_STATES: ReadonlySet<string> = new Set(['settled', 'force_failed']);

/**
 * The one started attempt bound to this handoff, or null. At most one started
 * attempt exists per terminal (0013) and a cart lives on one terminal; more
 * than one, or one bound to another handoff, is not a state this proof covers
 * — refuse rather than guess.
 */
function soleAttemptForHandoff(
  started: readonly CartAttemptRow[],
  handoffActionId: string,
): CartAttemptRow | null {
  const [open] = started;
  if (started.length !== 1 || open === undefined) return null;
  return open.envelope_handoff_action_id === handoffActionId ? open : null;
}

/**
 * The read half of the proof, shared by the guard (which then writes) and the
 * read-only eligibility query (which never writes). `clear` names the
 * zero-funds started attempt Back would cancel, or null when there is none.
 */
export type CheckoutReturnAssessment =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'clear'; readonly open: CartAttemptRow | null };

export type AssessCheckoutReturn = (req: {
  readonly cart_id: string;
  readonly handoff_action_id: string;
}) => CheckoutReturnAssessment;

/** Read-only: what the payments record says about a Back for this cart and handoff. */
export function bindCheckoutReturnAssessment(db: DatabaseHandle): AssessCheckoutReturn {
  const attemptsStmt = db.prepare(
    `SELECT payment_attempt_id, tenant_id, branch_id, terminal_id, acting_operator_id,
            envelope_handoff_action_id, envelope_cart_id, state
       FROM payment_attempts
      WHERE envelope_cart_id = ?`,
  ) as PrepareAll<CartAttemptRow>;
  const anyTenderStmt = db.prepare(
    `SELECT 1 AS any_line FROM payment_tender_lines t
       JOIN payment_attempts a ON a.payment_attempt_id = t.payment_attempt_id
      WHERE a.envelope_cart_id = ?
      LIMIT 1`,
  ) as PrepareGet<{ any_line: 1 }>;

  return (req) => {
    const attempts = attemptsStmt.all(req.cart_id);
    if (attempts.some((a) => BLOCKING_ATTEMPT_STATES.has(a.state))) return { kind: 'blocked' };
    if (anyTenderStmt.get(req.cart_id) !== undefined) return { kind: 'blocked' };

    const started = attempts.filter((a) => a.state === 'started');
    if (started.length === 0) return { kind: 'clear', open: null };
    const open = soleAttemptForHandoff(started, req.handoff_action_id);
    return open === null ? { kind: 'blocked' } : { kind: 'clear', open };
  };
}

/** Read-only boolean form for `cart.returnToSaleEligibility`: never writes. */
export function bindCheckoutReturnAllowed(
  db: DatabaseHandle,
): (req: { readonly cart_id: string; readonly handoff_action_id: string }) => boolean {
  const assess = bindCheckoutReturnAssessment(db);
  return (req) => assess(req).kind === 'clear';
}

export function bindCheckoutReturnGuard(deps: CheckoutReturnGuardDeps): ReleaseCheckoutPayment {
  const assess = bindCheckoutReturnAssessment(deps.db);

  return (req) => {
    const assessment = assess(req);
    if (assessment.kind === 'blocked') return { kind: 'blocked' };
    const { open } = assessment;
    if (open === null) return { kind: 'released', cancelled_attempt_id: null };

    const cancelled = deps.paymentAttemptFsm.cancel({
      payment_attempt_id: open.payment_attempt_id,
      cancelled_at: req.at,
      action_id: `${req.action_id}:payment-cancel`,
    });
    if (cancelled.kind !== 'ok') return { kind: 'blocked' };
    deps.auditEmitter.emitPaymentCancelled({
      payment_attempt_id: open.payment_attempt_id,
      cart_id: open.envelope_cart_id,
      handoff_action_id: open.envelope_handoff_action_id,
      cancelled_at: cancelled.cancelled_at,
      attribution_operator_id: open.acting_operator_id,
      tenant_id: open.tenant_id,
      branch_id: open.branch_id,
      originating_terminal_id: open.terminal_id,
      session_id: req.session_id,
    });
    return { kind: 'released', cancelled_attempt_id: open.payment_attempt_id };
  };
}
