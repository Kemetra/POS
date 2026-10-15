/**
 * T134 — `payments.confirm` bridge handler (Wave H GREEN).
 *
 * Confirms a `started` PaymentAttempt by handing control to the FSM,
 * which evaluates the settlement invariant inside one SQLite
 * transaction. On `ok` the same transaction holds the `payment.settled`
 * audit event with the full tender-line breakdown (AD-9 / R-8).
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
 *   4. Settle + audit `payment.settled` with all applied lines, atomically
 *      (RT-496, `settlement-commit.ts`): the settled row, its frozen
 *      selling display name and the audit commit together or not at all.
 *      `external_reference` redaction lives inside the emitter — the
 *      handler forwards raw row data.
 *   5. A same-key replay of a settled attempt re-emits a missing
 *      `payment.settled` audit when the row carries its own attribution
 *      (RT-496, `settled-audit-reconciler.ts`).
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

import { attemptActionPayload } from '../action-payload.js';
import { requireOperatorSession } from '../require-operator-session.js';
import type { OperatorSessionForPayments } from '../require-operator-session.js';
import type { ConfirmOutcome, PaymentAttemptFsm } from '../fsm/payment-attempt-fsm.js';
import type { TenderLineFsm } from '../fsm/tender-line-fsm.js';
import type { IdempotencyHelper } from '../idempotency.js';
import type { PaymentAuditEmitter } from '../audit-emitter.js';
import { appliedTenderBreakdown, type SettlementCommitter } from '../settlement-commit.js';
import type { SettledAuditReconciler } from '../settled-audit-reconciler.js';
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

type CompensationAuditEmitter = Pick<
  PaymentAuditEmitter,
  'emitPaymentFailed' | 'emitTenderReversalPending' | 'emitTenderReversed'
>;

export interface PaymentsConfirmHandlerDeps {
  getCurrentSession: () => OperatorSessionForPayments | null;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt' | 'persistAuthorityRedemptionId'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'fail'>;
  /**
   * RT-496 — settles the attempt and writes its `payment.settled` audit in
   * one transaction. Required: without it a settle could commit without the
   * audit that finalize and the cash-up hold depend on.
   */
  settlement: SettlementCommitter;
  /** RT-496 — re-emits a stranded settlement's audit on a same-key replay. */
  settledAuditReconciler: Pick<SettledAuditReconciler, 'healAttempt'>;
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
  auditEmitter: CompensationAuditEmitter;
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

/** The voucher clients, present together (Wave 4) or not at all. */
interface VoucherDeps {
  redeemVoucher: (input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>;
  reverseVoucher: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  tenderLineFsm: Pick<TenderLineFsm, 'markReversalPending' | 'reverse'>;
  uuid: () => string;
}

function voucherDepsOf(deps: PaymentsConfirmHandlerDeps): VoucherDeps | null {
  const { redeemVoucher, reverseVoucher, tenderLineFsm, uuid } = deps;
  if (redeemVoucher === undefined || reverseVoucher === undefined) return null;
  if (tenderLineFsm === undefined || uuid === undefined) return null;
  return { redeemVoucher, reverseVoucher, tenderLineFsm, uuid };
}

export function createPaymentsConfirmHandler(
  deps: PaymentsConfirmHandlerDeps,
): PaymentsConfirmHandler {
  const {
    getCurrentSession,
    attemptsRepo,
    linesRepo,
    paymentAttemptFsm,
    idempotency,
    auditEmitter,
    clock,
    settlement,
    settledAuditReconciler,
  } = deps;
  const voucherDeps = voucherDepsOf(deps);

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
      payload: attemptActionPayload(req),
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
        // RT-496: a settle from before the atomic fix may have lost its
        // audit. Heal it here when the row carries its own attribution; an
        // unattributable strand stays held for manual review.
        settledAuditReconciler.healAttempt(row.payment_attempt_id);
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

    return await sweepAndSettle({
      deps: { linesRepo, paymentAttemptFsm, auditEmitter, clock, settlement },
      voucherDeps,
      row,
      session,
      req,
    });
  };
}

