/**
 * T139 — `tender.apply` bridge handler (Wave H GREEN).
 *
 * Applies a tender line to a `started` PaymentAttempt. The TenderLine
 * FSM owns the per-tender-type rules (cash overpay → change_due_minor,
 * external_card_terminal exact-only, voucher = tender_not_yet_supported
 * in Slice 3). The handler routes refusals through unchanged and emits
 * the per-line audit event (`tender.applied` or `tender.refused`).
 *
 * Audit emission policy (T105):
 *   • FSM ok                              → emit `tender.applied`
 *   • FSM refused: non_cash_overpayment_refused → emit `tender.refused`
 *     (a refused tender line is still a real recorded event — the
 *     cashier attempted to apply, the line row exists in state='refused',
 *     and the audit trail must reflect it)
 *   • All other refusals (no_session, role_denied, attempt_terminal,
 *     tender_not_yet_supported, idempotency_*) → no audit (the line was
 *     never persisted)
 *
 * SECURITY:
 *   • `voucher_code` is forwarded to the FSM but NEVER appears in the
 *     bridge response (the FSM returns `tender_not_yet_supported` for
 *     voucher in Slice 3; the renderer-visible reason is the closed-set
 *     enum value, no voucher value crosses back).
 *   • `external_reference` redaction lives in the audit emitter; the
 *     handler forwards the raw input to both FSM (regex-validated there)
 *     and emitter (redacted there).
 */

import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../voucher-authority-client/validate.js';

import { applyVoucherLine } from './apply-voucher-line.js';

export interface TenderApplyHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  tenderLineFsm: Pick<TenderLineFsm, 'apply'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderApplied' | 'emitTenderRefused'>;
  /** Wave 4 — voucher V-A validate client (T263). Optional so callers
   *  that don't yet wire vouchers continue to work; in production the
   *  IPC registration always provides it.
   */
  validateVoucher?: (input: ValidateVoucherInput) => Promise<ValidateVoucherOutcome>;
  uuid: () => string;
  clock: () => Date;
}

export type TenderApplyHandler = (req: TenderApplyRequest) => Promise<TenderApplyResponse>;

