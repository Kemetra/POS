/**
 * T140 — `tender.reverse` bridge handler (Wave H GREEN).
 *
 * Reverses an `applied` tender line. The request carries only
 * `tender_line_id` + `idempotency_key`; the handler resolves the bound
 * attempt via `linesRepo.findByLineId` (F-005) to apply the tenant /
 * owner / terminal-state gate.
 *
 * The TenderLine FSM owns the per-tender-type reverse rules:
 *   • cash                    → state='reversed'; manual_void_required=false
 *   • external_card_terminal  → state='reversed'; manual_void_required=true
 *   • internal_voucher        → returns tender_not_yet_supported in Slice 3
 *
 * Audit emission policy (T106):
 *   • FSM ok                  → emit `tender.reversed`
 *   • FSM refused             → NO audit (the line wasn't transitioned)
 */

import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import type { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';
import type { TenderReverseRequest, TenderReverseResponse } from '../../../shared/bridge-api.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../voucher-authority-client/reverse.js';

export interface TenderReverseHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByLineId'>;
  /**
   * Wave 4 — voucher reverse adds `confirmReversed` (sync success) and
   * `markReversalPending` (authority_unreachable → deferred resolver).
   */
  tenderLineFsm: Pick<TenderLineFsm, 'reverse' | 'markReversalPending' | 'confirmReversed'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderReversed' | 'emitTenderReversalPending'>;
  /** Wave 4 — voucher V-A reverse client. Optional so non-voucher
   *  callers (Slice-3 tests, etc.) work without injection; voucher
   *  lines refuse `tender_not_yet_supported` if absent.
   */
  reverseVoucher?: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  clock: () => Date;
}

export type TenderReverseHandler = (req: TenderReverseRequest) => Promise<TenderReverseResponse>;

