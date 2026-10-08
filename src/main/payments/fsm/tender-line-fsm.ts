/**
 * T121 — TenderLine FSM (main-process Slice 3 implementation).
 *
 * Per-tender-type apply rules + reverse helper. Each public method runs
 * inside a single SQLite transaction so a partial write is impossible
 * (data-model §"Migration sequencing" + Constitution §P5). The FSM owns
 * apply_order assignment and LIFO reversal ordering — the bridge handlers
 * (S3c) simply call these methods.
 *
 * **Slice-3 scope.** voucher apply / reverse returns
 * `tender_not_yet_supported`; Slice 4 extends the same module additively.
 *
 * SECURITY (Constitution §P6 / §P7 / §P11):
 *   • No card data is captured at all (the bridge surface itself never
 *     accepts a PAN — `external_reference` is the only non-cash field, and
 *     it is regex-validated to a 0–6 uppercase-alphanumeric token that
 *     cannot represent a PAN).
 *   • Voucher tokens stay main-side; the renderer never sees them.
 */

import type { DatabaseHandle } from '../../db/client.js';
import type {
  PaymentAttemptsRepository,
  PaymentAttemptRow,
} from '../repositories/payment-attempts.repository.js';
import type {
  PaymentTenderLinesRepository,
  PaymentTenderLineRow,
} from '../repositories/payment-tender-lines.repository.js';
import type {
  PaymentActionKind,
  PaymentActionOutboxRepository,
} from '../repositories/payment-action-outbox.repository.js';
import {
  hashActionPayload,
  tenderApplyActionPayload,
  tenderReverseActionPayload,
} from '../action-payload.js';
import type { RefusalReason, TenderType } from '../../../shared/payments/types.js';
import { isLegalTenderLineTransition } from '../../../shared/payments/fsm-types.js';

// ── External-reference regex (data-model §"PaymentTenderLine" Invariant 3) ──

const EXTERNAL_REFERENCE_REGEX = /^[A-Z0-9]{0,6}$/;

// ── Public types ────────────────────────────────────────────────────────────

export interface TenderLineFsmDependencies {
  db: DatabaseHandle;
  attempts: PaymentAttemptsRepository;
  lines: PaymentTenderLinesRepository;
  outbox: PaymentActionOutboxRepository;
}

export interface ApplyTenderLineInput {
  tender_line_id: string;
  payment_attempt_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  external_reference?: string;
  voucher_code?: string;
  /**
   * Wave 4 voucher path. The bridge handler resolves `vouchers.validate`
   * via the V-A client BEFORE calling the FSM (HTTP cannot live inside a
   * SQLite transaction) and threads the outcome through this field. The
   * FSM persists the line with `voucher_redemption_intent_token` set
   * inside the transactional insert. If the call is voucher-tendered but
   * the outcome is absent, the FSM refuses with `internal_error` —
   * defence-in-depth: the bridge handler is the only legitimate caller.
   */
  voucher_outcome?:
    | { kind: 'validated'; redemption_intent_token: string; applied_amount_minor: number }
    | { kind: 'refused'; reason: RefusalReason };
  attribution_operator_id: string;
  applied_at: string;
  action_id: string;
}

export interface MarkReversalPendingInput {
  tender_line_id: string;
  payment_attempt_id: string;
  reversal_pending_since: string;
  attribution_operator_id: string;
  action_id: string;
}

export interface ConfirmReversedInput {
  tender_line_id: string;
  payment_attempt_id: string;
  reversed_at: string;
  attribution_operator_id: string;
  action_id: string;
}

export interface ReverseTenderLineInput {
  tender_line_id: string;
  /** Required so the FSM can resolve the bound attempt without a repo extension. */
  payment_attempt_id: string;
  reversed_at: string;
  attribution_operator_id: string;
  action_id: string;
}

export type ApplyOutcome =
  | { kind: 'ok'; tender_line_id: string; applied_at: string; change_due_minor?: number }
  | { kind: 'refused'; reason: RefusalReason };

export type ReverseOutcome =
  | {
      kind: 'ok';
      reversed_at: string;
      state: 'reversed' | 'reversal_pending';
      tender_type: TenderType;
      manual_void_required: boolean;
    }
  | { kind: 'refused'; reason: RefusalReason };

