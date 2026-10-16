/**
 * T091 — AD-2 atomic finalize transaction (008 Slice 1c).
 *
 * The load-bearing module of 008. Composes the work that turns a settled
 * 006 payment attempt into a durable 008 Sale row + outbox enqueue + audit
 * emission, all inside ONE SQLite transaction so a crash before COMMIT
 * leaves no partial state for the AD-2 v3 recovery scan (T092) to clean up.
 *
 * The caller is the AD-2 v3 polling worker (T090, lands in S1c.2): it
 * scans `audit_events.payment.settled` rows whose `handoff_action_id` has
 * no matching `sales` row, then invokes `finalize(input)` once per match.
 * Idempotency on `envelope_handoff_action_id` (FR-001 / SC-009) means the
 * worker may safely dispatch the same input across a crash boundary.
 *
 * Seven steps per plan §AD-2:
 *
 *   1. Idempotency check — return `finalized_idempotent` if a sales row
 *      already exists for this handoff_action_id.
 *   2. Source-attempt refusal guard — refuse if the bound payment_attempts
 *      row is force_failed, not settled, or has a reversal_pending line
 *      (FR-005, FR-045, FR-046, FR-047). Emits `sale.finalization_refused`.
 *   3. Forbidden-field scan on `tender_lines_summary` (FR-070..FR-074 +
 *      CR3 from PR #261). Emits `sale.finalization_refused` with
 *      refusal_reason='forbidden_field_in_tender_summary' on hit.
 *   4. Take `finalized_at`, derive the sale-number day from it (RT-551:
 *      the Africa/Cairo business day), then allocate `sale_number` via the
 *      AD-7 allocator (T085).
 *   5. INSERT the `sales` row.
 *   6. INSERT the `sale_sync_outbox` row with state='pending'.
 *   7. Emit the `sale.finalized` audit event, and — once per terminal —
 *      `sale.number_day_rule.switched` (RT-551 Option A cutover).
 *
 * Steps 4-7 run inside `db.transaction(...)` so a failure between
 * (4) and (7) rolls back the allocator's sequence increment too — the
 * sequence-table row is the only mutable state in 008 and is the only
 * piece that needs rollback discipline. (The unit test sale-number-
 * allocator.txn-rollback.test.ts is the canonical proof.)
 *
 * The refusal-guard branch (step 2-3) does NOT need a transaction wrapper
 * because no INSERT happens — only the audit emit, which is itself an
 * INSERT but is acceptable as an out-of-band side effect (refusals are
 * audit-only, no Sale state to roll back).
 */

import type { DatabaseHandle } from '../db/client.js';
import type { SaleRow, SalesRepository } from './repositories/sales.repository.js';
import type { SaleSyncOutboxRepository } from '../sync-outbox/sale-sync-outbox.repository.js';
import type { SaleNumberAllocator } from './sale-number-allocator.js';
import type { SaleAuditEmitter } from './audit-emitter.js';
import type { SalesTenderType, SaleFinalizationRefusalReason } from '../../shared/sales/types.js';
import type { LineSnapshot } from '../../shared/cart/handoff-envelope.js';
import { findForbiddenKey } from '../audit/find-forbidden-key.js';
import { redactTenderLine } from './redact-tender-line.js';
import { bindSaleNumberDayRuleSwitch, saleNumberDayOf } from './sale-number-day-rule.js';

// ─── Narrow better-sqlite3 surface (mirrors repositories) ───────────────────

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

// ─── Input shape ────────────────────────────────────────────────────────────

/**
 * Closed-set tender-line summary as received from the AD-2 worker. The
 * worker derives this from 006's `payment_tender_lines` + envelope context;
 * by the time it reaches us the cleartext `external_reference` may be
 * present (it's the legitimate card-terminal reference, redacted to `*****`
 * by the audit emitter before persistence). Voucher fields, card data,
 * envelope bodies are NOT permitted here — the forbidden-field scan
 * refuses the finalize if any leak through.
 */
export interface FinalizeTenderLineSummary {
  tender_type: SalesTenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
  voucher_authority_redemption_id?: string;
}

