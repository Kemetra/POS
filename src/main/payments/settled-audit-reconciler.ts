/**
 * RT-496 — heal or hold settled attempts stranded without their
 * `payment.settled` audit.
 *
 * Before RT-496 `payments.confirm` committed the settlement and wrote its
 * audit in two steps (RT-481). A throw or crash between them left a STRAND: a
 * `payment_attempts` row in `settled` with no `payment.settled` audit and no
 * Sale. 008's finalize listener and the RT-17 cash-up hold read only the
 * audit, so a strand was never finalized and never held the close. The
 * settle is now atomic (`settlement-commit.ts`), so new strands cannot be
 * committed; this module deals with the ones already on a terminal.
 *
 * For each strand of the terminal:
 *
 *   • HEALED — the row carries its frozen `selling_operator_display_name`
 *     (migration 0051). The audit is re-emitted from durable data only: the
 *     attempt row, its applied tender lines and that name. `selling_user_id`
 *     is not durable and is left out, never guessed (the sale then syncs on
 *     the envelope path, `sales-sync/selling-user-id.ts`). `session_id` is
 *     null: the confirming session is not durable either. `reconciled_at`
 *     marks the heal in the payload. The listener then finalizes it as usual.
 *   • UNATTRIBUTABLE — no frozen name (every row settled before 0051). Nothing
 *     is written: no invented name, no audit, no Sale. The strand stays in
 *     `STRANDED_SETTLEMENT_FILTER`, which the cash-up counts as drawer cash in
 *     flight, so the close stays held until someone resolves it by hand.
 *
 * Each heal runs in its own transaction that re-checks the strand first, so a
 * strand is healed exactly once: a second `payment.settled` row for one
 * attempt would make the sale sync hold it (`multiple_settled_events`).
 */

import type { DatabaseHandle } from '../db/client.js';
import type { PaymentAuditEmitter } from './audit-emitter.js';
import type { PaymentAttemptRow } from './repositories/payment-attempts.repository.js';
import type { PaymentTenderLinesRepository } from './repositories/payment-tender-lines.repository.js';
import { appliedTenderBreakdown } from './settlement-commit.js';

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

/** A settled attempt `a` with no Sale and no `payment.settled` audit. */
const STRANDED = `a.state = 'settled'
        AND NOT EXISTS (
          SELECT 1 FROM sales s WHERE s.envelope_handoff_action_id = a.envelope_handoff_action_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM audit_events e
           WHERE e.action_category = 'payment.settled'
             AND json_extract(e.payload, '$.payment_attempt_id') = a.payment_attempt_id
        )`;

/**
 * The strands of one terminal, over `payment_attempts a`; params tenant_id,
 * branch_id, terminal_id. Disjoint from the listener's
 * `UNFINALIZED_SETTLEMENT_FILTER` (that one needs the audit row), so the
 * cash-up adds the two counts.
 */
export const STRANDED_SETTLEMENT_FILTER = `a.tenant_id = ? AND a.branch_id = ? AND a.terminal_id = ?
        AND ${STRANDED}`;

export type HealOutcome = 'healed' | 'unattributable' | 'not_stranded';

export interface ReconcileScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

export interface ReconcileResult {
  /** Attempt ids whose `payment.settled` audit was re-emitted now. */
  healed: string[];
  /** Attempt ids held for manual review: no trustworthy attribution. */
  unattributable: string[];
}

export interface SettledAuditReconcilerDeps {
  db: Pick<DatabaseHandle, 'prepare' | 'transaction'>;
  linesRepo: Pick<PaymentTenderLinesRepository, 'findByAttempt'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'buildPaymentSettled' | 'emitRaw'>;
  /** ISO-8601 instant stamped as the payload's `reconciled_at`. */
  now: () => string;
}

export interface SettledAuditReconciler {
  /** Heal one attempt if it is a strand (startup scan and same-key replay). */
  healAttempt(payment_attempt_id: string): HealOutcome;
  /** Heal every attributable strand of the terminal; report the rest. */
  reconcile(scope: ReconcileScope): ReconcileResult;
}

/**
 * The attribution a strand carries on its own row, or null when it has none
 * that can be trusted (no frozen display name: settled before 0051).
 */
function durableAttributionOf(
  row: PaymentAttemptRow,
): { display_name: string; settled_at: string } | null {
  const display_name = row.selling_operator_display_name;
  if (display_name === null || display_name.length === 0) return null;
  return row.settled_at === null ? null : { display_name, settled_at: row.settled_at };
}

export function createSettledAuditReconciler(
  deps: SettledAuditReconcilerDeps,
): SettledAuditReconciler {
  const { db, linesRepo, auditEmitter, now } = deps;

  const strandByIdStmt = db.prepare(
    `SELECT a.* FROM payment_attempts a WHERE a.payment_attempt_id = ? AND ${STRANDED}`,
  ) as PrepareGet<PaymentAttemptRow>;

  const strandsOfScopeStmt = db.prepare(
    `SELECT a.payment_attempt_id FROM payment_attempts a
      WHERE ${STRANDED_SETTLEMENT_FILTER}
      ORDER BY a.settled_at, a.payment_attempt_id`,
  ) as PrepareAll<{ payment_attempt_id: string }>;

  function emitFor(row: PaymentAttemptRow, display_name: string, settled_at: string): void {
    const event = auditEmitter.buildPaymentSettled({
      payment_attempt_id: row.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      handoff_action_id: row.envelope_handoff_action_id,
      settled_at,
      attribution_operator_id: row.acting_operator_id,
      selling_operator_display_name: display_name,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: null,
      tender_lines: appliedTenderBreakdown(
        linesRepo.findByAttempt(row.payment_attempt_id),
        settled_at,
      ),
      reconciled_at: now(),
    });
    auditEmitter.emitRaw(event);
  }

  const healAttempt = db.transaction((payment_attempt_id: string): HealOutcome => {
    const row = strandByIdStmt.get(payment_attempt_id);
    if (row === undefined) return 'not_stranded';
    const attribution = durableAttributionOf(row);
    if (attribution === null) return 'unattributable';
    emitFor(row, attribution.display_name, attribution.settled_at);
    return 'healed';
  });

  return {
    healAttempt,
    reconcile(scope) {
      const result: ReconcileResult = { healed: [], unattributable: [] };
      const strands = strandsOfScopeStmt.all(scope.tenant_id, scope.branch_id, scope.terminal_id);
      for (const { payment_attempt_id } of strands) {
        const outcome = healAttempt(payment_attempt_id);
        if (outcome === 'healed') result.healed.push(payment_attempt_id);
        if (outcome === 'unattributable') result.unattributable.push(payment_attempt_id);
      }
      return result;
    },
  };
}