export type MarkReversalPendingOutcome =
  | { kind: 'ok'; reversal_pending_since: string; tender_type: TenderType }
  | { kind: 'refused'; reason: RefusalReason };

export type ConfirmReversedOutcome =
  | { kind: 'ok'; reversed_at: string; tender_type: TenderType }
  | { kind: 'refused'; reason: RefusalReason };

export interface TenderLineFsm {
  apply(input: ApplyTenderLineInput): ApplyOutcome;
  reverse(input: ReverseTenderLineInput): ReverseOutcome;
  /**
   * Non-transactional reverse variant. Used by callers that have already
   * opened an outer transaction (e.g., the PaymentAttempt FSM's cancel
   * path, which iterates LIFO and reverses every applied line within a
   * single SQLite transaction so the attempt and all per-line state move
   * atomically). The caller MUST be inside a db.transaction(...) scope.
   */
  reverseInTransaction(input: ReverseTenderLineInput): ReverseOutcome;
  /**
   * Wave 4 T264 — `applied → reversal_pending` transition. Used when
   * V-A `vouchers.reverse` returns `authority_unreachable` (research
   * §R-13). The line stays alive for the deferred-reversal resolver
   * (Wave 5 T270) to retry; `reversal_pending_since` is preserved
   * across the eventual reversal for incident reconstruction.
   */
  markReversalPending(input: MarkReversalPendingInput): MarkReversalPendingOutcome;
  /**
   * Wave 4 T264 — `reversal_pending → reversed` transition. Wave-5
   * deferred-reversal resolver will be the caller; the method is exposed
   * here so the FSM owns the transition (compile-time + runtime).
   */
  confirmReversed(input: ConfirmReversedInput): ConfirmReversedOutcome;
  listAppliedLifoIds(payment_attempt_id: string): readonly string[];
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTenderLineFsm(deps: TenderLineFsmDependencies): TenderLineFsm {
  const { db, attempts, lines, outbox } = deps;

  function nextApplyOrder(payment_attempt_id: string): number {
    const existing = lines.findByAttempt(payment_attempt_id);
    if (existing.length === 0) return 1;
    return Math.max(...existing.map((l) => l.apply_order)) + 1;
  }

  function computeRemainingBalance(
    attempt: PaymentAttemptRow,
    existing: readonly PaymentTenderLineRow[],
  ): number {
    let appliedNetSum = 0;
    for (const line of existing) {
      if (line.state !== 'applied') continue;
      appliedNetSum += line.amount_applied_minor - (line.change_due_minor ?? 0);
    }
    return attempt.envelope_subtotal_minor - appliedNetSum;
  }

  function findLineRow(
    payment_attempt_id: string,
    tender_line_id: string,
  ): PaymentTenderLineRow | undefined {
    return lines.findByAttempt(payment_attempt_id).find((l) => l.tender_line_id === tender_line_id);
  }

  function writeApplyOutbox(action_kind: PaymentActionKind, input: ApplyTenderLineInput): void {
    // The hash covers the REQUESTED amount, never the persisted one: a voucher
    // authority may cap the persisted `amount_applied_minor` (R-7), but a
    // same-key retry carries the request, so the request is what it must
    // match (RT-304; supersedes CR-1's persisted-amount hash).
    const hash = hashActionPayload(action_kind, tenderApplyActionPayload(input));
    outbox.insert({
      action_id: input.action_id,
      payment_attempt_id: input.payment_attempt_id,
      tender_line_id: input.tender_line_id,
      action_kind,
      action_payload_hash: hash,
      acting_operator_id: input.attribution_operator_id,
      created_at: input.applied_at,
    });
  }

  function preflightReverse(
    input: ReverseTenderLineInput,
  ): { kind: 'ok'; tender_type: TenderType } | { kind: 'refused'; reason: RefusalReason } {
    const row = findLineRow(input.payment_attempt_id, input.tender_line_id);
    if (row === undefined) {
      return { kind: 'refused', reason: 'line_not_applied' };
    }
    if (!isLegalTenderLineTransition(row.state, 'reversed')) {
      return { kind: 'refused', reason: 'line_not_applied' };
    }
    // Wave 4 — voucher reverse is allowed. The handler (tender-reverse.ts
    // T262) is responsible for calling V-A `vouchers.reverse` BEFORE this
    // FSM call when the line is a voucher; on `authority_unreachable` it
    // takes the `markReversalPending` branch instead of the synchronous
    // reverse.
    return { kind: 'ok', tender_type: row.tender_type };
  }

  function commitReverse(input: ReverseTenderLineInput, tender_type: TenderType): ReverseOutcome {
    lines.updateState({
      tender_line_id: input.tender_line_id,
      state: 'reversed',
      timestamp: input.reversed_at,
      last_action_id: input.action_id,
    });
    const hash = hashActionPayload('tender.reverse', tenderReverseActionPayload(input));
    outbox.insert({
      action_id: input.action_id,
      payment_attempt_id: input.payment_attempt_id,
      tender_line_id: input.tender_line_id,
      action_kind: 'tender.reverse',
      action_payload_hash: hash,
      acting_operator_id: input.attribution_operator_id,
      created_at: input.reversed_at,
    });
    return {
      kind: 'ok',
      reversed_at: input.reversed_at,
      state: 'reversed',
      tender_type,
      manual_void_required: tender_type === 'external_card_terminal',
    };
  }

  return {
    apply(input: ApplyTenderLineInput): ApplyOutcome {
      // Defensive amount guard (data-model §"PaymentTenderLine" Invariant 2 /
      // money-math §Constitution II).
      if (!Number.isSafeInteger(input.amount_applied_minor) || input.amount_applied_minor < 0) {
        return { kind: 'refused', reason: 'invalid_input' };
      }

      // Wave 4 voucher path. The bridge handler resolves V-A
      // `vouchers.validate` BEFORE calling the FSM (HTTP cannot live
      // inside `db.transaction()`); the outcome is threaded via
      // `voucher_outcome`. A voucher tender_type with NO voucher_outcome
      // is a contract violation by the caller — refuse defensively.
      if (input.tender_type === 'internal_voucher') {
        if (input.voucher_outcome === undefined) {
          return { kind: 'refused', reason: 'internal_error' };
        }
      }

      // external_reference regex gate (only on external_card_terminal).
      if (
        input.tender_type === 'external_card_terminal' &&
        input.external_reference !== undefined &&
        !EXTERNAL_REFERENCE_REGEX.test(input.external_reference)
      ) {
        return { kind: 'refused', reason: 'invalid_input' };
      }

      const attempt = attempts.findById(input.payment_attempt_id);
      if (attempt === undefined || attempt.state !== 'started') {
        return { kind: 'refused', reason: 'attempt_terminal' };
      }

      const existing = lines.findByAttempt(input.payment_attempt_id);
      const remaining = computeRemainingBalance(attempt, existing);
      const apply_order = nextApplyOrder(input.payment_attempt_id);

      const txn = db.transaction((): ApplyOutcome => {
        // Wave 4 voucher branch — persist the line per the resolved V-A
        // outcome the bridge handler threaded in. Authority refusals
        // persist a refused-state row (mirrors external_card_terminal
        // overpayment refusal); validated outcomes persist an applied
        // row with the V-A `redemption_intent_token` set main-side only.
        if (input.tender_type === 'internal_voucher') {
          const outcome = input.voucher_outcome;
          if (outcome === undefined) {
            // Unreachable — pre-checked above; keep for type-narrowing.
            return { kind: 'refused', reason: 'internal_error' };
          }
          if (outcome.kind === 'refused') {
            lines.insert({
              tender_line_id: input.tender_line_id,
              payment_attempt_id: input.payment_attempt_id,
              tender_type: 'internal_voucher',
              amount_applied_minor: input.amount_applied_minor,
              state: 'refused',
              change_due_minor: null,
              external_reference: null,
              voucher_redemption_intent_token: null,
              voucher_authority_redemption_id: null,
              applied_at: null,
              refused_at: input.applied_at,
              reversed_at: null,
              reversal_pending_since: null,
              refusal_reason: outcome.reason,
              attribution_operator_id: input.attribution_operator_id,
              apply_order,
              last_action_id: input.action_id,
            });
            writeApplyOutbox('tender.apply', input);
            return { kind: 'refused', reason: outcome.reason };
          }
          // CR-2 — Defence-in-depth safe-integer guard on the
          // authority-returned monetary value (Constitution §P9 / §II).
          // The OpenAPI schema declares `type: integer, minimum: 0` but
          // schema validation is upstream of this path; a malformed V-A
          // response must NOT corrupt local money state. Persist a
          // refused row + outbox entry (mirrors the non_cash_overpayment_
          // refused shape) so the action is recorded and replayable.
          if (
            !Number.isSafeInteger(outcome.applied_amount_minor) ||
            outcome.applied_amount_minor < 0
          ) {
            lines.insert({
              tender_line_id: input.tender_line_id,
              payment_attempt_id: input.payment_attempt_id,
              tender_type: 'internal_voucher',
              amount_applied_minor: input.amount_applied_minor,
              state: 'refused',
              change_due_minor: null,
              external_reference: null,
              voucher_redemption_intent_token: null,
              voucher_authority_redemption_id: null,
              applied_at: null,
              refused_at: input.applied_at,
              reversed_at: null,
              reversal_pending_since: null,
              refusal_reason: 'internal_error',
              attribution_operator_id: input.attribution_operator_id,
              apply_order,
              last_action_id: input.action_id,
            });
            writeApplyOutbox('tender.apply', input);
            return { kind: 'refused', reason: 'internal_error' };
          }
          // Voucher overpayment cap is enforced authority-side (R-7) —
          // V-A returns the authority-confirmed `applied_amount_minor`
          // which we trust over the caller's pre-call estimate.
          if (outcome.applied_amount_minor > remaining) {
            lines.insert({
              tender_line_id: input.tender_line_id,
              payment_attempt_id: input.payment_attempt_id,
              tender_type: 'internal_voucher',
              amount_applied_minor: outcome.applied_amount_minor,
              state: 'refused',
              change_due_minor: null,
              external_reference: null,
              voucher_redemption_intent_token: null,
              voucher_authority_redemption_id: null,
              applied_at: null,
              refused_at: input.applied_at,
              reversed_at: null,
              reversal_pending_since: null,
              refusal_reason: 'non_cash_overpayment_refused',
              attribution_operator_id: input.attribution_operator_id,
              apply_order,
              last_action_id: input.action_id,
            });
            // RT-304 — the line persists `outcome.applied_amount_minor`, but the
            // outbox hash covers the requested `input.amount_applied_minor`.
            writeApplyOutbox('tender.apply', input);
            return { kind: 'refused', reason: 'non_cash_overpayment_refused' };
          }
          lines.insert({
            tender_line_id: input.tender_line_id,
            payment_attempt_id: input.payment_attempt_id,
            tender_type: 'internal_voucher',
            amount_applied_minor: outcome.applied_amount_minor,
            state: 'applied',
            change_due_minor: null,
            external_reference: null,
            voucher_redemption_intent_token: outcome.redemption_intent_token,
            voucher_authority_redemption_id: null,
            applied_at: input.applied_at,
            refused_at: null,
            reversed_at: null,
            reversal_pending_since: null,
            refusal_reason: null,
            attribution_operator_id: input.attribution_operator_id,
            apply_order,
            last_action_id: input.action_id,
          });
          // RT-304 — the line persists `outcome.applied_amount_minor`, but the
          // outbox hash covers the requested `input.amount_applied_minor`.
          writeApplyOutbox('tender.apply', input);
          return {
            kind: 'ok',
            tender_line_id: input.tender_line_id,
            applied_at: input.applied_at,
          };
        }

        // external_card_terminal exact-only.
        if (input.tender_type === 'external_card_terminal') {
          if (input.amount_applied_minor > remaining) {
            lines.insert({
              tender_line_id: input.tender_line_id,
              payment_attempt_id: input.payment_attempt_id,
              tender_type: 'external_card_terminal',
              amount_applied_minor: input.amount_applied_minor,
              state: 'refused',
              change_due_minor: null,
              external_reference: input.external_reference ?? null,
              voucher_redemption_intent_token: null,
              voucher_authority_redemption_id: null,
              applied_at: null,
              refused_at: input.applied_at,
              reversed_at: null,
              reversal_pending_since: null,
              refusal_reason: 'non_cash_overpayment_refused',
              attribution_operator_id: input.attribution_operator_id,
              apply_order,
              last_action_id: input.action_id,
            });
            writeApplyOutbox('tender.apply', input);
            return { kind: 'refused', reason: 'non_cash_overpayment_refused' };
          }
        }

        // cash: may overpay; change_due_minor handles the overage.
        let change_due_minor: number | null = null;
        if (input.tender_type === 'cash' && input.amount_applied_minor > remaining) {
          change_due_minor = input.amount_applied_minor - remaining;
        }

        lines.insert({
          tender_line_id: input.tender_line_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_type: input.tender_type,
          amount_applied_minor: input.amount_applied_minor,
          state: 'applied',
          change_due_minor,
          external_reference:
            input.tender_type === 'external_card_terminal'
              ? (input.external_reference ?? null)
              : null,
          voucher_redemption_intent_token: null,
          voucher_authority_redemption_id: null,
          applied_at: input.applied_at,
          refused_at: null,
          reversed_at: null,
          reversal_pending_since: null,
          refusal_reason: null,
          attribution_operator_id: input.attribution_operator_id,
          apply_order,
          last_action_id: input.action_id,
        });
        writeApplyOutbox('tender.apply', input);

        const ok: ApplyOutcome = {
          kind: 'ok',
          tender_line_id: input.tender_line_id,
          applied_at: input.applied_at,
        };
        if (change_due_minor !== null && change_due_minor > 0) {
          ok.change_due_minor = change_due_minor;
        }
        return ok;
      });
      return txn();
    },

    reverse(input: ReverseTenderLineInput): ReverseOutcome {
      const preflight = preflightReverse(input);
      if (preflight.kind === 'refused') return preflight;
      const txn = db.transaction((): ReverseOutcome => commitReverse(input, preflight.tender_type));
      return txn();
    },

    reverseInTransaction(input: ReverseTenderLineInput): ReverseOutcome {
      const preflight = preflightReverse(input);
      if (preflight.kind === 'refused') return preflight;
      return commitReverse(input, preflight.tender_type);
    },

    markReversalPending(input: MarkReversalPendingInput): MarkReversalPendingOutcome {
      const row = findLineRow(input.payment_attempt_id, input.tender_line_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'line_not_applied' };
      }
      if (!isLegalTenderLineTransition(row.state, 'reversal_pending')) {
        return { kind: 'refused', reason: 'line_not_applied' };
      }
      const txn = db.transaction((): MarkReversalPendingOutcome => {
        lines.updateState({
          tender_line_id: input.tender_line_id,
          state: 'reversal_pending',
          timestamp: input.reversal_pending_since,
          last_action_id: input.action_id,
        });
        const hash = hashActionPayload('tender.reverse', tenderReverseActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: input.tender_line_id,
          action_kind: 'tender.reverse',
          action_payload_hash: hash,
          acting_operator_id: input.attribution_operator_id,
          created_at: input.reversal_pending_since,
        });
        return {
          kind: 'ok',
          reversal_pending_since: input.reversal_pending_since,
          tender_type: row.tender_type,
        };
      });
      return txn();
    },