export interface FinalizeInput {
  envelope_handoff_action_id: string;
  payment_attempt_id: string;
  envelope_cart_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  terminal_label: string;
  selling_operator_id: string;
  selling_operator_display_name: string;
  selling_operator_session_id: string;
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;
  tender_lines_summary: readonly FinalizeTenderLineSummary[];
  settled_at: string;
  tenant_tax_registration_id: string;
  branch_name: string;
  branch_address: string;
  /**
   * Frozen snapshot of the cart's item lines from the source
   * `PaymentIntentEnvelope`. Persisted verbatim (JSON) onto the Sale row
   * for byte-stable reprints (FR-015 / FR-016). The projection module
   * (T094b) derives this from `carts.handoff_envelope_json`.
   */
  lines: readonly LineSnapshot[];
}

// ─── Result shapes ──────────────────────────────────────────────────────────

export interface FinalizeFinalized {
  kind: 'finalized';
  sale_id: string;
  sale_number: string;
  receipt_number: string;
  finalized_at: string;
}

export interface FinalizeFinalizedIdempotent {
  kind: 'finalized_idempotent';
  sale_id: string;
  sale_number: string;
  receipt_number: string;
}

export interface FinalizeRefused {
  kind: 'refused';
  refusal_reason: SaleFinalizationRefusalReason;
}

export type FinalizeResult = FinalizeFinalized | FinalizeFinalizedIdempotent | FinalizeRefused;

// ─── DI ─────────────────────────────────────────────────────────────────────

export interface FinalizeTransactionDependencies {
  db: DatabaseHandle;
  salesRepo: SalesRepository;
  outboxRepo: SaleSyncOutboxRepository;
  allocator: SaleNumberAllocator;
  auditEmitter: SaleAuditEmitter;
  /** Injected clock (returns ISO 8601). */
  now: () => string;
  /** Injected UUID v4 generators (R9: deterministic tests). */
  saleIdGenerator: () => string;
  outboxRowIdGenerator: () => string;
}

export interface FinalizeTransaction {
  finalize(input: FinalizeInput): FinalizeResult;
}

// ─── Forbidden-key scan (composes 004 + 008-local sets) ─────────────────────

/**
 * Same set as `src/main/sales/audit-emitter.ts` SALES_FORBIDDEN_KEYS. Kept
 * local rather than exported so the audit emitter and the finalize
 * transaction can evolve their defensive scans independently — both
 * compose the shared 004 list as the root of trust.
 */
const FINALIZE_FORBIDDEN_KEYS = new Set<string>([
  // FR-070 — card-data PAN / track / CVV / cardholder / expiry / auth_payload / cryptogram
  'pan',
  'cvv',
  'cvc',
  'track',
  'track1',
  'track2',
  'cardholder',
  'cardholder_name',
  'expiry',
  'auth_payload',
  'cryptogram',
  // FR-071 — voucher
  'voucher_code',
  'voucher_balance',
  'voucher_redemption_intent_token',
  'authority_payload',
  // FR-072 — secret credentials beyond 004's shared list
  'jwt',
  // FR-073 — envelope handoff raw
  'envelope_handoff_action_id_raw',
  // FR-074 — raw envelope
  'envelope_payload',
  'raw_envelope',
  // CR3 — issuer identity / PIN record id
  'issuer_name',
  'pin_record_id',
]);

/** The tender summary as persisted on the sale: card references masked, no secrets. */
function buildRedactedTenderLinesSummary(input: FinalizeInput): Array<Record<string, unknown>> {
  return input.tender_lines_summary.map((line) => ({
    ...redactTenderLine(line),
    ...(line.tender_type === 'internal_voucher' &&
    line.voucher_authority_redemption_id !== undefined
      ? { voucher_authority_redemption_id: line.voucher_authority_redemption_id }
      : {}),
  }));
}

/** What the finalize transaction issued for a sale: identity, number, instant and day. */
interface IssuedSale {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
  /** RT-551 — the business day of `finalized_at`: the counter key and the number's date. */
  local_calendar_day: string;
}