interface SettleContext {
  deps: Pick<
    PaymentsConfirmHandlerDeps,
    'linesRepo' | 'paymentAttemptFsm' | 'auditEmitter' | 'clock' | 'settlement'
  >;
  voucherDeps: VoucherDeps | null;
  row: PaymentAttemptRow;
  session: OperatorSessionForPayments;
  req: PaymentsConfirmRequest;
}

/**
 * Wave 4 — voucher redeem sweep (PRE-FSM, T261). For each `internal_voucher`
 * `applied` line the handler calls V-A `vouchers.redeem` BEFORE driving
 * `paymentAttemptFsm.confirm`. HTTP cannot live inside `db.transaction()`. On
 * any redeem `authority_unreachable` the attempt resolves to `failed` with
 * `dependency_unavailable` and each voucher line transitions to
 * `reversal_pending` (research §R-13). The deferred-reversal resolver
 * (Wave 5) eventually retries. Then the atomic settle (RT-496).
 */
async function sweepAndSettle(ctx: SettleContext): Promise<PaymentsConfirmResponse> {
  const { deps, voucherDeps, row, session, req } = ctx;
  const voucherLines = deps.linesRepo
    .findByAttempt(req.payment_attempt_id)
    .filter(
      (l): l is PaymentTenderLineRow =>
        l.tender_type === 'internal_voucher' && l.state === 'applied',
    );
  let redeemed: readonly PersistedRedemption[] = [];
  if (voucherLines.length > 0) {
    if (voucherDeps === null) {
      // Pre-Wave-4 deployment: voucher lines cannot settle without the
      // V-A redeem + reverse clients. Refuse with dependency_unavailable
      // so the cashier knows the path is offline (defence-in-depth).
      return { kind: 'refused', reason: 'dependency_unavailable' };
    }
    const sweep = await redeemVoucherLines({
      ...voucherDeps,
      ...compensationScope(ctx),
      voucherLines,
      linesRepo: deps.linesRepo,
    });
    if (sweep.kind === 'failed') return sweep.response;
    redeemed = sweep.persisted;
  }

  let fsmOutcome: ConfirmOutcome;
  try {
    fsmOutcome = settleWithAudit({ ...deps, row, session, req });
  } catch (err) {
    // RT-496: the combined transaction rolled back, so the attempt is still
    // `started`. A voucher V-A already redeemed above must not stay
    // consumed on it: fail the attempt and reverse each redemption
    // (reversed, or reversal_pending for the deferred resolver).
    if (redeemed.length > 0 && voucherDeps !== null) {
      await failAttemptWithCompensation({
        ...voucherDeps,
        ...compensationScope(ctx),
        persistedRedemptions: redeemed,
        failure_reason: 'internal_error',
      });
    }
    throw err;
  }

  if (fsmOutcome.kind === 'refused') return { kind: 'refused', reason: fsmOutcome.reason };
  return { kind: 'ok', settled_at: fsmOutcome.settled_at };
}

/** The attempt-level context every voucher compensation step needs. */
function compensationScope(ctx: SettleContext) {
  return {
    attemptRow: ctx.row,
    session: ctx.session,
    idempotency_key_root: ctx.req.idempotency_key,
    paymentAttemptFsm: ctx.deps.paymentAttemptFsm,
    auditEmitter: ctx.deps.auditEmitter,
    clock: ctx.deps.clock,
  };
}

/**
 * RT-496 — settle the attempt with its `payment.settled` audit (AD-9 / R-8),
 * atomically. The applied lines are read BEFORE the transaction: confirm
 * changes only the attempt row and the outbox, so they are already final
 * (the voucher sweep has stamped its redemption ids). Only `applied` lines
 * participate in the breakdown.
 */
function settleWithAudit(input: {
  settlement: SettlementCommitter;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  row: PaymentAttemptRow;
  session: OperatorSessionForPayments;
  req: PaymentsConfirmRequest;
  clock: () => Date;
}): ConfirmOutcome {
  const { row, session, req } = input;
  const settled_at = input.clock().toISOString();
  // RT-224 step 2: the sale's own cashier `users.id`, captured now — the only
  // time it is known — for the device-path sale sync. Only for an admitted
  // cashier session that is the attempt's acting operator; never guessed.
  const selling_user_id = sellingUserIdOf(session, row.acting_operator_id);
  return input.settlement.commit(
    { payment_attempt_id: req.payment_attempt_id, settled_at, action_id: req.idempotency_key },
    {
      payment_attempt_id: req.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      handoff_action_id: row.envelope_handoff_action_id,
      settled_at,
      attribution_operator_id: row.acting_operator_id,
      selling_operator_display_name: session.display_name,
      ...(selling_user_id === null ? {} : { selling_user_id }),
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: session.operator_session_id,
      tender_lines: appliedTenderBreakdown(
        input.linesRepo.findByAttempt(req.payment_attempt_id),
        settled_at,
      ),
    },
  );
}

