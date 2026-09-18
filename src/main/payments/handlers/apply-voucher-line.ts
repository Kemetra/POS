/**
 * 006 Wave 4 — shared helper for voucher V-A `validate` + line persistence.
 *
 * Drives the V-A `validateVoucher` client + the TenderLine FSM. Used by
 * both `vouchers.validate` (T260; standalone bridge entry) and
 * `tender.apply` (T263; voucher branch of the unified tender entry).
 * Both call sites produce identical observable state because they share
 * this helper.
 *
 * Sequence:
 *   1. The caller has already gated session/role/isolation/idempotency
 *      via `requireOperatorSession` + `idempotency.checkOrReserve`.
 *   2. This helper calls `validateVoucher` (HTTP — must happen outside
 *      any SQLite transaction).
 *   3. The V-A outcome (validated / refused / authority_unreachable) is
 *      mapped to a TenderLineFsm `apply` call:
 *        • `validated` → fsm.apply with `voucher_outcome.kind='validated'`
 *        • `refused`   → fsm.apply with `voucher_outcome.kind='refused'`
 *          (the FSM persists a refused-state row + outbox row in one txn)
 *        • `authority_unreachable` → no FSM call; refusal envelope
 *          `dependency_unavailable` is returned. No persisted line.
 *   4. Audit emission on FSM outcome (tender.applied or tender.refused).
 *
 * FR-017: the bridge response never carries
 * `voucher_redemption_intent_token` — that field is persisted main-side
 * via the FSM's `voucher_outcome` thread and never crosses to the
 * renderer (the response is the closed minimised shape).
 *
 * F-A4B-001: closed-set refusal mapping is the V-A client's
 * responsibility (`mapRefusalCode` in `refusal-mapping.ts`); this
 * helper does NOT introduce a parallel mapping path.
 *
 * F-A4B-002: this module imports nothing from admin `Voucher*` schemas —
 * only the V-A client types + the bridge-api `TenderApplyResponse`.
 */

import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptRow } from '../repositories/payment-attempts.repository.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../voucher-authority-client/validate.js';

