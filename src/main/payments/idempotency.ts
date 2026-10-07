/**
 * T131 — Idempotency replay helper (006 Slice 3b).
 *
 * Wraps the `payment_action_outbox` repository in the contract laid out
 * in `specs/006-payments-tender/contracts/bridge-api.md` §"Idempotency"
 * and research §R-10:
 *
 *   1. Bridge handler computes the redacted canonical payload + hashes it.
 *   2. Helper looks up the outbox row by `action_id` (the client-supplied
 *      UUID v4 `idempotency_key`).
 *      • Not found → caller proceeds; on success calls `commit()` to
 *        write the outbox row in the same SQLite transaction as the
 *        attempt / line state row.
 *      • Found AND payload hash matches → caller returns the cached
 *        outcome (replay). The helper signals this through the `kind`
 *        return value; the cached outcome is the responsibility of the
 *        caller (the row state in `payment_attempts` / `payment_tender_lines`
 *        is already the source of truth, so the bridge handler reconstructs
 *        the response from there).
 *      • Found AND payload hash differs → refusal with reason
 *        `idempotency_payload_mismatch`; the original outbox row is
 *        preserved unchanged.
 *
 * SECURITY — the helper applies P-VII redaction (`external_reference` →
 * `*****`, voucher tokens stripped entirely) **before** hashing. This
 * means two retries that differ only in those fields produce the same
 * hash (correct: they are functionally identical from the
 * outbox/integrity standpoint, since neither raw value participates in
 * the operation outcome). A retry that differs in a non-redacted field
 * (e.g., `amount_applied_minor`) produces a different hash and is
 * refused.
 *
 * **Caller contract — `commit()`:** the helper inserts the outbox row at
 * the moment `commit()` is called, not earlier. Callers MUST invoke
 * `commit()` from inside their outer SQLite transaction; a caller that
 * skips `commit()` leaves no audit/idempotency record (Constitution §P4).
 */

import { hashActionPayload } from './action-payload.js';
import type {
  PaymentActionKind,
  PaymentActionOutboxRepository,
} from './repositories/payment-action-outbox.repository.js';

// Redaction and the per-action payload shapes live in `./action-payload.ts`
// (RT-304) so the FSMs that write the outbox row hash exactly what this
// helper checks.

// ── Public surface ──────────────────────────────────────────────────────────

export interface IdempotencyHelperDependencies {
  outbox: PaymentActionOutboxRepository;
}

export interface ReserveInput {
  action_id: string;
  payment_attempt_id: string;
  tender_line_id: string | null;
  action_kind: PaymentActionKind;
  /** Anything plain-JSON; redacted-and-hashed deterministically by the helper. */
  payload: unknown;
  acting_operator_id: string;
  created_at: string;
}

export type ReserveOutcome =
  | {
      kind: 'fresh';
      /**
       * Commits the outbox row inside the caller's outer SQLite transaction.
       * MUST be invoked exactly once after the caller's state changes succeed.
       */
      commit(): void;
    }
  | { kind: 'replay' }
  | { kind: 'mismatch' };

export interface IdempotencyHelper {
  /**
   * Either reserves a fresh outbox slot (returning a `commit()` callback to
   * invoke after the state mutation succeeds) or signals that the call is a
   * replay or a payload-mismatch retry.
   */
  checkOrReserve(input: ReserveInput): ReserveOutcome;
}

export function createIdempotencyHelper(deps: IdempotencyHelperDependencies): IdempotencyHelper {
  const { outbox } = deps;

  return {
    checkOrReserve(input: ReserveInput): ReserveOutcome {
      const hash = hashActionPayload(input.action_kind, input.payload);
      const existing = outbox.findByActionId(input.action_id);
      if (existing !== undefined) {
        if (existing.action_payload_hash === hash && existing.action_kind === input.action_kind) {
          return { kind: 'replay' };
        }
        return { kind: 'mismatch' };
      }
      return {
        kind: 'fresh',
        commit(): void {
          outbox.insert({
            action_id: input.action_id,
            payment_attempt_id: input.payment_attempt_id,
            tender_line_id: input.tender_line_id,
            action_kind: input.action_kind,
            action_payload_hash: hash,
            acting_operator_id: input.acting_operator_id,
            created_at: input.created_at,
          });
        },
      };
    },
  };
}
