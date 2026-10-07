/**
 * T135 — `payments.cancel` bridge handler (Wave H GREEN).
 *
 * Cancels a `started` PaymentAttempt; the FSM iterates applied lines
 * LIFO and reverses each, then transitions the attempt to `cancelled`
 * inside one SQLite transaction (FR-006B / R-13).
 *
 * The handler is the audit-emission seam: it fires one `tender.reversed`
 * event per reversed line (LIFO order — apply_order DESC), then one
 * `payment.cancelled` event. The FSM does NOT emit audits — that
 * responsibility lives at the trust boundary so a failed reverse on
 * one line does not orphan the attempt-level audit row.
 */

import { attemptActionPayload } from '../action-payload.js';
import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { PaymentAttemptFsm } from '../fsm/payment-attempt-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type {
  PaymentTenderLineRow,
  PaymentTenderLinesRepository,
} from '../repositories/payment-tender-lines.repository.js';
import type { PaymentsCancelRequest, PaymentsCancelResponse } from '../../../shared/bridge-api.js';

export interface PaymentsCancelHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'cancel'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderReversed' | 'emitPaymentCancelled'>;
  clock: () => Date;
}

export type PaymentsCancelHandler = (req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>;

export function createPaymentsCancelHandler(
  deps: PaymentsCancelHandlerDeps,
): PaymentsCancelHandler {
  const {
    getCurrentSession,
    attemptsRepo,
    linesRepo,
    paymentAttemptFsm,
    idempotency,
    auditEmitter,
    clock,
  } = deps;

  return async function paymentsCancel(req): Promise<PaymentsCancelResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
    }

    const row = attemptsRepo.findById(req.payment_attempt_id);
    if (row === undefined) {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    // Isolation/ownership gate (same posture as payments-confirm).
    const gateIsolation = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      attempt: {
        operator_session_id: row.operator_session_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        terminal_id: row.terminal_id,
        state: 'started',
      },
    });
    if (gateIsolation.kind === 'refused' && gateIsolation.reason !== 'attempt_terminal') {
      return await Promise.resolve({ kind: 'refused', reason: gateIsolation.reason });
    }

    const reservation = idempotency.checkOrReserve({
      action_id: req.idempotency_key,
      payment_attempt_id: req.payment_attempt_id,
      tender_line_id: null,
      action_kind: 'payment.cancel',
      payload: attemptActionPayload(req),
      acting_operator_id: row.acting_operator_id,
      created_at: clock().toISOString(),
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      // Reconstruct from row state. `state='cancelled'` and `cancelled_at`
      // always co-occur (data-model §"PaymentAttempt" Invariant 2). The
      // reversed_tender_line_ids list is rebuilt from the lines repo, sorted
      // LIFO (apply_order DESC) to match the FSM's original sweep order.
      if (row.state === 'cancelled' && row.cancelled_at !== null) {
        const lines = linesRepo.findByAttempt(req.payment_attempt_id);
        const reversed: string[] = lines
          .filter((l) => l.state === 'reversed')
          .sort((a, b) => b.apply_order - a.apply_order)
          .map((l) => l.tender_line_id);
        const pending: string[] = lines
          .filter((l) => l.state === 'reversal_pending')
          .sort((a, b) => b.apply_order - a.apply_order)
          .map((l) => l.tender_line_id);
        return await Promise.resolve({
          kind: 'ok',
          cancelled_at: row.cancelled_at,
          reversed_tender_line_ids: reversed,
          reversal_pending_tender_line_ids: pending,
        });
      }
      return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
    }

    if (row.state !== 'started') {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    const cancelled_at = clock().toISOString();
    const fsmOutcome = paymentAttemptFsm.cancel({
      payment_attempt_id: req.payment_attempt_id,
      cancelled_at,
      action_id: req.idempotency_key,
    });

    if (fsmOutcome.kind === 'refused') {
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    // Per-line audits in LIFO order (matches FSM sweep). The handler reads
    // the lines AFTER the FSM transaction so each line's state reflects the
    // committed `reversed` transition (or `reversal_pending` for Slice-4
    // voucher paths, which Slice 3 does not exercise on cancel).
    const linesAfter: readonly PaymentTenderLineRow[] = linesRepo.findByAttempt(
      req.payment_attempt_id,
    );
    const lineById = new Map(linesAfter.map((l) => [l.tender_line_id, l]));
    for (const tender_line_id of fsmOutcome.reversed_tender_line_ids) {
      const line = lineById.get(tender_line_id);
      if (line === undefined) continue; // defence — FSM returned an unknown id
      auditEmitter.emitTenderReversed({
        tender_line_id,
        payment_attempt_id: req.payment_attempt_id,
        tender_type: line.tender_type,
        reversed_at: fsmOutcome.cancelled_at,
        attribution_operator_id: row.acting_operator_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        originating_terminal_id: row.terminal_id,
        session_id: session.operator_session_id,
        // FR-008 / contract §"payments.cancel" — external_card_terminal
        // reversal cannot push the void to the terminal hardware itself,
        // so the cashier-facing UX needs the manual-void reminder. Cash
        // reversal carries no till-impact event in Slice 3 (AD-9 / OQ-DRW
        // deferred).
        manual_void_required: line.tender_type === 'external_card_terminal',
      });
    }

    // Attempt-level audit fires last so the audit log records every line
    // transition before the attempt terminal-state.
    auditEmitter.emitPaymentCancelled({
      payment_attempt_id: req.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      handoff_action_id: row.envelope_handoff_action_id,
      cancelled_at: fsmOutcome.cancelled_at,
      attribution_operator_id: row.acting_operator_id,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: session.operator_session_id,
    });

    return await Promise.resolve({
      kind: 'ok',
      cancelled_at: fsmOutcome.cancelled_at,
      reversed_tender_line_ids: fsmOutcome.reversed_tender_line_ids,
      reversal_pending_tender_line_ids: fsmOutcome.reversal_pending_tender_line_ids,
    });
  };
}
