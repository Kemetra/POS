/**
 * T280 — `payments.forceFail` bridge handler (Wave 5b GREEN).
 *
 * Manager / admin incident-response action that transitions a stuck
 * `started` PaymentAttempt to `force_failed` (FR-021 / plan AD-5).
 *
 * **Security posture (FR-021):**
 *   • Role gate is MANAGER + ADMIN only. Cashier role is refused with
 *     `role_denied`. The role check is the LOAD-BEARING security
 *     control (Constitution §III); the renderer's secondary route
 *     guard is UX defence only.
 *   • Dual attribution: the audit `payment.force_failed` event records
 *     BOTH the manager actor (`force_fail_attribution_operator_id`)
 *     and the original cashier (`acting_operator_id`, immutable since
 *     `payments.start`). The bridge response carries ONLY the generic
 *     `force_failed_at` timestamp — manager identity NEVER crosses to
 *     a cashier-visible surface (FR-021 last clause).
 *   • Idempotency: identical-payload retry returns the prior outcome
 *     via the standard outbox-lookup helper (R-10).
 *
 * Audit emission uses `emitRaw` (the explicit escape hatch documented
 * at `audit-emitter.ts` line 244-249 for `payment.force_failed`).
 */

import { attemptActionPayload } from '../action-payload.js';
import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { PaymentAttemptFsm } from '../fsm/payment-attempt-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type {
  PaymentsForceFailRequest,
  PaymentsForceFailResponse,
} from '../../../shared/bridge-api.js';

export interface PaymentsForceFailHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'forceFail'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitRaw'>;
  clock: () => Date;
}

export type PaymentsForceFailHandler = (
  req: PaymentsForceFailRequest,
) => Promise<PaymentsForceFailResponse>;

export function createPaymentsForceFailHandler(
  deps: PaymentsForceFailHandlerDeps,
): PaymentsForceFailHandler {
  const { getCurrentSession, attemptsRepo, paymentAttemptFsm, idempotency, auditEmitter, clock } =
    deps;

  return async function paymentsForceFail(req): Promise<PaymentsForceFailResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
    }

    const row = attemptsRepo.findById(req.payment_attempt_id);
    if (row === undefined) {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    // Manager-only role gate (FR-021). Cashier role is refused.
    // Tenant/branch/terminal isolation still applies — a manager from
    // tenant A cannot force-fail an attempt at tenant B's terminal.
    const gate = requireOperatorSession({
      session,
      allowedRoles: ['manager', 'admin'],
      attempt: {
        operator_session_id: row.operator_session_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        terminal_id: row.terminal_id,
        state: 'started',
      },
    });
    // For force-fail, ownership (operator_session_id match) is NOT
    // required — that's the whole point: a manager intervenes on
    // someone else's stuck attempt. We accept the `wrong_owner` refusal
    // and let it through. `attempt_terminal` is also allowed through
    // so the idempotency-replay path below can return the prior
    // outcome for a row that is already `force_failed` (mirrors the
    // payments-cancel precedent).
    if (gate.kind === 'refused') {
      if (gate.reason !== 'wrong_owner' && gate.reason !== 'attempt_terminal') {
        return await Promise.resolve({ kind: 'refused', reason: gate.reason });
      }
    }

    const force_failed_at = clock().toISOString();
    const reservation = idempotency.checkOrReserve({
      action_id: req.idempotency_key,
      payment_attempt_id: req.payment_attempt_id,
      tender_line_id: null,
      action_kind: 'payment.force_fail',
      payload: attemptActionPayload(req),
      // Acting operator on the outbox = manager (the actor that
      // authorised the force-fail). The original cashier remains on
      // `payment_attempts.acting_operator_id` (immutable since
      // `payments.start`). Dual-attribution is composed at audit time.
      acting_operator_id: session.operator_id,
      created_at: force_failed_at,
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      // Reconstruct from row state. `state='force_failed'` and
      // `force_failed_at` always co-occur (data-model Invariant 2).
      if (row.state === 'force_failed' && row.force_failed_at !== null) {
        return await Promise.resolve({
          kind: 'ok',
          force_failed_at: row.force_failed_at,
        });
      }
      return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
    }

    if (row.state !== 'started') {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    const fsmOutcome = paymentAttemptFsm.forceFail({
      payment_attempt_id: req.payment_attempt_id,
      force_failed_at,
      manager_operator_id: session.operator_id,
      action_id: req.idempotency_key,
    });

    if (fsmOutcome.kind === 'refused') {
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    // Dual-attribution audit event. The audit-emitter's `emitRaw`
    // escape hatch (audit-emitter.ts line 244-249) is the documented
    // path for `payment.force_failed`.
    // Dual-attribution audit event. The top-level
    // `attribution_operator_id` records the MANAGER (the actor that
    // authorised the action — consistent with the outbox's
    // `acting_operator_id` on this row). The cashier rides inside the
    // structured payload as `original_cashier_operator_id` so the
    // audit log preserves both identities while the renderer
    // projection (FR-017 stripper) can drop the manager id before
    // surfacing the event to a cashier view.
    auditEmitter.emitRaw({
      action_category: 'payment.force_failed',
      payment_attempt_id: req.payment_attempt_id,
      attribution_operator_id: session.operator_id,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: session.operator_session_id,
      created_at: force_failed_at,
      payload: {
        force_failed_at,
        force_fail_attribution_operator_id: session.operator_id,
        original_cashier_operator_id: row.acting_operator_id,
      },
    });

    // No `reservation.commit()` here: `paymentAttemptFsm.forceFail` writes
    // the outbox row itself, in the same transaction as the state change
    // (same pattern as payments-start / tender-apply). Committing again
    // inserted the same `action_id` twice and threw a UNIQUE violation AFTER
    // the force-fail had already committed (RT-304). A same-key retry now
    // observes `kind: 'replay'` from the FSM's own row.
    return await Promise.resolve({
      kind: 'ok',
      force_failed_at: fsmOutcome.force_failed_at,
    });
  };
}