/** The append-only `sales` row for an issued sale (receipt_number === sale_number, 008 v1). */
function saleRowFor(input: FinalizeInput, issued: IssuedSale): SaleRow {
  return {
    ...issued,
    receipt_number: issued.sale_number,
    envelope_handoff_action_id: input.envelope_handoff_action_id,
    payment_attempt_id: input.payment_attempt_id,
    envelope_cart_id: input.envelope_cart_id,
    tenant_id: input.tenant_id,
    branch_id: input.branch_id,
    terminal_id: input.terminal_id,
    terminal_label: input.terminal_label,
    selling_operator_id: input.selling_operator_id,
    selling_operator_display_name: input.selling_operator_display_name,
    selling_operator_session_id: input.selling_operator_session_id,
    subtotal_minor: input.subtotal_minor,
    total_tax_minor: input.total_tax_minor,
    total_change_due_minor: input.total_change_due_minor,
    tender_lines_summary_json: JSON.stringify(buildRedactedTenderLinesSummary(input)),
    settled_at: input.settled_at,
    tenant_tax_registration_id: input.tenant_tax_registration_id,
    branch_name: input.branch_name,
    branch_address: input.branch_address,
    lines_json: JSON.stringify(input.lines),
  };
}

// ─── 006 read shapes (narrow projections used by the refusal guard) ────────

interface PaymentAttemptProjection {
  state: string;
}

interface TenderLineStateProjection {
  state: string;
}

type TxnResult =
  | {
      kind: 'inserted';
      sale_id: string;
      sale_number: string;
      receipt_number: string;
      finalized_at: string;
    }
  | { kind: 'duplicate_detected_in_txn'; existing_sale_id: string };

// ─── Factory ────────────────────────────────────────────────────────────────

