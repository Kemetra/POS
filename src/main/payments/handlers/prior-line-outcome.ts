/**
 * What a replayed tender-apply key originally answered, read back from the
 * persisted tender line (found by the outbox row's immutable `tender_line_id`).
 *
 * Shared by `tender.apply` and `vouchers.validate`, which rebuild their own
 * response shapes from the same two facts.
 */

import type { RefusalReason } from '../../../shared/payments/types.js';
import type { PaymentTenderLinesRepository } from '../repositories/payment-tender-lines.repository.js';

type LineRow = ReturnType<PaymentTenderLinesRepository['findByAttempt']>[number];

export type PriorLineOutcome =
  | { kind: 'applied'; line: LineRow & { applied_at: string } }
  | { kind: 'refused'; reason: RefusalReason }
  | { kind: 'unknown' };

export function priorLineOutcome(prior: LineRow | undefined): PriorLineOutcome {
  if (prior === undefined) return { kind: 'unknown' };
  if (prior.state !== 'refused' && prior.applied_at !== null) {
    return { kind: 'applied', line: { ...prior, applied_at: prior.applied_at } };
  }
  // Replay of a refused-line attempt: the original outcome was a refusal;
  // reconstruct via the persisted refusal_reason (which the FSM stamped).
  if (prior.state === 'refused' && prior.refusal_reason !== null) {
    // refusal_reason column is a string-typed CHECK; the FSM only writes
    // RefusalReason values into it.
    return { kind: 'refused', reason: prior.refusal_reason as RefusalReason };
  }
  return { kind: 'unknown' };
}