export function createTenderReverseHandler(deps: TenderReverseHandlerDeps): TenderReverseHandler {
  const {
    getCurrentSession,
    attemptsRepo,
    linesRepo,
    tenderLineFsm,
    idempotency,
    auditEmitter,
    reverseVoucher,
    clock,
  } = deps;

  return async function tenderReverse(req): Promise<TenderReverseResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
    }

    const line = linesRepo.findByLineId(req.tender_line_id);
    if (line === undefined) {
      return await Promise.resolve({ kind: 'refused', reason: 'line_not_applied' });
    }

    const attempt = attemptsRepo.findById(line.payment_attempt_id);
    if (attempt === undefined) {
      // FK violation — defence-in-depth (migration 0014 declares the FK).
      return await Promise.resolve({ kind: 'refused', reason: 'line_not_applied' });
    }

    // Reverse is allowed on attempts whose state is `started` (cashier
    // changed their mind mid-tender). We pass `state: 'started'` to the
    // gating helper so isolation+ownership fire normally; if the real row
    // is in a terminal state we still want to allow reverse-on-cancel
    // through the FSM's own line-state check, which refuses
    // `line_not_applied` if the line itself isn't reversible.
    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      attempt: {
        operator_session_id: attempt.operator_session_id,
        tenant_id: attempt.tenant_id,
        branch_id: attempt.branch_id,
        terminal_id: attempt.terminal_id,
        state: 'started',
      },
    });
    if (gate.kind === 'refused' && gate.reason !== 'attempt_terminal') {
      return await Promise.resolve({ kind: 'refused', reason: gate.reason });
    }

    const now = clock().toISOString();

    const reservation = idempotency.checkOrReserve({
      action_id: req.idempotency_key,
      payment_attempt_id: line.payment_attempt_id,
      tender_line_id: req.tender_line_id,
      action_kind: 'tender.reverse',
      payload: {
        tender_line_id: req.tender_line_id,
        payment_attempt_id: line.payment_attempt_id,
      },
      acting_operator_id: session.operator_id,
      created_at: now,
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      if (
        (line.state === 'reversed' || line.state === 'reversal_pending') &&
        line.reversed_at !== null
      ) {
        return await Promise.resolve({
          kind: 'ok',
          reversed_at: line.reversed_at,
          state: line.state,
        });
      }
      // Replay-but-no-reverse: line is still applied → outbox row exists
      // but FSM call didn't transition the state. Refuse generically.
      return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
    }

    // Wave 4 — voucher reverse branch (T262). Call V-A `vouchers.reverse`
    // BEFORE the FSM (HTTP cannot live inside `db.transaction()`).
    //   • success           → fsm.confirmReversed → tender.reversed
    //   • authority_unreach → fsm.markReversalPending → tender.reversal_pending
    //   • refusal           → forward the closed-set refusal envelope
    if (line.tender_type === 'internal_voucher') {
      if (reverseVoucher === undefined) {
        return { kind: 'refused', reason: 'tender_not_yet_supported' };
      }
      if (line.voucher_authority_redemption_id === null) {
        // Defence — an `applied` voucher line without a redemption_id
        // hasn't been confirmed yet; reverse is a no-op against V-A.
        return { kind: 'refused', reason: 'line_not_applied' };
      }
      const outcome = await reverseVoucher({
        redemption_id: line.voucher_authority_redemption_id,
      });
      if (outcome.kind === 'refused') {
        // Map V-A reverse closed-set codes to the bridge-facing closed
        // refusal subset for `tender.reverse`. `redemption_not_found`
        // is exposed verbatim (it's a legitimate cashier-visible
        // refusal); other V-A codes (validation_failure, idempotency,
        // tenant/branch mismatch, etc.) collapse to `line_not_applied`
        // because they are out-of-band for the cashier-facing reverse
        // surface. F-A4B-003 8→1 refusal-copy mapping continues to
        // apply at the renderer.
        return { kind: 'refused', reason: mapReverseRefusal(outcome.reason) };
      }
      if (outcome.kind === 'authority_unreachable') {
        const pendOutcome = tenderLineFsm.markReversalPending({
          tender_line_id: req.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          reversal_pending_since: now,
          attribution_operator_id: session.operator_id,
          action_id: req.idempotency_key,
        });
        if (pendOutcome.kind === 'refused') {
          return { kind: 'refused', reason: pendOutcome.reason };
        }
        auditEmitter.emitTenderReversalPending({
          tender_line_id: req.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          tender_type: 'internal_voucher',
          reversal_pending_since: pendOutcome.reversal_pending_since,
          attribution_operator_id: session.operator_id,
          tenant_id: attempt.tenant_id,
          branch_id: attempt.branch_id,
          originating_terminal_id: attempt.terminal_id,
          session_id: session.operator_session_id,
        });
        return {
          kind: 'ok',
          reversed_at: pendOutcome.reversal_pending_since,
          state: 'reversal_pending',
        };
      }
      // V-A reversed.
      const confirmOutcome = tenderLineFsm.confirmReversed({
        tender_line_id: req.tender_line_id,
        payment_attempt_id: line.payment_attempt_id,
        reversed_at: now,
        attribution_operator_id: session.operator_id,
        action_id: req.idempotency_key,
      });
      if (confirmOutcome.kind === 'refused') {
        return { kind: 'refused', reason: confirmOutcome.reason };
      }
      auditEmitter.emitTenderReversed({
        tender_line_id: req.tender_line_id,
        payment_attempt_id: line.payment_attempt_id,
        tender_type: 'internal_voucher',
        reversed_at: confirmOutcome.reversed_at,
        attribution_operator_id: session.operator_id,
        tenant_id: attempt.tenant_id,
        branch_id: attempt.branch_id,
        originating_terminal_id: attempt.terminal_id,
        session_id: session.operator_session_id,
        // Voucher reverse never needs manual void — the authority owns it.
        manual_void_required: false,
      });
      return {
        kind: 'ok',
        reversed_at: confirmOutcome.reversed_at,
        state: 'reversed',
      };
    }

    const fsmOutcome = tenderLineFsm.reverse({
      tender_line_id: req.tender_line_id,
      payment_attempt_id: line.payment_attempt_id,
      reversed_at: now,
      attribution_operator_id: session.operator_id,
      action_id: req.idempotency_key,
    });

    if (fsmOutcome.kind === 'refused') {
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    auditEmitter.emitTenderReversed({
      tender_line_id: req.tender_line_id,
      payment_attempt_id: line.payment_attempt_id,
      tender_type: fsmOutcome.tender_type,
      reversed_at: fsmOutcome.reversed_at,
      attribution_operator_id: session.operator_id,
      tenant_id: attempt.tenant_id,
      branch_id: attempt.branch_id,
      originating_terminal_id: attempt.terminal_id,
      session_id: session.operator_session_id,
      manual_void_required: fsmOutcome.manual_void_required,
    });

    return await Promise.resolve({
      kind: 'ok',
      reversed_at: fsmOutcome.reversed_at,
      state: fsmOutcome.state,
    });
  };
}

/**
 * Map the V-A `reverseVoucher` `VoucherRefusalReason` to the bridge's
 * `tender.reverse` closed refusal subset. The V-A endpoint can return
 * codes like `validation_failure`, `idempotency_*`, `redemption_tenant_mismatch`,
 * etc. — none of those are cashier-actionable on the POS reverse
 * surface, so they collapse to `line_not_applied` (same generic
 * rendering as a missing line). `redemption_not_found` is the one V-A
 * refusal that's cashier-meaningful (the original redemption never
 * happened), and it surfaces verbatim. F-A4B-001 — the literal-union is
 * the V-A client's source of truth (`refusal-mapping.ts`); the bridge
 * layer trusts it.
 */
function mapReverseRefusal(
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
): 'line_not_applied' {
  // F-A4B-003 — 8-code → 1 generic refusal-copy mapping. Every V-A
  // reverse refusal collapses to `line_not_applied` on the bridge.
  // The structured `code` remains in the V-A client's logger for ops
  // triage; the bridge response never carries the underlying reason.
  void code;
  return 'line_not_applied';
}
