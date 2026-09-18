/**
 * T134 — `payments.confirm` bridge handler (Wave H GREEN).
 *
 * Confirms a `started` PaymentAttempt by handing control to the FSM,
 * which evaluates the settlement invariant inside one SQLite
 * transaction. On `ok` the handler emits a `payment.settled` audit
 * event with the full tender-line breakdown (AD-9 / R-8).
 *
 * Trust-boundary responsibilities (mirror of payments-start.ts §1–5):
 *
 *   1. Session gate AND attempt-binding gate via `requireOperatorSession`
 *      with the gating projection (tenant_isolation / wrong_owner /
 *      attempt_terminal collapse into the closed RefusalReason enum).
 *   2. Idempotency replay BEFORE the terminal-state guard so a retry of
 *      a previously-successful confirm returns the persisted settled_at,
 *      not `attempt_terminal`.
 *   3. FSM call → refusal pass-through (tender_underpaid / internal_error /
 *      attempt_terminal).
 *   4. Audit `payment.settled` with all applied lines on FSM ok.
 *      `external_reference` redaction lives inside the emitter — the
 *      handler forwards raw row data.
 *
 * SECURITY:
 *   • Replay outcome reconstructed from row state, never from outbox
 *     payload (the outbox is hashed only — R-10).
 *   • Audit emission is the only place `external_reference` would
 *     surface in a payload; the emitter redacts it to `'*****'`.
 *   • Operator attribution comes from the attempt row's
 *     `acting_operator_id`, which 005's handoff bridge stamped from
 *     the trusted main-side session (FR-013).
 */

import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { PaymentAttemptFsm } from '../fsm/payment-attempt-fsm.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { EmitTenderLineBreakdown, PaymentAuditEmitter } from '../audit-emitter.js';
import type {
  PaymentAttemptsRepository,
  PaymentAttemptRow,
} from '../repositories/payment-attempts.repository.js';
import type {
  PaymentTenderLinesRepository,
  PaymentTenderLineRow,
} from '../repositories/payment-tender-lines.repository.js';
import type {
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
} from '../../../shared/bridge-api.js';
import type {
  RedeemVoucherInput,
  RedeemVoucherOutcome,
} from '../voucher-authority-client/redeem.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from '../voucher-authority-client/reverse.js';

export interface PaymentsConfirmHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt' | 'persistAuthorityRedemptionId'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'confirm' | 'fail'>;
  /** Wave 4 — voucher reversal_pending + compensating-reverse transitions.
   *  Optional in the type so Slice-3 callers continue to work without
   *  injection; the handler refuses with `dependency_unavailable` if a
   *  voucher line is encountered but the FSM lacks the methods.
   *
   *  CR-3 — `reverse` is the compensating-reverse path. When a multi-
   *  voucher redeem sweep fails mid-way (line N redeemed ok, line N+1
   *  returns authority_unreachable), already-redeemed lines must be
   *  reverseVoucher'd at the authority THEN transitioned via this method
   *  so V-A's books and local state stay consistent.
   */
  tenderLineFsm?: Pick<TenderLineFsm, 'markReversalPending' | 'reverse'>;
  idempotency: IdempotencyHelper;
  auditEmitter: Pick<
    PaymentAuditEmitter,
    'emitPaymentSettled' | 'emitPaymentFailed' | 'emitTenderReversalPending' | 'emitTenderReversed'
  >;
  /** Wave 4 — voucher V-A redeem client. Optional: when absent, the
   *  handler refuses with `dependency_unavailable` if any voucher line
   *  is present (defence-in-depth; production always provides it). */
  redeemVoucher?: (input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>;
  /** Wave 4 (CR-3) — voucher V-A reverse client. Used to compensate
   *  already-persisted V-A redemptions when the redeem sweep fails
   *  mid-way over multiple voucher lines. Optional with the same
   *  defence-in-depth refusal as `redeemVoucher`. */
  reverseVoucher?: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  /** UUID v4 generator used to action_id-namespace per-line redeem/reverse. */
  uuid?: () => string;
  clock: () => Date;
}