export interface ApplyVoucherLineDeps {
  validateVoucher: (input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>;
  tenderLineFsm: Pick<TenderLineFsm, 'apply'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderApplied' | 'emitTenderRefused'>;
}

export interface ApplyVoucherLineInput {
  session: OperatorSessionForPayments;
  attempt: PaymentAttemptRow;
  tender_line_id: string;
  voucher_code: string;
  amount_applied_minor: number;
  remaining_balance_minor: number;
  applied_at: string;
  action_id: string;
}

export type ApplyVoucherLineOutcome =
  | {
      kind: 'ok';
      tender_line_id: string;
      applied_at: string;
      /** Authority-confirmed amount; equals input when V-A validates without capping. */
      applied_amount_minor: number;
    }
  | {
      kind: 'refused';
      reason:
        | 'voucher_not_found'
        | 'voucher_expired'
        | 'voucher_cancelled'
        | 'voucher_already_redeemed'
        | 'voucher_tenant_mismatch'
        | 'voucher_branch_mismatch'
        | 'non_cash_overpayment_refused'
        | 'dependency_unavailable'
        | 'internal_error';
    };

/**
 * Run the V-A validate + persist-line flow. The caller owns
 * session/role/isolation/idempotency gating; this helper only handles
 * the V-A call + FSM apply + audit emission.
 */
export async function applyVoucherLine(
  input: ApplyVoucherLineInput,
  deps: ApplyVoucherLineDeps,
): Promise<ApplyVoucherLineOutcome> {
  const outcome = await deps.validateVoucher({
    code: input.voucher_code,
    payment_attempt_id: input.attempt.payment_attempt_id,
    applied_amount_minor: input.amount_applied_minor,
    remaining_balance_minor: input.remaining_balance_minor,
  });

  if (outcome.kind === 'authority_unreachable') {
    // No FSM call, no persisted line — the cashier can retry. Same
    // posture as `tender.apply` for any unrecoverable pre-FSM refusal.
    return { kind: 'refused', reason: 'dependency_unavailable' };
  }

  if (outcome.kind === 'refused') {
    const mapped = mapClosedRefusal(outcome.reason);
    // FSM persists a `refused`-state row (mirrors external_card_terminal
    // overpayment refusal behaviour). The handler trusts the V-A refusal
    // verbatim; the FSM call's purpose is row persistence + outbox.
    deps.tenderLineFsm.apply({
      tender_line_id: input.tender_line_id,
      payment_attempt_id: input.attempt.payment_attempt_id,
      tender_type: 'internal_voucher',
      amount_applied_minor: input.amount_applied_minor,
      voucher_code: input.voucher_code,
      voucher_outcome: { kind: 'refused', reason: mapped },
      attribution_operator_id: input.session.operator_id,
      applied_at: input.applied_at,
      action_id: input.action_id,
    });
    deps.auditEmitter.emitTenderRefused({
      tender_line_id: input.tender_line_id,
      payment_attempt_id: input.attempt.payment_attempt_id,
      tender_type: 'internal_voucher',
      refusal_reason: mapped,
      refused_at: input.applied_at,
      attribution_operator_id: input.session.operator_id,
      tenant_id: input.attempt.tenant_id,
      branch_id: input.attempt.branch_id,
      originating_terminal_id: input.attempt.terminal_id,
      session_id: input.session.operator_session_id,
    });
    return { kind: 'refused', reason: mapped };
  }

  // V-A validated. Thread the validated outcome into the FSM; the line
  // is persisted with `voucher_redemption_intent_token` set main-side.
  const fsmOutcome = deps.tenderLineFsm.apply({
    tender_line_id: input.tender_line_id,
    payment_attempt_id: input.attempt.payment_attempt_id,
    tender_type: 'internal_voucher',
    amount_applied_minor: outcome.applied_amount_minor,
    voucher_code: input.voucher_code,
    voucher_outcome: {
      kind: 'validated',
      redemption_intent_token: outcome.redemption_intent_token,
      applied_amount_minor: outcome.applied_amount_minor,
    },
    attribution_operator_id: input.session.operator_id,
    applied_at: input.applied_at,
    action_id: input.action_id,
  });

  if (fsmOutcome.kind === 'refused') {
    // FSM authority-side overpayment refusal (the FSM compared
    // `outcome.applied_amount_minor` against the local remaining balance
    // and refused). Persist + audit accordingly.
    deps.auditEmitter.emitTenderRefused({
      tender_line_id: input.tender_line_id,
      payment_attempt_id: input.attempt.payment_attempt_id,
      tender_type: 'internal_voucher',
      refusal_reason: fsmOutcome.reason,
      refused_at: input.applied_at,
      attribution_operator_id: input.session.operator_id,
      tenant_id: input.attempt.tenant_id,
      branch_id: input.attempt.branch_id,
      originating_terminal_id: input.attempt.terminal_id,
      session_id: input.session.operator_session_id,
    });
    return {
      kind: 'refused',
      reason: 'non_cash_overpayment_refused',
    };
  }

  deps.auditEmitter.emitTenderApplied({
    tender_line_id: fsmOutcome.tender_line_id,
    payment_attempt_id: input.attempt.payment_attempt_id,
    tender_type: 'internal_voucher',
    amount_applied_minor: outcome.applied_amount_minor,
    applied_at: fsmOutcome.applied_at,
    attribution_operator_id: input.session.operator_id,
    tenant_id: input.attempt.tenant_id,
    branch_id: input.attempt.branch_id,
    originating_terminal_id: input.attempt.terminal_id,
    session_id: input.session.operator_session_id,
  });

  return {
    kind: 'ok',
    tender_line_id: fsmOutcome.tender_line_id,
    applied_at: fsmOutcome.applied_at,
    applied_amount_minor: outcome.applied_amount_minor,
  };
}

/**
 * Map the V-A client's `VoucherRefusalReason` (broad closed set from
 * `refusal-mapping.ts`) to the narrower bridge-facing refusal subset
 * advertised by `tender.apply` / `vouchers.validate` responses
 * (contracts/bridge-api.md §"tender.apply" voucher branch).
 *
 * F-A4B-001 — every code in the V-A client's literal-union is already
 * validated against the closed set. Codes that are not in the
 * bridge-facing subset (e.g., `store_context_required`,
 * `idempotency_key_required`, intent-token states) collapse to
 * `validation_failure`-equivalent semantics; we surface them as
 * `non_cash_overpayment_refused` only when the V-A client returns it
 * verbatim, otherwise as generic `voucher_not_found` — but every value
 * here is exhaustively typed so a future widening fails compile.
 */
function mapClosedRefusal(
  code:
    | 'voucher_not_found'
    | 'voucher_expired'
    | 'voucher_cancelled'
    | 'voucher_already_redeemed'
    | 'voucher_tenant_mismatch'
    | 'voucher_branch_mismatch'
    | 'non_cash_overpayment_refused'
    | 'validation_failure'
    | 'store_context_required'
    | 'idempotency_key_required'
    | 'idempotency_key_malformed'
    | 'idempotency_key_conflict'
    | 'intent_token_not_found'
    | 'intent_token_expired'
    | 'intent_token_payment_attempt_mismatch'
    | 'redemption_not_found'
    | 'redemption_tenant_mismatch'
    | 'redemption_branch_mismatch',
):
  | 'voucher_not_found'
  | 'voucher_expired'
  | 'voucher_cancelled'
  | 'voucher_already_redeemed'
  | 'voucher_tenant_mismatch'
  | 'voucher_branch_mismatch'
  | 'non_cash_overpayment_refused' {
  switch (code) {
    case 'voucher_not_found':
    case 'voucher_expired':
    case 'voucher_cancelled':
    case 'voucher_already_redeemed':
    case 'voucher_tenant_mismatch':
    case 'voucher_branch_mismatch':
    case 'non_cash_overpayment_refused':
      return code;
    // Validation-failure / idempotency / intent-token / redemption codes
    // are out-of-band for the cashier-facing surface — the cashier sees
    // the generic "voucher cannot be used" copy. Map to voucher_not_found
    // (closed enum on the bridge response per
    // F-A4B-003: 8→1 generic copy mapping). The structured V-A code
    // continues to flow into Sentry/audit via the V-A client's logger.
    default:
      return 'voucher_not_found';
  }
}
