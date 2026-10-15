/**
 * RT-496 — commit a settlement and its `payment.settled` audit atomically.
 *
 * RT-481 reproduced the gap this closes: `payments.confirm` committed the
 * `started → settled` transition in the FSM's own transaction and only then
 * wrote the audit. 008's finalize listener and the RT-17 cash-up hold find an
 * unfinalized settlement ONLY through that audit row, so any throw or crash
 * between the two left money taken with no Sale and an unheld cash-up close.
 *
 * Here one outer transaction holds, in order:
 *
 *   1. the FSM confirm (its own transaction runs as a savepoint inside this
 *      one — better-sqlite3 nests transaction functions that way);
 *   2. the frozen selling display name on the attempt row (migration 0051);
 *   3. the `payment.settled` audit insert (the audit sink writes to the same
 *      SQLite handle, synchronously).
 *
 * A throw in any step rolls all three back, so a settled row without its
 * audit cannot be committed. The audit event is built and validated (the
 * forbidden-key scan) BEFORE the transaction opens, so a bad payload refuses
 * the settle without touching the database.
 */

import type { DatabaseHandle } from '../db/client.js';
import type {
  EmitPaymentSettledInput,
  EmitTenderLineBreakdown,
  PaymentAuditEmitter,
} from './audit-emitter.js';
import type {
  ConfirmOutcome,
  ConfirmPaymentAttemptInput,
  PaymentAttemptFsm,
} from './fsm/payment-attempt-fsm.js';
import type { PaymentAttemptsRepository } from './repositories/payment-attempts.repository.js';
import type { PaymentTenderLineRow } from './repositories/payment-tender-lines.repository.js';

/**
 * The `payment.settled` tender breakdown (AD-9 / R-8): only `applied` lines,
 * in apply order. Refused and reversed lines never contributed. Raw row data;
 * the emitter redacts `external_reference`.
 */
export function appliedTenderBreakdown(
  lines: readonly PaymentTenderLineRow[],
  settled_at: string,
): EmitTenderLineBreakdown[] {
  return lines
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
}

export interface SettlementCommitterDeps {
  db: Pick<DatabaseHandle, 'transaction'>;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'confirm'>;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'recordSellingOperatorDisplayName'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'buildPaymentSettled' | 'emitRaw'>;
}

export interface SettlementCommitter {
  /**
   * Settle the attempt, freeze its selling display name and write its
   * `payment.settled` audit, all or nothing. `settled.settled_at` must equal
   * `confirm.settled_at`. FSM refusals pass through with nothing written; any
   * throw propagates after the rollback.
   */
  commit(confirm: ConfirmPaymentAttemptInput, settled: EmitPaymentSettledInput): ConfirmOutcome;
}

export function createSettlementCommitter(deps: SettlementCommitterDeps): SettlementCommitter {
  const { db, paymentAttemptFsm, attemptsRepo, auditEmitter } = deps;
  return {
    commit(confirm, settled) {
      const event = auditEmitter.buildPaymentSettled(settled);
      const txn = db.transaction((): ConfirmOutcome => {
        const outcome = paymentAttemptFsm.confirm(confirm);
        // A refusal wrote nothing, so it passes through with nothing added.
        if (outcome.kind === 'ok') {
          attemptsRepo.recordSellingOperatorDisplayName({
            payment_attempt_id: confirm.payment_attempt_id,
            selling_operator_display_name: settled.selling_operator_display_name,
          });
          auditEmitter.emitRaw(event);
        }
        return outcome;
      });
      return txn();
    },
  };
}
