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
 *   • card_tender_disabled (RT-700)        → emit `tender.refused`. No line
 *     is persisted, but the refused card attempt is still recorded (P-26-1).
 *   • All other refusals (no_session, role_denied, attempt_terminal,
 *     tender_not_yet_supported, idempotency_*) → no audit (the line was
 *     never persisted)
 *
 * RT-700 (P-26-1, OD-26-1 option A) — card tender flag. `tender.apply` is
 * where the tender type first crosses the bridge, so this is where card is
 * kept out of the pilot: with `isCardTenderEnabled()` false (or not wired —
 * fail-closed) a fresh `external_card_terminal` apply is refused
 * `card_tender_disabled` after the session, attempt and idempotency checks and
 * before the FSM, so nothing is written. A same-key replay still answers the
 * recorded line: it records no new tender.
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

import type { Logger } from 'pino';

import { tenderApplyActionPayload } from '../action-payload.js';
import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import type { RefusalReason } from '../../../shared/payments/types.js';
import type {
  ValidateVoucherInput,
  ValidateVoucherOutcome,
} from '../voucher-authority-client/validate.js';

import { applyVoucherForRequest } from './apply-voucher-line.js';
import { priorLineOutcome } from './prior-line-outcome.js';

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
  /** RT-437 — one `warn` line per out-of-range cash refusal; never the amount. */
  logger?: Pick<Logger, 'warn'>;
  /**
   * RT-700 — `POS_PULSE_FEATURE_CARD_TENDER`, read per call. Absent means off:
   * a card tender is refused `card_tender_disabled` (fail-closed).
   */
  isCardTenderEnabled?: () => boolean;
}

export type TenderApplyHandler = (req: TenderApplyRequest) => Promise<TenderApplyResponse>;

type AttemptRow = NonNullable<ReturnType<PaymentAttemptsRepository['findById']>>;
type LineRow = ReturnType<PaymentTenderLinesRepository['findByAttempt']>[number];
type FsmApplied = Extract<ReturnType<TenderLineFsm['apply']>, { kind: 'ok' }>;

/**
 * Rebuild the answer to a replayed `tender.apply` key from the persisted line:
 * the original ok, the original refusal (reason stamped by the FSM), or
 * `internal_error` when the line is gone or never reached either outcome.
 */
function replayResponse(prior: LineRow | undefined): TenderApplyResponse {
  const outcome = priorLineOutcome(prior);
  if (outcome.kind === 'applied') {
    const response: TenderApplyResponse = {
      kind: 'ok',
      tender_line_id: outcome.line.tender_line_id,
      applied_at: outcome.line.applied_at,
    };
    if (outcome.line.change_due_minor !== null) {
      response.change_due_minor = outcome.line.change_due_minor;
    }
    return response;
  }
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason };
  return { kind: 'refused', reason: 'internal_error' };
}