    confirmReversed(input: ConfirmReversedInput): ConfirmReversedOutcome {
      const row = findLineRow(input.payment_attempt_id, input.tender_line_id);
      if (row === undefined) {
        return { kind: 'refused', reason: 'line_not_applied' };
      }
      if (!isLegalTenderLineTransition(row.state, 'reversed')) {
        return { kind: 'refused', reason: 'line_not_applied' };
      }
      const txn = db.transaction((): ConfirmReversedOutcome => {
        lines.updateState({
          tender_line_id: input.tender_line_id,
          state: 'reversed',
          timestamp: input.reversed_at,
          last_action_id: input.action_id,
        });
        const hash = hashActionPayload('tender.reverse', tenderReverseActionPayload(input));
        outbox.insert({
          action_id: input.action_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_line_id: input.tender_line_id,
          action_kind: 'tender.reverse',
          action_payload_hash: hash,
          acting_operator_id: input.attribution_operator_id,
          created_at: input.reversed_at,
        });
        return { kind: 'ok', reversed_at: input.reversed_at, tender_type: row.tender_type };
      });
      return txn();
    },

    listAppliedLifoIds(payment_attempt_id: string): readonly string[] {
      return lines
        .findByAttempt(payment_attempt_id)
        .filter((l) => l.state === 'applied')
        .sort((a, b) => b.apply_order - a.apply_order)
        .map((l) => l.tender_line_id);
    },
  };
}
