/**
 * RT-496 — `payments.confirm`'s settlement dependencies as main wires them
 * (`index.ts`), for real-stack tests: the atomic settle-with-audit committer
 * and the stranded-settlement reconciler, both over the test's own handle.
 */
import type { DatabaseHandle } from '../../../../../src/main/db/client.js';
import type { PaymentAuditEmitter } from '../../../../../src/main/payments/audit-emitter.js';
import type { PaymentAttemptFsm } from '../../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import type { PaymentAttemptsRepository } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from '../../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createSettlementCommitter } from '../../../../../src/main/payments/settlement-commit.js';
import { createSettledAuditReconciler } from '../../../../../src/main/payments/settled-audit-reconciler.js';

export function realSettlementDeps(input: {
  db: DatabaseHandle;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'confirm'>;
  attempts: Pick<PaymentAttemptsRepository, 'recordSellingOperatorDisplayName'>;
  lines: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'buildPaymentSettled' | 'emitRaw'>;
  now?: () => string;
}) {
  const { db, paymentAttemptFsm, attempts, lines, auditEmitter } = input;
  return {
    settlement: createSettlementCommitter({
      db,
      paymentAttemptFsm,
      attemptsRepo: attempts,
      auditEmitter,
    }),
    settledAuditReconciler: createSettledAuditReconciler({
      db,
      linesRepo: lines,
      auditEmitter,
      now: input.now ?? (() => new Date().toISOString()),
    }),
  };
}