export function bindFinalizeTransaction(
  deps: FinalizeTransactionDependencies,
): FinalizeTransaction {
  const {
    db,
    salesRepo,
    outboxRepo,
    allocator,
    auditEmitter,
    now,
    saleIdGenerator,
    outboxRowIdGenerator,
  } = deps;

  const readAttemptStmt = db.prepare(
    `SELECT state FROM payment_attempts WHERE payment_attempt_id = ?`,
  ) as PrepareGet<PaymentAttemptProjection>;

  const dayRuleSwitch = bindSaleNumberDayRuleSwitch({ db, auditEmitter });

  const readTenderStatesStmt = db.prepare(
    `SELECT state FROM payment_tender_lines WHERE payment_attempt_id = ?`,
  ) as PrepareAll<TenderLineStateProjection>;

  function emitRefusal(
    input: FinalizeInput,
    reason: SaleFinalizationRefusalReason,
  ): FinalizeRefused {
    auditEmitter.emitSaleFinalizationRefused({
      tenant_id: input.tenant_id,
      branch_id: input.branch_id,
      originating_terminal_id: input.terminal_id,
      session_id: input.selling_operator_session_id,
      attribution_operator_id: input.selling_operator_id,
      envelope_handoff_action_id: input.envelope_handoff_action_id,
      refused_at: now(),
      refusal_reason: reason,
    });
    return { kind: 'refused', refusal_reason: reason };
  }

  /** Why the sale may not be finalized from this attempt, or `null` when it may. */
  function sourceRefusalReason(input: FinalizeInput): SaleFinalizationRefusalReason | null {
    const attempt = readAttemptStmt.get(input.payment_attempt_id);
    if (attempt === undefined) return 'source_attempt_not_settled';
    if (attempt.state === 'force_failed') return 'force_failed_attempt';
    if (attempt.state !== 'settled') return 'source_attempt_not_settled';
    const tenderStates = readTenderStatesStmt.all(input.payment_attempt_id);
    if (tenderStates.some((row) => row.state === 'reversal_pending')) {
      return 'reversal_pending_line';
    }
    // Step 3 — Forbidden-field scan.
    if (findForbiddenKey(input.tender_lines_summary, FINALIZE_FORBIDDEN_KEYS) !== null) {
      return 'forbidden_field_in_tender_summary';
    }
    return null;
  }

  /**
   * Inside the finalize transaction: re-check idempotency, take `finalized_at`
   * and its business day (RT-551), allocate the sale number under that day,
   * then write the sale row, its sync-outbox row and the audit events.
   */
  function insertSaleOutboxAndAudit(input: FinalizeInput): TxnResult {
    const concurrent = salesRepo.findByHandoffActionId(input.envelope_handoff_action_id);
    if (concurrent !== null) {
      return { kind: 'duplicate_detected_in_txn', existing_sale_id: concurrent.sale_id };
    }
    const finalized_at = now();
    const local_calendar_day = saleNumberDayOf(finalized_at);
    const sale_number = allocator.allocate({
      terminal_id: input.terminal_id,
      terminal_label: input.terminal_label,
      local_calendar_day,
    });
    const sale_id = saleIdGenerator();
    const receipt_number = sale_number; // 008 v1: receipt_number === sale_number (data-model.md).

    salesRepo.insert(saleRowFor(input, { sale_id, sale_number, finalized_at, local_calendar_day }));

    outboxRepo.insert({
      outbox_row_id: outboxRowIdGenerator(),
      sale_id,
      envelope_handoff_action_id: input.envelope_handoff_action_id,
      tenant_id: input.tenant_id,
      branch_id: input.branch_id,
      terminal_id: input.terminal_id,
      state: 'pending',
      enqueued_at: finalized_at,
    });

    auditEmitter.emitSaleFinalized({
      tenant_id: input.tenant_id,
      branch_id: input.branch_id,
      originating_terminal_id: input.terminal_id,
      session_id: input.selling_operator_session_id,
      attribution_operator_id: input.selling_operator_id,
      sale_id,
      sale_number,
      payment_attempt_id: input.payment_attempt_id,
      envelope_handoff_action_id: input.envelope_handoff_action_id,
      finalized_at,
      subtotal_minor: input.subtotal_minor,
      total_tax_minor: input.total_tax_minor,
      tender_lines_summary: input.tender_lines_summary,
    });

    dayRuleSwitch.recordIfFirst({
      tenant_id: input.tenant_id,
      branch_id: input.branch_id,
      terminal_id: input.terminal_id,
      sale_id,
      sale_number,
      finalized_at,
      business_day: local_calendar_day,
    });

    return {
      kind: 'inserted',
      sale_id,
      sale_number,
      receipt_number,
      finalized_at,
    };
  }

  return {
    finalize(input: FinalizeInput): FinalizeResult {
      // Step 1 — Fast-path idempotency check (read-only, outside the txn).
      //
      // This is a courtesy check that lets the typical case (no duplicate)
      // skip the refusal-guard work too. It is NOT load-bearing — the real
      // protection is the unique index on `sales.envelope_handoff_action_id`
      // (migration 0020) combined with the re-check inside the transaction
      // below. The re-check closes the TOCTOU window between this read and
      // the INSERT (per CR2 on PR #264). In production, AD-2's per-terminal
      // serialisation makes concurrent finalize calls for the same
      // handoff_action_id virtually impossible, but the DB-layer uniqueness
      // is the defence-in-depth guarantee.
      const existing = salesRepo.findByHandoffActionId(input.envelope_handoff_action_id);
      if (existing !== null) {
        return {
          kind: 'finalized_idempotent',
          sale_id: existing.sale_id,
          sale_number: existing.sale_number,
          receipt_number: existing.receipt_number,
        };
      }

      // Steps 2-3 — Source-attempt refusal guard, then the forbidden-field scan.
      const refusal = sourceRefusalReason(input);
      if (refusal !== null) return emitRefusal(input, refusal);

      // Steps 4-7 — Atomic write + audit.
      //
      // Per CR2 on PR #264 — re-check idempotency INSIDE the transaction
      // before allocating the sequence to close the TOCTOU window between
      // the fast-path check above and this INSERT. On hit, return a
      // sentinel that the outer code translates into the idempotent
      // result without writing any state.
      const txn = db.transaction((): TxnResult => insertSaleOutboxAndAudit(input));
      const result = txn();
      if (result.kind === 'duplicate_detected_in_txn') {
        // Re-read the durable row outside the (now-committed empty) txn
        // so we return the canonical sale_number / receipt_number. The
        // existing row's content can't change once written — it's
        // append-only at the SQL layer.
        const existing = salesRepo.readById(result.existing_sale_id);
        /* c8 ignore start — defensive throw on impossible "row found in txn but vanished after" */
        if (existing === null) {
          throw new Error(
            `finalize-transaction: duplicate detected in-txn but row ${result.existing_sale_id} not readable after commit`,
          );
        }
        /* c8 ignore stop */
        return {
          kind: 'finalized_idempotent',
          sale_id: existing.sale_id,
          sale_number: existing.sale_number,
          receipt_number: existing.receipt_number,
        };
      }
      dayRuleSwitch.noteCommitted(input.tenant_id, input.terminal_id);
      return {
        kind: 'finalized',
        sale_id: result.sale_id,
        sale_number: result.sale_number,
        receipt_number: result.receipt_number,
        finalized_at: result.finalized_at,
      };
    },
  };
}
