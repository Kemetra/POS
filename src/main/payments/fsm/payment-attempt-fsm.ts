/**
 * T120 — PaymentAttempt FSM (main-process Slice 3 implementation).
 *
 * The 5-state attempt FSM (data-model §"PaymentAttempt"):
 *
 *   started → settled    (via confirm, gated on settlement invariant)
 *   started → cancelled  (via cancel; reverses applied lines LIFO)
 *   started → failed     (via fail; carries a closed FR-006 reason)
 *   started → force_failed (via forceFail; manager-only; dual attribution
 *                           — manager actor + original cashier — recorded
 *                           by the bridge handler at audit time)
 *
 * Each transition writes one row to `payment_action_outbox` in the same
 * SQLite transaction as the state-row update, so a partial write is
 * impossible (Constitution §P4 / §P5; research §R-10). The settlement
 * invariant is evaluated against the canonical SQL aggregate exposed by
 * the tender-lines repository — `Σ amount − COALESCE(change, 0)` over
 * the `applied` lines, equal to `envelope_subtotal_minor`.
 *
 * The FSM does NOT emit audit events. The bridge handlers (S3c) wire
 * each successful transition to the audit emitter — keeping audit
 * emission at the trust-boundary layer (Constitution §VII; advisor
 * note: "audit emitter is NOT injected into FSMs").
 */

import type { DatabaseHandle } from '../../db/client.js';
import type {
  PaymentAttemptsRepository,
  PaymentFailureReason,
} from '../repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';
import type { PaymentActionOutboxRepository } from '../repositories/payment-action-outbox.repository.js';
import {
  attemptActionPayload,
  failActionPayload,
  hashActionPayload,
  startActionPayload,
} from '../action-payload.js';
import type { RefusalReason } from '../../../shared/payments/types.js';
import { isLegalPaymentAttemptTransition } from '../../../shared/payments/fsm-types.js';
import { createTenderLineFsm } from './tender-line-fsm.js';

// ── Public types ────────────────────────────────────────────────────────────

export interface PaymentAttemptFsmDependencies {
  db: DatabaseHandle;
  attempts: PaymentAttemptsRepository;
  lines: PaymentTenderLinesRepository;
  outbox: PaymentActionOutboxRepository;
}

export interface StartPaymentAttemptInput {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  started_at: string;
  action_id: string;
}

export interface ConfirmPaymentAttemptInput {
  payment_attempt_id: string;
  settled_at: string;
  action_id: string;
}

export interface CancelPaymentAttemptInput {
  payment_attempt_id: string;
  cancelled_at: string;
  action_id: string;
}

export interface FailPaymentAttemptInput {
  payment_attempt_id: string;
  failed_at: string;
  failure_reason: PaymentFailureReason;
  action_id: string;
}

/**
 * T280 — Wave 5b. Manager-initiated terminal transition for a stuck
 * `started` attempt (FR-021, plan AD-5). The FSM persists the state +
 * outbox row; the audit row's dual-attribution payload (manager actor +
 * original cashier) is composed by the bridge handler at audit-emission
 * time and is NOT this FSM's concern. The FSM records the manager
 * `acting_operator_id` (the one that authorised the force-fail) on the
 * outbox row so the action lineage is durable.
 */
export interface ForceFailPaymentAttemptInput {
  payment_attempt_id: string;
  force_failed_at: string;
  /** Manager / admin operator id (the actor authorising the force-fail). */
  manager_operator_id: string;
  action_id: string;
}

export type StartOutcome =
  | { kind: 'ok'; payment_attempt_id: string }
  | { kind: 'refused'; reason: RefusalReason };

export type ConfirmOutcome =
  | { kind: 'ok'; settled_at: string }
  | { kind: 'refused'; reason: RefusalReason };

export type CancelOutcome =
  | {
      kind: 'ok';
      cancelled_at: string;
      reversed_tender_line_ids: readonly string[];
      reversal_pending_tender_line_ids: readonly string[];
    }
  | { kind: 'refused'; reason: RefusalReason };

export type FailOutcome =
  | { kind: 'ok'; failed_at: string }
  | { kind: 'refused'; reason: RefusalReason };

export type ForceFailOutcome =
  | { kind: 'ok'; force_failed_at: string }
  | { kind: 'refused'; reason: RefusalReason };