/** The `tender.applied` audit event for a line the FSM just applied. */
function appliedAuditInput(ctx: {
  req: TenderApplyRequest;
  attempt: AttemptRow;
  session: OperatorSessionForPayments;
  fsmOutcome: FsmApplied;
}): Parameters<PaymentAuditEmitter['emitTenderApplied']>[0] {
  const { req, attempt, session, fsmOutcome } = ctx;
  return {
    tender_line_id: fsmOutcome.tender_line_id,
    payment_attempt_id: req.payment_attempt_id,
    tender_type: req.tender_type,
    amount_applied_minor: req.amount_applied_minor,
    ...(fsmOutcome.change_due_minor !== undefined
      ? { change_due_minor: fsmOutcome.change_due_minor }
      : {}),
    ...(req.external_reference !== undefined ? { external_reference: req.external_reference } : {}),
    applied_at: fsmOutcome.applied_at,
    attribution_operator_id: session.operator_id,
    tenant_id: attempt.tenant_id,
    branch_id: attempt.branch_id,
    originating_terminal_id: attempt.terminal_id,
    session_id: session.operator_session_id,
  };
}

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
    logger,
    isCardTenderEnabled = () => false,
  } = deps;

  /**
   * Voucher branch (T263): routes to V-A `vouchers.validate` via the shared
   * `applyVoucherLine` helper. The voucher code MUST be present (the renderer
   * always supplies it for voucher tenders); otherwise `invalid_input`.
   */
  async function applyVoucher(ctx: {
    req: TenderApplyRequest;
    session: OperatorSessionForPayments;
    attempt: AttemptRow;
    tender_line_id: string;
    now: string;
  }): Promise<TenderApplyResponse> {
    const { req, session, attempt, tender_line_id, now } = ctx;
    if (validateVoucher === undefined) {
      // Production wires this dep; refuse cleanly when it's absent
      // (e.g., test deps yet to be updated, or pre-Wave-4 callers).
      return { kind: 'refused', reason: 'tender_not_yet_supported' };
    }
    if (req.voucher_code === undefined || req.voucher_code === '') {
      return { kind: 'refused', reason: 'invalid_input' };
    }
    const outcome = await applyVoucherForRequest(
      { ...req, voucher_code: req.voucher_code },
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
      applied_at: outcome.applied_at,
    };
  }

  /** The `tender.refused` audit event for a refused apply. */
  function emitRefusedAudit(
    ctx: {
      req: TenderApplyRequest;
      attempt: AttemptRow;
      session: OperatorSessionForPayments;
      tender_line_id: string;
      now: string;
    },
    reason: RefusalReason,
  ): void {
    const { req, attempt, session, tender_line_id, now } = ctx;
    auditEmitter.emitTenderRefused({
      tender_line_id,
      payment_attempt_id: req.payment_attempt_id,
      tender_type: req.tender_type,
      refusal_reason: reason,
      refused_at: now,
      attribution_operator_id: session.operator_id,
      tenant_id: attempt.tenant_id,
      branch_id: attempt.branch_id,
      originating_terminal_id: attempt.terminal_id,
      session_id: session.operator_session_id,
    });
  }

  /** Audit / log side effects of an FSM refusal (nothing else was recorded). */
  function recordFsmRefusal(ctx: {
    req: TenderApplyRequest;
    attempt: AttemptRow;
    session: OperatorSessionForPayments;
    tender_line_id: string;
    now: string;
    reason: string;
  }): void {
    const { req, attempt, session, tender_line_id, now, reason } = ctx;
    // Emit `tender.refused` ONLY for non_cash_overpayment_refused (the
    // FSM persists a refused-state line in that case). Other refusal
    // reasons short-circuit before persistence (tender_not_yet_supported,
    // invalid_input, attempt_terminal) — no row, no audit.
    if (reason === 'non_cash_overpayment_refused') {
      emitRefusedAudit({ req, attempt, session, tender_line_id, now }, reason);
    }
    // RT-437 (D-F2) — nothing was recorded, so there is no tender event to
    // audit (owner decision 4). One log line, with the attempt id and never
    // the amount.
    if (reason === 'cash_amount_out_of_range') {
      logger?.warn(
        {
          event: 'tender.apply.cash_out_of_range',
          payment_attempt_id: req.payment_attempt_id,
        },
        'tender.apply refused: cash amount out of range',
      );
    }
  }

  /** RT-700 — refuse a card tender while the flag is off; audited, nothing persisted. */
  function refuseDisabledCard(ctx: {
    req: TenderApplyRequest;
    attempt: AttemptRow;
    session: OperatorSessionForPayments;
    tender_line_id: string;
    now: string;
  }): TenderApplyResponse {
    const reason = 'card_tender_disabled';
    // `tender_line_id` is the id the line would have had; no row is written.
    emitRefusedAudit(ctx, reason);
    return { kind: 'refused', reason };
  }

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
      // external_reference is redacted and voucher_code stripped at the hash
      // boundary (action-payload.ts); the FSM hashes this same shape.
      payload: tenderApplyActionPayload(req),
      acting_operator_id: session.operator_id,
      created_at: now,
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      // Reconstruct from the persisted line, found by the outbox row's
      // immutable `tender_line_id`. `last_action_id` / `state` move on when the
      // line is later reversed, so keying on them made a retry of an apply
      // that was since reversed answer `internal_error` (RT-304 review).
      // `applied_at` is never cleared, so it still marks a line that applied.
      const lines = linesRepo.findByAttempt(req.payment_attempt_id);
      const prior = lines.find((l) => l.tender_line_id === reservation.tender_line_id);
      return await Promise.resolve(replayResponse(prior));
    }

    if (req.tender_type === 'external_card_terminal' && !isCardTenderEnabled()) {
      return refuseDisabledCard({ req, attempt, session, tender_line_id, now });
    }

    // Wave 4 — voucher branch (T263). Slice 3 returned
    // `tender_not_yet_supported` for `internal_voucher`; Wave 4 routes
    // to V-A `vouchers.validate` via the shared `applyVoucherLine`
    // helper. Voucher_code MUST be present (renderer always supplies
    // it for voucher tenders); refuse `invalid_input` otherwise.
    if (req.tender_type === 'internal_voucher') {
      return applyVoucher({ req, session, attempt, tender_line_id, now });
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
      recordFsmRefusal({ req, attempt, session, tender_line_id, now, reason: fsmOutcome.reason });
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    auditEmitter.emitTenderApplied(appliedAuditInput({ req, attempt, session, fsmOutcome }));

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