export type PaymentsConfirmHandler = (
  req: PaymentsConfirmRequest,
) => Promise<PaymentsConfirmResponse>;

export function createPaymentsConfirmHandler(
  deps: PaymentsConfirmHandlerDeps,
): PaymentsConfirmHandler {
  const {
    getCurrentSession,
    attemptsRepo,
    linesRepo,
    paymentAttemptFsm,
    tenderLineFsm,
    idempotency,
    auditEmitter,
    redeemVoucher,
    reverseVoucher,
    uuid,
    clock,
  } = deps;

  return async function paymentsConfirm(req): Promise<PaymentsConfirmResponse> {
    const session = getCurrentSession();
    if (session === null) {
      return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
    }

    const row = attemptsRepo.findById(req.payment_attempt_id);
    if (row === undefined) {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    // Idempotency replay is checked BEFORE the terminal-state guard so a
    // retry of a successful confirm returns the persisted settled_at, not
    // `attempt_terminal`. We still need session-level isolation/ownership
    // checks to fire first — a cross-tenant probe of a guessed attempt id
    // must collapse to tenant_isolation, never leak existence through an
    // idempotency check. So: session/isolation gate first, then idempotency,
    // then FSM.
    const gateIsolation = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      attempt: {
        operator_session_id: row.operator_session_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        terminal_id: row.terminal_id,
        // Force the non-terminal-state guard to pass for the isolation pass —
        // the real terminal-state decision belongs to the idempotency replay
        // path below + the FSM.
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
      action_kind: 'payment.confirm',
      payload: { payment_attempt_id: req.payment_attempt_id },
      acting_operator_id: row.acting_operator_id,
      created_at: clock().toISOString(),
    });

    if (reservation.kind === 'mismatch') {
      return await Promise.resolve({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    }

    if (reservation.kind === 'replay') {
      // Reconstruct from row state. The settled_at column is the source of
      // truth — `state='settled'` AND `settled_at IS NOT NULL` always
      // co-occur (data-model §"PaymentAttempt" Invariant 2).
      if (row.state === 'settled' && row.settled_at !== null) {
        return await Promise.resolve({ kind: 'ok', settled_at: row.settled_at });
      }
      // Outbox row exists but row state is not settled — impossible under
      // atomic-transaction guarantees (R-10). Refuse generically.
      return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
    }

    // Now apply the terminal-state guard. attempt_terminal here is the only
    // legitimate refusal that can fire after the isolation+idempotency
    // checks — replay would have returned above; the row is non-`started`
    // for some other reason (cancelled / failed / force_failed).
    if (row.state !== 'started') {
      return await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' });
    }

    // Wave 4 — voucher redeem sweep (PRE-FSM, T261). For each
    // `internal_voucher` `applied` line the handler calls V-A
    // `vouchers.redeem` BEFORE driving `paymentAttemptFsm.confirm`. HTTP
    // cannot live inside `db.transaction()`. On any redeem
    // `authority_unreachable` the attempt resolves to `failed` with
    // `dependency_unavailable` and each voucher line transitions to
    // `reversal_pending` (research §R-13). The deferred-reversal
    // resolver (Wave 5) eventually retries.
    const linesBeforeConfirm = linesRepo.findByAttempt(req.payment_attempt_id);
    const voucherLines = linesBeforeConfirm.filter(
      (l): l is PaymentTenderLineRow =>
        l.tender_type === 'internal_voucher' && l.state === 'applied',
    );
    if (voucherLines.length > 0) {
      if (
        redeemVoucher === undefined ||
        reverseVoucher === undefined ||
        tenderLineFsm === undefined ||
        uuid === undefined
      ) {
        // Pre-Wave-4 deployment: voucher lines cannot settle without the
        // V-A redeem + reverse clients. Refuse with dependency_unavailable
        // so the cashier knows the path is offline (defence-in-depth).
        return await Promise.resolve({ kind: 'refused', reason: 'dependency_unavailable' });
      }
      const voucherFailure = await redeemVoucherLines({
        voucherLines,
        attemptRow: row,
        session,
        idempotency_key_root: req.idempotency_key,
        redeemVoucher,
        reverseVoucher,
        linesRepo,
        tenderLineFsm,
        paymentAttemptFsm,
        auditEmitter,
        uuid,
        clock,
      });
      if (voucherFailure !== null) {
        return await Promise.resolve(voucherFailure);
      }
    }

    const settled_at = clock().toISOString();
    const fsmOutcome = paymentAttemptFsm.confirm({
      payment_attempt_id: req.payment_attempt_id,
      settled_at,
      action_id: req.idempotency_key,
    });

    if (fsmOutcome.kind === 'refused') {
      return await Promise.resolve({ kind: 'refused', reason: fsmOutcome.reason });
    }

    // Audit `payment.settled` with the full tender breakdown (AD-9 / R-8).
    // Lines are pulled after the FSM transaction so they reflect the final
    // committed state. Only `applied` lines participate in the breakdown —
    // refused/reversed lines were either non-contributing or rolled back.
    const lines = linesRepo.findByAttempt(req.payment_attempt_id);
    const appliedLines: EmitTenderLineBreakdown[] = lines
      .filter((l) => l.state === 'applied')
      .sort((a, b) => a.apply_order - b.apply_order)
      .map((l) => {
        const breakdown: EmitTenderLineBreakdown = {
          tender_line_id: l.tender_line_id,
          tender_type: l.tender_type,
          amount_applied_minor: l.amount_applied_minor,
          applied_at: l.applied_at ?? settled_at,
          attribution_operator_id: l.attribution_operator_id,
        };
        if (l.change_due_minor !== null) breakdown.change_due_minor = l.change_due_minor;
        if (l.external_reference !== null) breakdown.external_reference = l.external_reference;
        return breakdown;
      });

    auditEmitter.emitPaymentSettled({
      payment_attempt_id: req.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      handoff_action_id: row.envelope_handoff_action_id,
      settled_at: fsmOutcome.settled_at,
      attribution_operator_id: row.acting_operator_id,
      selling_operator_display_name: session.display_name,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: session.operator_session_id,
      tender_lines: appliedLines,
    });

    return await Promise.resolve({ kind: 'ok', settled_at: fsmOutcome.settled_at });
  };
}

// Re-export the row type for downstream handlers that depend on the same
// projection (e.g., payments-cancel uses the same gating shape).
export type { PaymentAttemptRow };

// ── Wave 4 helper — voucher redeem sweep (T261) ─────────────────────────────

interface RedeemVoucherLinesInput {
  voucherLines: readonly PaymentTenderLineRow[];
  attemptRow: PaymentAttemptRow;
  session: OperatorSessionForPayments;
  idempotency_key_root: string;
  redeemVoucher: (input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>;
  reverseVoucher: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'persistAuthorityRedemptionId'>;
  tenderLineFsm: Pick<TenderLineFsm, 'markReversalPending' | 'reverse'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'fail'>;
  auditEmitter: Pick<
    PaymentAuditEmitter,
    'emitPaymentFailed' | 'emitTenderReversalPending' | 'emitTenderReversed'
  >;
  uuid: () => string;
  clock: () => Date;
}

interface PersistedRedemption {
  tender_line_id: string;
  redemption_id: string;
}

/**
 * Sweep every voucher-applied line, calling V-A `vouchers.redeem`. On
 * success: persist the V-A `redemption_id` on the line and continue to
 * settle. On any non-success outcome mid-sweep (`authority_unreachable`
 * or `refused`):
 *
 *   1. **Compensating-reverse** every line we already redeemed against
 *      V-A (`persistedRedemptions`). Each reverse calls V-A's
 *      `vouchers.reverse` endpoint with the persisted `redemption_id`,
 *      then transitions the line via `fsm.reverse` on success or
 *      `fsm.markReversalPending` on `authority_unreachable` (research
 *      §R-13 — the deferred-reversal resolver picks up pending lines).
 *   2. **Never-redeemed lines** (the failing line + every line we did
 *      not yet reach) stay in their persisted `applied` state. V-A has
 *      no redemption for them, so there is nothing to reverse. The
 *      attempt itself transitions to `failed` immediately after — at
 *      which point the lines' state is informational only.
 *   3. **Fail the attempt** with `dependency_unavailable` and emit
 *      `payment.failed`.
 *
 * Returns the bridge refusal envelope when the sweep fails; `null` when
 * every redeem succeeded and the caller may proceed with `fsm.confirm`.
 */
async function redeemVoucherLines(
  input: RedeemVoucherLinesInput,
): Promise<PaymentsConfirmResponse | null> {
  const {
    voucherLines,
    attemptRow,
    session,
    idempotency_key_root,
    redeemVoucher,
    reverseVoucher,
    linesRepo,
    tenderLineFsm,
    paymentAttemptFsm,
    auditEmitter,
    uuid,
    clock,
  } = input;
  const persistedRedemptions: PersistedRedemption[] = [];
  for (const line of voucherLines) {
    if (line.voucher_redemption_intent_token === null) {
      // Defence-in-depth — an `applied`-state voucher line without an
      // intent token is impossible under T263 / T260, but the row's
      // column is nullable, so we refuse rather than send a malformed
      // V-A request.
      return await failAttemptWithCompensation({
        persistedRedemptions,
        attemptRow,
        session,
        idempotency_key_root,
        reverseVoucher,
        tenderLineFsm,
        paymentAttemptFsm,
        auditEmitter,
        uuid,
        clock,
      });
    }
    const outcome = await redeemVoucher({
      payment_attempt_id: attemptRow.payment_attempt_id,
      redemption_intent_token: line.voucher_redemption_intent_token,
    });
    if (outcome.kind === 'authority_unreachable' || outcome.kind === 'refused') {
      // Mid-sweep failure. The never-redeemed lines (current + any
      // unreached successors) stay `applied`; only the already-redeemed
      // ones need compensating-reverse against V-A.
      return await failAttemptWithCompensation({
        persistedRedemptions,
        attemptRow,
        session,
        idempotency_key_root,
        reverseVoucher,
        tenderLineFsm,
        paymentAttemptFsm,
        auditEmitter,
        uuid,
        clock,
      });
    }
    // Success — stamp the V-A redemption_id on the line. The state stays
    // `applied`; the column accessor is a focused setter (UPDATE … SET
    // voucher_authority_redemption_id=?).
    linesRepo.persistAuthorityRedemptionId({
      tender_line_id: line.tender_line_id,
      voucher_authority_redemption_id: outcome.redemption_id,
      last_action_id: idempotency_key_root,
    });
    persistedRedemptions.push({
      tender_line_id: line.tender_line_id,
      redemption_id: outcome.redemption_id,
    });
  }
  return null;
}

/**
 * CR-3 — fail the attempt + compensating-reverse every line we have
 * already redeemed against V-A. Never-redeemed lines are NOT touched
 * (they have no V-A redemption to reverse; the failed attempt makes
 * their `applied` state informational only).
 *
 * For each persisted redemption:
 *   - Call V-A `vouchers.reverse` with the persisted `redemption_id`.
 *   - On `reversed`: drive `fsm.reverse` (transactional applied →
 *     reversed) and emit `tender.reversed`.
 *   - On `authority_unreachable`: drive `fsm.markReversalPending` and
 *     emit `tender.reversal_pending`. The Wave-5 deferred-reversal
 *     resolver will retry.
 *   - On `refused` (e.g., redemption_id_not_found — unlikely but
 *     defensive): treat the same as authority_unreachable — the local
 *     line stays alive for the resolver to re-investigate. V-A says it
 *     does not have the redemption, but we just persisted it from a
 *     successful redeem moments ago, so the safer posture is "treat as
 *     pending and audit". Logging the specific refusal reason is the
 *     responsibility of the `reverseVoucher` client itself.
 */
async function failAttemptWithCompensation(input: {
  persistedRedemptions: readonly PersistedRedemption[];
  attemptRow: PaymentAttemptRow;
  session: OperatorSessionForPayments;
  idempotency_key_root: string;
  reverseVoucher: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  tenderLineFsm: Pick<TenderLineFsm, 'markReversalPending' | 'reverse'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'fail'>;
  auditEmitter: Pick<
    PaymentAuditEmitter,
    'emitPaymentFailed' | 'emitTenderReversalPending' | 'emitTenderReversed'
  >;
  uuid: () => string;
  clock: () => Date;
}): Promise<PaymentsConfirmResponse> {
  const now = input.clock().toISOString();
  // 1. Fail the attempt first — the audit ordering payment.failed →
  // tender.reversed/reversal_pending mirrors the cancel-path semantics
  // (the attempt-level event narrates "what happened"; the per-line
  // events narrate the compensation).
  const failAction = `${input.idempotency_key_root}:fail:${input.uuid()}`;
  const failOutcome = input.paymentAttemptFsm.fail({
    payment_attempt_id: input.attemptRow.payment_attempt_id,
    failed_at: now,
    failure_reason: 'dependency_unavailable',
    action_id: failAction,
  });
  if (failOutcome.kind === 'ok') {
    input.auditEmitter.emitPaymentFailed({
      payment_attempt_id: input.attemptRow.payment_attempt_id,
      cart_id: input.attemptRow.envelope_cart_id,
      handoff_action_id: input.attemptRow.envelope_handoff_action_id,
      failed_at: failOutcome.failed_at,
      failure_reason: 'dependency_unavailable',
      attribution_operator_id: input.attemptRow.acting_operator_id,
      tenant_id: input.attemptRow.tenant_id,
      branch_id: input.attemptRow.branch_id,
      originating_terminal_id: input.attemptRow.terminal_id,
      session_id: input.session.operator_session_id,
    });
  }
  // 2. Compensate each already-persisted V-A redemption. Iterate in the
  // order they were redeemed; sequential is fine because each call is a
  // simple HTTP POST + a local FSM transition.
  for (const persisted of input.persistedRedemptions) {
    const reverseOutcome = await input.reverseVoucher({
      redemption_id: persisted.redemption_id,
    });
    if (reverseOutcome.kind === 'reversed') {
      const revAction = `${input.idempotency_key_root}:rev:${persisted.tender_line_id}`;
      const fsmOutcome = input.tenderLineFsm.reverse({
        tender_line_id: persisted.tender_line_id,
        payment_attempt_id: input.attemptRow.payment_attempt_id,
        reversed_at: now,
        attribution_operator_id: input.session.operator_id,
        action_id: revAction,
      });
      if (fsmOutcome.kind === 'ok') {
        input.auditEmitter.emitTenderReversed({
          tender_line_id: persisted.tender_line_id,
          payment_attempt_id: input.attemptRow.payment_attempt_id,
          tender_type: 'internal_voucher',
          reversed_at: now,
          attribution_operator_id: input.session.operator_id,
          tenant_id: input.attemptRow.tenant_id,
          branch_id: input.attemptRow.branch_id,
          originating_terminal_id: input.attemptRow.terminal_id,
          session_id: input.session.operator_session_id,
          manual_void_required: false,
        });
      }
      continue;
    }
    // authority_unreachable OR refused → mark pending; the Wave-5
    // deferred-reversal resolver will retry against V-A.
    const pendAction = `${input.idempotency_key_root}:rev-pend:${persisted.tender_line_id}`;
    const pendOutcome = input.tenderLineFsm.markReversalPending({
      tender_line_id: persisted.tender_line_id,
      payment_attempt_id: input.attemptRow.payment_attempt_id,
      reversal_pending_since: now,
      attribution_operator_id: input.session.operator_id,
      action_id: pendAction,
    });
    if (pendOutcome.kind === 'ok') {
      input.auditEmitter.emitTenderReversalPending({
        tender_line_id: persisted.tender_line_id,
        payment_attempt_id: input.attemptRow.payment_attempt_id,
        tender_type: 'internal_voucher',
        reversal_pending_since: pendOutcome.reversal_pending_since,
        attribution_operator_id: input.session.operator_id,
        tenant_id: input.attemptRow.tenant_id,
        branch_id: input.attemptRow.branch_id,
        originating_terminal_id: input.attemptRow.terminal_id,
        session_id: input.session.operator_session_id,
      });
    }
  }
  return { kind: 'refused', reason: 'dependency_unavailable' };
}