export interface PaymentAttemptFsm {
  start(input: StartPaymentAttemptInput): StartOutcome;
  confirm(input: ConfirmPaymentAttemptInput): ConfirmOutcome;
  cancel(input: CancelPaymentAttemptInput): CancelOutcome;
  fail(input: FailPaymentAttemptInput): FailOutcome;
  forceFail(input: ForceFailPaymentAttemptInput): ForceFailOutcome;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPaymentAttemptFsm(deps: PaymentAttemptFsmDependencies): PaymentAttemptFsm {
  const { db, attempts, lines, outbox } = deps;
  const tenderFsm = createTenderLineFsm({ db, attempts, lines, outbox });

  return {
    start(input: StartPaymentAttemptInput): StartOutcome {
      // Money invariant (Constitution §"No floats for money") — envelope_subtotal_minor
      // must be a non-negative safe integer. A malformed value would persist into
      // the row and break the exact-equality settlement check later, while also
      // destabilising the outbox payload hash for the same logical amount.
      if (
        !Number.isSafeInteger(input.envelope_subtotal_minor) ||
        input.envelope_subtotal_minor < 0
      ) {
        return { kind: 'refused', reason: 'invalid_input' };
      }
      // The partial unique index on (terminal_id) WHERE state='started' is the
      // authoritative guard (R-6) — a race between two main-process callers
      // resolves at SQL. We pre-check to surface the closed refusal reason
      // cleanly without taking a SQL error path.
      const existing = attempts.findStartedByTerminal(input.terminal_id);
      if (existing !== undefined) {
        return { kind: 'refused', reason: 'attempt_already_started_on_terminal' };
      }
      const txn = db.transaction((): StartOutcome => {
        try {
          attempts.insert({
            payment_attempt_id: input.payment_attempt_id,
            tenant_id: input.tenant_id,
            branch_id: input.branch_id,
            terminal_id: input.terminal_id,
            acting_operator_id: input.acting_operator_id,
            operator_session_id: input.operator_session_id,
            envelope_handoff_action_id: input.envelope_handoff_action_id,
            envelope_cart_id: input.envelope_cart_id,
            envelope_subtotal_minor: input.envelope_subtotal_minor,
            started_at: input.started_at,
            last_action_id: input.action_id,
          });
        } catch (err) {
          // Race with another caller — partial unique index fires.
          if (isUniqueViolation(err)) {
            return { kind: 'refused', reason: 'attempt_already_started_on_terminal' };
          }
          throw err;
        }
        const hash = hashActionPayload('payment.attempt.start', startActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: null,
          action_kind: 'payment.attempt.start',
          action_payload_hash: hash,
          acting_operator_id: input.acting_operator_id,
          created_at: input.started_at,
        });
        return { kind: 'ok', payment_attempt_id: input.payment_attempt_id };
      });
      return txn();
    },

    confirm(input: ConfirmPaymentAttemptInput): ConfirmOutcome {
      const row = attempts.findById(input.payment_attempt_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      if (!isLegalPaymentAttemptTransition(row.state, 'settled')) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      const sum = lines.settlementSumMinor(input.payment_attempt_id);
      if (sum < row.envelope_subtotal_minor) {
        return { kind: 'refused', reason: 'tender_underpaid' };
      }
      if (sum > row.envelope_subtotal_minor) {
        // Defence-in-depth — per-line refusals make this unreachable, but the
        // FSM refuses rather than ship a phantom settlement (Constitution §IV).
        return { kind: 'refused', reason: 'internal_error' };
      }
      const txn = db.transaction((): ConfirmOutcome => {
        attempts.updateState({
          payment_attempt_id: input.payment_attempt_id,
          state: 'settled',
          timestamp: input.settled_at,
          last_action_id: input.action_id,
        });
        const hash = hashActionPayload('payment.confirm', attemptActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: null,
          action_kind: 'payment.confirm',
          action_payload_hash: hash,
          acting_operator_id: row.acting_operator_id,
          created_at: input.settled_at,
        });
        return { kind: 'ok', settled_at: input.settled_at };
      });
      return txn();
    },

    cancel(input: CancelPaymentAttemptInput): CancelOutcome {
      const row = attempts.findById(input.payment_attempt_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      if (!isLegalPaymentAttemptTransition(row.state, 'cancelled')) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      const lifoIds = tenderFsm.listAppliedLifoIds(input.payment_attempt_id);
      const txn = db.transaction((): CancelOutcome => {
        const reversed: string[] = [];
        const pending: string[] = [];
        for (const tender_line_id of lifoIds) {
          const r = tenderFsm.reverseInTransaction({
            tender_line_id,
            payment_attempt_id: input.payment_attempt_id,
            reversed_at: input.cancelled_at,
            attribution_operator_id: row.acting_operator_id,
            action_id: `${input.action_id}:rev:${tender_line_id}`,
          });
          if (r.kind === 'ok') {
            if (r.state === 'reversed') reversed.push(tender_line_id);
            else pending.push(tender_line_id);
          }
          // Cash / external_card_terminal cannot refuse reverse on the LIFO
          // sweep (they were `applied` by definition). Voucher reverse is a
          // Slice-4 path and won't appear in Slice-3 cancel scope.
        }
        attempts.updateState({
          payment_attempt_id: input.payment_attempt_id,
          state: 'cancelled',
          timestamp: input.cancelled_at,
          last_action_id: input.action_id,
        });
        // `reversed` is an outcome of this call, not part of the request, so it
        // stays out of the hash: a retry must be able to reproduce it (RT-304).
        const hash = hashActionPayload('payment.cancel', attemptActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: null,
          action_kind: 'payment.cancel',
          action_payload_hash: hash,
          acting_operator_id: row.acting_operator_id,
          created_at: input.cancelled_at,
        });
        return {
          kind: 'ok',
          cancelled_at: input.cancelled_at,
          reversed_tender_line_ids: reversed,
          reversal_pending_tender_line_ids: pending,
        };
      });
      return txn();
    },

    fail(input: FailPaymentAttemptInput): FailOutcome {
      const row = attempts.findById(input.payment_attempt_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      if (!isLegalPaymentAttemptTransition(row.state, 'failed')) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      const txn = db.transaction((): FailOutcome => {
        attempts.updateState({
          payment_attempt_id: input.payment_attempt_id,
          state: 'failed',
          timestamp: input.failed_at,
          last_action_id: input.action_id,
          failure_reason: input.failure_reason,
        });
        const hash = hashActionPayload('payment.fail', failActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: null,
          action_kind: 'payment.fail',
          action_payload_hash: hash,
          acting_operator_id: row.acting_operator_id,
          created_at: input.failed_at,
        });
        return { kind: 'ok', failed_at: input.failed_at };
      });
      return txn();
    },

    /**
     * T280 — Wave 5b. Manager-initiated terminal transition (FR-021).
     * Mirrors `fail()` but: (1) targets the `force_failed` state, (2)
     * persists `force_fail_attribution_operator_id = manager_operator_id`
     * on the row (data-model line 80), (3) records the manager's
     * `acting_operator_id` on the outbox row so the action lineage is
     * durable (the row's `acting_operator_id` on `payment_attempts`
     * remains the original cashier — that's the dual-attribution
     * design at the row layer; the audit dual-attribution is composed
     * by the bridge handler).
     */
    forceFail(input: ForceFailPaymentAttemptInput): ForceFailOutcome {
      const row = attempts.findById(input.payment_attempt_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      if (!isLegalPaymentAttemptTransition(row.state, 'force_failed')) {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }
      const txn = db.transaction((): ForceFailOutcome => {
        attempts.updateState({
          payment_attempt_id: input.payment_attempt_id,
          state: 'force_failed',
          timestamp: input.force_failed_at,
          last_action_id: input.action_id,
          failure_reason: 'manager_force_failed',
          force_fail_attribution_operator_id: input.manager_operator_id,
        });
        const hash = hashActionPayload('payment.force_fail', attemptActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: null,
          action_kind: 'payment.force_fail',
          action_payload_hash: hash,
          // Outbox `acting_operator_id` records who AUTHORISED the
          // action — that's the manager. The original cashier remains
          // on `payment_attempts.acting_operator_id` (immutable since
          // payments.start). The bridge handler composes both into the
          // dual-attribution audit payload.
          acting_operator_id: input.manager_operator_id,
          created_at: input.force_failed_at,
        });
        return { kind: 'ok', force_failed_at: input.force_failed_at };
      });
      return txn();
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const msg = (err as { message?: string }).message ?? '';
  // SQLite always includes the literal word "UNIQUE" in unique-constraint
  // failures. CHECK / NOT NULL / FK failures contain "constraint failed"
  // but NOT "UNIQUE" — matching only /UNIQUE/i prevents misreporting
  // unrelated schema/data errors as attempt_already_started_on_terminal.
  return /UNIQUE/i.test(msg);
}
