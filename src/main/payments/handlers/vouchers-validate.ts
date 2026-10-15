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

import { tenderApplyActionPayload } from '../action-payload.js';
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

import { applyVoucherForRequest } from './apply-voucher-line.js';
import { priorLineOutcome } from './prior-line-outcome.js';

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

type LineRow = ReturnType<PaymentTenderLinesRepository['findByAttempt']>[number];

/** The answer to a replayed voucher-validate key, rebuilt from the persisted line. */
function replayResponse(prior: LineRow | undefined): VouchersValidateResponse {
  const outcome = priorLineOutcome(prior);
  if (outcome.kind === 'applied') {
    return {
      kind: 'ok',
      tender_line_id: outcome.line.tender_line_id,
      applied_amount_minor: outcome.line.amount_applied_minor,
      applied_at: outcome.line.applied_at,
    };
  }
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason };
  return { kind: 'refused', reason: 'internal_error' };
}

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
      // voucher_code is stripped at the hash boundary (action-payload.ts);
      // the FSM hashes this same shape when it writes the outbox row.
      payload: tenderApplyActionPayload({
        payment_attempt_id: req.payment_attempt_id,
        tender_type: 'internal_voucher',
        amount_applied_minor: req.amount_applied_minor,
        voucher_code: req.voucher_code,
      }),
      acting_operator_id: session.operator_id,
      created_at: now,
    });

    if (reservation.kind === 'mismatch') {
      return { kind: 'refused', reason: 'idempotency_payload_mismatch' };
    }

    if (reservation.kind === 'replay') {
      // Found by the outbox row's immutable `tender_line_id`: `last_action_id`
      // and `state` move on once the line is reversed (RT-304 review).
      const lines = linesRepo.findByAttempt(req.payment_attempt_id);
      const prior = lines.find((l) => l.tender_line_id === reservation.tender_line_id);
      return replayResponse(prior);
    }

    const outcome = await applyVoucherForRequest(
      req,
      {
        session,
        attempt,
        tender_line_id,
        now,
        existingLines: linesRepo.findByAttempt(req.payment_attempt_id),
      },
      { validateVoucher, tenderLineFsm, auditEmitter },
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