export function createTenderApplyHandler(deps: TenderApplyHandlerDeps): TenderApplyHandler {
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

  return async function tenderApply(req): Promise<TenderApplyResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
    }

    // Boundary input validation — amount_applied_minor must be a safe
    // non-negative integer (Constitution §II). FSM also validates, but
    // refusing at the bridge boundary keeps the FSM's own refusals
    // semantic (overpayment / not-supported) rather than structural.
    if (!Number.isSafeInteger(req.amount_applied_minor) || req.amount_applied_minor < 0) {
      return await Promise.resolve({ kind: 'refused', reason: 'invalid_input' });
    }

    const attempt = attemptsRepo.findById(req.payment_attempt_id);
    if (attempt === undefined) {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
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
      return await Promise.resolve({ kind: 'refused', reason: gate.reason });
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
        tender_type: req.tender_type,
        amount_applied_minor: req.amount_applied_minor,
        // external_reference is redacted by the helper before hashing
        // (see idempotency.ts REDACT_KEYS).
        ...(req.external_reference !== undefined
          ? { external_reference: req.external_reference }
          : {}),
        // voucher_code is stripped by the helper before hashing.
        ...(req.voucher_code !== undefined ? { voucher_code: req.voucher_code } : {}),
      },
      acting_operator_id: session.operator_id,
      created_at: now,
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      // Reconstruct from the persisted line — find by `last_action_id`
      // matching the idempotency_key.
      const lines = linesRepo.findByAttempt(req.payment_attempt_id);
      const prior = lines.find((l) => l.last_action_id === req.idempotency_key);
      if (prior !== undefined && prior.state === 'applied' && prior.applied_at !== null) {
        const response: TenderApplyResponse = {
          kind: 'ok',
          tender_line_id: prior.tender_line_id,
          applied_at: prior.applied_at,
        };
        if (prior.change_due_minor !== null) {
          response.change_due_minor = prior.change_due_minor;
        }
        return await Promise.resolve(response);
      }
      // Replay of a refused-line attempt: the original outcome was a refusal;
      // reconstruct via the persisted refusal_reason (which the FSM stamped).
      if (prior !== undefined && prior.state === 'refused' && prior.refusal_reason !== null) {
        return await Promise.resolve({
          kind: 'refused',
          // refusal_reason column is a string-typed CHECK; the FSM only writes
          // RefusalReason values into it.
          reason: prior.refusal_reason as TenderApplyResponse extends { reason: infer R }
            ? R
            : never,
        });
      }
      return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
    }

    // Wave 4 — voucher branch (T263). Slice 3 returned
    // `tender_not_yet_supported` for `internal_voucher`; Wave 4 routes
    // to V-A `vouchers.validate` via the shared `applyVoucherLine`
    // helper. Voucher_code MUST be present (renderer always supplies
    // it for voucher tenders); refuse `invalid_input` otherwise.
    if (req.tender_type === 'internal_voucher') {
      if (validateVoucher === undefined) {
        // Production wires this dep; refuse cleanly when it's absent
        // (e.g., test deps yet to be updated, or pre-Wave-4 callers).
        return { kind: 'refused', reason: 'tender_not_yet_supported' };
      }
      if (req.voucher_code === undefined || req.voucher_code === '') {
        return { kind: 'refused', reason: 'invalid_input' };
      }
      // Compute remaining_balance_minor main-side (R-7).
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
        applied_at: outcome.applied_at,
      };
    }

    // Fresh path — invoke the FSM. The FSM stamps the line row + outbox row
    // inside one SQLite transaction. The handler never calls
    // `reservation.commit()` because the FSM does its own outbox.insert
    // (same S3b pattern as payments-start).
    const fsmOutcome = tenderLineFsm.apply({
      tender_line_id,
      payment_attempt_id: req.payment_attempt_id,
      tender_type: req.tender_type,
      amount_applied_minor: req.amount_applied_minor,
      ...(req.external_reference !== undefined
        ? { external_reference: req.external_reference }
        : {}),
      ...(req.voucher_code !== undefined ? { voucher_code: req.voucher_code } : {}),
      attribution_operator_id: session.operator_id,
      applied_at: now,
      action_id: req.idempotency_key,
    });

    if (fsmOutcome.kind === 'refused') {
      // Emit `tender.refused` ONLY for non_cash_overpayment_refused (the
      // FSM persists a refused-state line in that case). Other refusal
      // reasons short-circuit before persistence (tender_not_yet_supported,
      // invalid_input, attempt_terminal) — no row, no audit.
      if (fsmOutcome.reason === 'non_cash_overpayment_refused') {
        auditEmitter.emitTenderRefused({
          tender_line_id,
          payment_attempt_id: req.payment_attempt_id,
          tender_type: req.tender_type,
          refusal_reason: fsmOutcome.reason,
          refused_at: now,
          attribution_operator_id: session.operator_id,
          tenant_id: attempt.tenant_id,
          branch_id: attempt.branch_id,
          originating_terminal_id: attempt.terminal_id,
          session_id: session.operator_session_id,
        });
      }
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    auditEmitter.emitTenderApplied({
      tender_line_id: fsmOutcome.tender_line_id,
      payment_attempt_id: req.payment_attempt_id,
      tender_type: req.tender_type,
      amount_applied_minor: req.amount_applied_minor,
      ...(fsmOutcome.change_due_minor !== undefined
        ? { change_due_minor: fsmOutcome.change_due_minor }
        : {}),
      ...(req.external_reference !== undefined
        ? { external_reference: req.external_reference }
        : {}),
      applied_at: fsmOutcome.applied_at,
      attribution_operator_id: session.operator_id,
      tenant_id: attempt.tenant_id,
      branch_id: attempt.branch_id,
      originating_terminal_id: attempt.terminal_id,
      session_id: session.operator_session_id,
    });

    const response: TenderApplyResponse = {
      kind: 'ok',
      tender_line_id: fsmOutcome.tender_line_id,
      applied_at: fsmOutcome.applied_at,
    };
    if (fsmOutcome.change_due_minor !== undefined) {
      response.change_due_minor = fsmOutcome.change_due_minor;
    }
    return await Promise.resolve(response);
  };
}