/**
 * RT-224 step 2: the confirming session's `users.id` when it is an admitted
 * cashier session AND the operator who started the attempt; else null.
 */
export function sellingUserIdOf(
  session: OperatorSessionForPayments,
  actingOperatorId: string,
): string | null {
  const userId = session.user_id;
  if (userId === undefined || userId.length === 0) return null;
  return session.operator_id === actingOperatorId ? userId : null;
}

// Re-export the row type for downstream handlers that depend on the same
// projection (e.g., payments-cancel uses the same gating shape).
export type { PaymentAttemptRow };

// ── Wave 4 helper — voucher redeem sweep (T261) ─────────────────────────────

interface CompensationInput {
  attemptRow: PaymentAttemptRow;
  session: OperatorSessionForPayments;
  idempotency_key_root: string;
  reverseVoucher: (input: ReverseVoucherInput) => Promise<ReverseVoucherOutcome>;
  tenderLineFsm: Pick<TenderLineFsm, 'markReversalPending' | 'reverse'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'fail'>;
  auditEmitter: CompensationAuditEmitter;
  uuid: () => string;
  clock: () => Date;
}

interface RedeemVoucherLinesInput extends CompensationInput {
  voucherLines: readonly PaymentTenderLineRow[];
  redeemVoucher: (input: RedeemVoucherInput) => Promise<RedeemVoucherOutcome>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'persistAuthorityRedemptionId'>;
}

interface PersistedRedemption {
  tender_line_id: string;
  redemption_id: string;
}

type RedeemSweepOutcome =
  | { kind: 'failed'; response: PaymentsConfirmResponse }
  | { kind: 'redeemed'; persisted: readonly PersistedRedemption[] };

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
 * Returns the bridge refusal envelope when the sweep fails; otherwise every
 * persisted redemption, so the caller can compensate them if the settle
 * transaction then fails (RT-496).
 */
/** A redeem that V-A accepted; null stands for a line with no intent token. */
function isRedeemed(
  outcome: RedeemVoucherOutcome | null,
): outcome is Extract<RedeemVoucherOutcome, { kind: 'redeemed' }> {
  return outcome?.kind === 'redeemed';
}

