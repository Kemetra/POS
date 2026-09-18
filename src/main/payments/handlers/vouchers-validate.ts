/**
 * 006 T260 — `vouchers.validate` bridge handler (Wave 4 GREEN).
 *
 * Standalone voucher entry on the bridge surface (§A4-B authorisation
 * 2026-05-25). Wraps `requireOperatorSession` + idempotency + the
 * shared `applyVoucherLine` helper.
 *
 * Sequence:
 *   1. Session/role/isolation/terminal-state gate.
 *   2. Idempotency replay check: replay reconstructs the prior outcome
 *      from the persisted line (`applied` → ok; `refused` → refusal).
 *   3. Compute `remaining_balance_minor` main-side (Constitution §VIII —
 *      the renderer does NOT send the cap; the authority enforces it
 *      per research §R-7).
 *   4. Delegate to `applyVoucherLine` (V-A call + FSM apply + audit).
 *   5. Project the response — `voucher_redemption_intent_token` and
 *      `intent_expires_at` are stripped (FR-017).
 *
 * **JSDoc map vs T263:** this handler and the voucher branch of
 * `tender.apply` (T263) share the same `applyVoucherLine` helper. Two
 * bridge entry points, one V-A call site each. The observable state is
 * identical between the two paths.
 */

import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';
import type {
  VouchersValidateRequest,
  VouchersValidateResponse,
} from '../../../shared/bridge-api.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../voucher-authority-client/validate.js';

import { applyVoucherLine } from './apply-voucher-line.js';

export interface VouchersValidateHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  tenderLineFsm: Pick<TenderLineFsm, 'apply'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderApplied' | 'emitTenderRefused'>;
  validateVoucher: (input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>;
  uuid: () => string;
  clock: () => Date;
}

export type VouchersValidateHandler = (
  req: VouchersValidateRequest,
) => Promise<VouchersValidateResponse>;

export function createVouchersValidateHandler(
  deps: VouchersValidateHandlerDeps,
): VouchersValidateHandler {
  const {
    getCurrentSession,
    attemptsRepo,
    linesRepo,
    tenderLineFsm,
    idempotency,
    auditEmitter,
    validateVoucher,
    uuid,
    clock,
  } = deps;

  return async function vouchersValidate(req): Promise<VouchersValidateResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return { kind: 'refused', reason: 'no_session' };
    }

    if (!Number.isSafeInteger(req.amount_applied_minor) || req.amount_applied_minor < 0) {
      return { kind: 'refused', reason: 'invalid_input' };
    }

    const attempt = attemptsRepo.findById(req.payment_attempt_id);
    if (attempt === undefined) {
      return { kind: 'refused', reason: 'attempt_terminal' };
    }

    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      attempt: {
        operator_session_id: attempt.operator_session_id,
        tenant_id: attempt.tenant_id,
        branch_id: attempt.branch_id,
        terminal_id: attempt.terminal_id,
        state: attempt.state,
      },
    });
    if (gate.kind === 'refused') {
      return { kind: 'refused', reason: gate.reason };
    }

    const now = clock().toISOString();
    const tender_line_id = uuid();

    const reservation = idempotency.checkOrReserve({
      action_id: req.idempotency_key,
      payment_attempt_id: req.payment_attempt_id,
      tender_line_id,
      action_kind: 'tender.apply',
      payload: {
        payment_attempt_id: req.payment_attempt_id,
        tender_type: 'internal_voucher',
        amount_applied_minor: req.amount_applied_minor,
        // voucher_code is stripped by the helper before hashing
        // (STRIP_KEYS in idempotency.ts).
        voucher_code: req.voucher_code,
      },
      acting_operator_id: session.operator_id,
      created_at: now,
    });

    if (reservation.kind === 'mismatch') {
      return { kind: 'refused', reason: 'idempotency_payload_mismatch' };
    }

    if (reservation.kind === 'replay') {
      const lines = linesRepo.findByAttempt(req.payment_attempt_id);
      const prior = lines.find((l) => l.last_action_id === req.idempotency_key);
      if (prior !== undefined && prior.state === 'applied' && prior.applied_at !== null) {
        return {
          kind: 'ok',
          tender_line_id: prior.tender_line_id,
          applied_amount_minor: prior.amount_applied_minor,
          applied_at: prior.applied_at,
        };
      }
      if (prior !== undefined && prior.state === 'refused' && prior.refusal_reason !== null) {
        return {
          kind: 'refused',
          reason: prior.refusal_reason as VouchersValidateResponse extends { reason: infer R }
            ? R
            : never,
        };
      }
      return { kind: 'refused', reason: 'internal_error' };
    }

    // Compute remaining balance main-side (R-7; cap enforcement is V-A's
    // job — POS sends the local view so V-A can refuse with
    // `non_cash_overpayment_refused` when the cashier's input exceeds
    // either the authoritative voucher balance OR the remaining
    // attempt-side balance, whichever is smaller).
    const existing = linesRepo.findByAttempt(req.payment_attempt_id);
    let appliedNetSum = 0;
    for (const line of existing) {
      if (line.state !== 'applied') continue;
      appliedNetSum += line.amount_applied_minor - (line.change_due_minor ?? 0);
    }
    const remaining_balance_minor = attempt.envelope_subtotal_minor - appliedNetSum;

    const outcome = await applyVoucherLine(
      {
        session,
        attempt,
        tender_line_id,
        voucher_code: req.voucher_code,
        amount_applied_minor: req.amount_applied_minor,
        remaining_balance_minor,
        applied_at: now,
        action_id: req.idempotency_key,
      },
      {
        validateVoucher,
        tenderLineFsm,
        auditEmitter,
      },
    );

    if (outcome.kind === 'refused') {
      return { kind: 'refused', reason: outcome.reason };
    }
    return {
      kind: 'ok',
      tender_line_id: outcome.tender_line_id,
      applied_amount_minor: outcome.applied_amount_minor,
      applied_at: outcome.applied_at,
    };
  };
}