async function redeemVoucherLines(input: RedeemVoucherLinesInput): Promise<RedeemSweepOutcome> {
  const { voucherLines, attemptRow, idempotency_key_root, redeemVoucher, linesRepo } = input;
  const persistedRedemptions: PersistedRedemption[] = [];
  for (const line of voucherLines) {
    // Defence-in-depth — an `applied`-state voucher line without an intent
    // token is impossible under T263 / T260, but the row's column is
    // nullable, so we refuse rather than send a malformed V-A request.
    const outcome =
      line.voucher_redemption_intent_token === null
        ? null
        : await redeemVoucher({
            payment_attempt_id: attemptRow.payment_attempt_id,
            redemption_intent_token: line.voucher_redemption_intent_token,
          });
    if (!isRedeemed(outcome)) {
      // Mid-sweep failure. The never-redeemed lines (current + any
      // unreached successors) stay `applied`; only the already-redeemed
      // ones need compensating-reverse against V-A.
      const response = await failAttemptWithCompensation({ ...input, persistedRedemptions });
      return { kind: 'failed', response };
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
  return { kind: 'redeemed', persisted: persistedRedemptions };
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
 *
 * RT-496: also the compensation when the settle transaction itself fails
 * after a successful sweep (`failure_reason: 'internal_error'`). If the local
 * fail throws (the database is what failed), the V-A reverses still run, so
 * no voucher stays consumed at the authority; the fail error is re-thrown
 * after them.
 */
async function failAttemptWithCompensation(
  input: CompensationInput & {
    persistedRedemptions: readonly PersistedRedemption[];
    failure_reason?: 'dependency_unavailable' | 'internal_error';
  },
): Promise<PaymentsConfirmResponse> {
  const now = input.clock().toISOString();
  const failure_reason = input.failure_reason ?? 'dependency_unavailable';
  // 1. Fail the attempt first — the audit ordering payment.failed →
  // tender.reversed/reversal_pending mirrors the cancel-path semantics
  // (the attempt-level event narrates "what happened"; the per-line
  // events narrate the compensation).
  let failError: Error | null = null;
  try {
    failAttempt(input, now, failure_reason);
  } catch (err) {
    failError = err instanceof Error ? err : new Error(String(err));
  }
  // 2. Compensate each already-persisted V-A redemption. Iterate in the
  // order they were redeemed; sequential is fine because each call is a
  // simple HTTP POST + a local FSM transition.
  for (const persisted of input.persistedRedemptions) {
    await compensateRedemption(input, persisted, now);
  }
  if (failError !== null) throw failError;
  return { kind: 'refused', reason: failure_reason };
}

function failAttempt(
  input: CompensationInput,
  now: string,
  failure_reason: 'dependency_unavailable' | 'internal_error',
): void {
  const failOutcome = input.paymentAttemptFsm.fail({
    payment_attempt_id: input.attemptRow.payment_attempt_id,
    failed_at: now,
    failure_reason,
    action_id: `${input.idempotency_key_root}:fail:${input.uuid()}`,
  });
  if (failOutcome.kind !== 'ok') return;
  input.auditEmitter.emitPaymentFailed({
    payment_attempt_id: input.attemptRow.payment_attempt_id,
    cart_id: input.attemptRow.envelope_cart_id,
    handoff_action_id: input.attemptRow.envelope_handoff_action_id,
    failed_at: failOutcome.failed_at,
    failure_reason,
    attribution_operator_id: input.attemptRow.acting_operator_id,
    tenant_id: input.attemptRow.tenant_id,
    branch_id: input.attemptRow.branch_id,
    originating_terminal_id: input.attemptRow.terminal_id,
    session_id: input.session.operator_session_id,
  });
}

async function compensateRedemption(
  input: CompensationInput,
  persisted: PersistedRedemption,
  now: string,
): Promise<void> {
  const scope = {
    payment_attempt_id: input.attemptRow.payment_attempt_id,
    attribution_operator_id: input.session.operator_id,
    tenant_id: input.attemptRow.tenant_id,
    branch_id: input.attemptRow.branch_id,
    originating_terminal_id: input.attemptRow.terminal_id,
    session_id: input.session.operator_session_id,
  };
  const reverseOutcome = await input.reverseVoucher({ redemption_id: persisted.redemption_id });
  if (reverseOutcome.kind === 'reversed') {
    const fsmOutcome = input.tenderLineFsm.reverse({
      tender_line_id: persisted.tender_line_id,
      payment_attempt_id: scope.payment_attempt_id,
      reversed_at: now,
      attribution_operator_id: scope.attribution_operator_id,
      action_id: `${input.idempotency_key_root}:rev:${persisted.tender_line_id}`,
    });
    if (fsmOutcome.kind === 'ok') {
      input.auditEmitter.emitTenderReversed({
        ...scope,
        tender_line_id: persisted.tender_line_id,
        tender_type: 'internal_voucher',
        reversed_at: now,
        manual_void_required: false,
      });
    }
    return;
  }
  // authority_unreachable OR refused → mark pending; the Wave-5
  // deferred-reversal resolver will retry against V-A.
  const pendOutcome = input.tenderLineFsm.markReversalPending({
    tender_line_id: persisted.tender_line_id,
    payment_attempt_id: scope.payment_attempt_id,
    reversal_pending_since: now,
    attribution_operator_id: scope.attribution_operator_id,
    action_id: `${input.idempotency_key_root}:rev-pend:${persisted.tender_line_id}`,
  });
  if (pendOutcome.kind === 'ok') {
    input.auditEmitter.emitTenderReversalPending({
      ...scope,
      tender_line_id: persisted.tender_line_id,
      tender_type: 'internal_voucher',
      reversal_pending_since: pendOutcome.reversal_pending_since,
    });
  }
}
