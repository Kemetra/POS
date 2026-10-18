/**
 * T240 / T241 / T242 — print dispatcher (008 Slice 3).
 *
 * Ties the pure print pipeline (render + path-select + dispatch) to durable
 * state: on each print attempt it INSERTs a `print_events` row and emits the
 * matching audit event. Keeping this orchestration OUT of `print-pipeline.ts`
 * leaves path selection unit-testable in isolation (T210-T212) and confines
 * all DB/audit side-effects to one place.
 *
 * Durability invariant (T241 / US1 scenario 8): the print is NOT part of the
 * AD-2 atomic transaction. A genuine print FAILURE (the pipeline ran and got a
 * failure ack) writes a failure `print_events` row + a
 * `sale.receipt.print_failed` audit event and returns `{ ok:false }`, never
 * touching the Sale row.
 *
 * Infra errors are a DIFFERENT class: if the pipeline render, the
 * `print_events` INSERT, or the audit emit themselves THROW (a code/DB bug,
 * not a printer fault), this method propagates the throw rather than
 * mislabelling it as a hardware `failure_reason` — none of the closed enum
 * fits, and a DB-insert failure cannot reliably record a failure row anyway.
 * The Sale is already durably committed before dispatch, so the throw is an
 * operational error to make loud, not data loss to mask. The two TESTABLE
 * callers enforce no-unhandled-rejection: the retry bridge wraps the call into
 * a refusal, and the finalize seam (`dispatchFirstPrintOnFinalize`) catches +
 * logs so it resolves void.
 *
 * Redaction (T242 / FR-071 / AD-9): the rendered slip (HTML + ESC/POS bytes)
 * stays inside the pipeline. The audit + log payloads carry ONLY structural
 * fields (sale_id / render_path / print_event_id / failure_reason) — never the
 * item names or any slip content. This is a by-VALUE guarantee, distinct from
 * the audit emitter's key-name scan.
 */

import type { PrintAdapterResult, PrintPipeline } from './print-pipeline.js';
import type {
  PrintEventsRepository,
  PrintEventRow,
} from '../sales/repositories/print-events.repository.js';
import type { SaleAuditEmitter } from '../sales/audit-emitter.js';
import type { ReceiptPayload } from '../../shared/receipts/types.js';

/**
 * Structural logger port — only the levels the dispatcher uses. Injected so
 * tests can capture every arg by value (T242). Matches the pino `Logger`
 * method shape so the production logger satisfies it directly.
 */
export interface PrintDispatchLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * The non-sensitive context the dispatcher needs to attribute the print event
 * and audit row. Sourced from the finalized Sale + the AD-2 listener seam
 * (already-derived `attribution_operator_id`, per the audit-emitter contract).
 */
export interface PrintDispatchContext {
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  session_id: string | null;
  attribution_operator_id: string;
}

export interface PrintDispatcherDependencies {
  pipeline: PrintPipeline;
  printEventsRepo: PrintEventsRepository;
  auditEmitter: SaleAuditEmitter;
  /** Injected clock — ISO-8601 UTC string. */
  now(): string;
  /** Injected id generator for the print_events PK. */
  newPrintEventId(): string;
  /** Optional structural logger; defaults to a no-op. Never receives slip content. */
  logger?: PrintDispatchLogger;
}

export interface PrintDispatcher {
  /**
   * Dispatch a first-print attempt for a freshly-finalized sale. Resolves with
   * the print outcome + the new `print_events` row id: success → success row +
   * `sale.receipt.printed`; a genuine print failure → failure row +
   * `sale.receipt.print_failed`. Infra errors (render/INSERT/emit throwing)
   * PROPAGATE — see the module doc; the caller (`dispatchFirstPrintOnFinalize`)
   * catches them.
   *
   * Returns the `print_event_id` (symmetric with `dispatchRetryPrint`) so the
   * Slice-4 drawer-kick seam can FK its `drawer_events` row to the triggering
   * first print without a re-query race.
   */
  dispatchFirstPrint(
    payload: ReceiptPayload,
    ctx: PrintDispatchContext,
  ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }>;

  /**
   * Dispatch a retry-after-failure attempt (T250-T252). Writes a
   * `purpose='retry_after_failure'` row carrying the lineage of the prior
   * failed print events; on success emits `sale.receipt.print_retried_success`
   * (a retry success is the canonical first print per FR-052 — no duplicate
   * marker). A still-failed retry writes a failure row + `print_failed` audit
   * and returns the failure result (the attempt itself was accepted). Returns
   * the pipeline result + the new print_event_id.
   */
  dispatchRetryPrint(
    payload: ReceiptPayload,
    ctx: PrintDispatchContext,
    previousFailedPrintEventIds: string[],
  ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }>;

  /**
   * Dispatch a reprint (T400 / Slice 5). Writes a `purpose='reprint'` row with
   * the supplied `duplicate_copy_sequence_number` (the n-th reprint → n) and,
   * on success, emits `sale.receipt.reprinted` carrying BOTH the reprinting
   * operator (`ctx.attribution_operator_id`) and the selling operator
   * (`sellingOperatorId`) per FR-024 / AD-10. A reprint NEVER kicks the drawer
   * (no drawer dispatch here) and is repeatable (no idempotency no-op). Infra
   * errors PROPAGATE (the caller maps them to a refusal).
   */
  dispatchReprint(
    payload: ReceiptPayload,
    ctx: PrintDispatchContext,
    opts: { duplicateCopySequenceNumber: number; sellingOperatorId: string },
  ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }>;
}

const NOOP_LOGGER: PrintDispatchLogger = {
  info: () => {},
  warn: () => {},
};

export function createPrintDispatcher(deps: PrintDispatcherDependencies): PrintDispatcher {
  const { pipeline, printEventsRepo, auditEmitter } = deps;
  const logger = deps.logger ?? NOOP_LOGGER;
  // `now` / `newPrintEventId` are called via `deps.` below (not destructured)
  // to preserve any `this` binding the caller may rely on (unbound-method).
  const now = (): string => deps.now();

  function baseRow(
    ctx: PrintDispatchContext,
    print_event_id: string,
    purpose: PrintEventRow['purpose'],
    previousFailedPrintEventIds: string[] | null,
  ): Omit<PrintEventRow, 'outcome' | 'render_path' | 'failure_reason'> {
    return {
      print_event_id,
      sale_id: ctx.sale_id,
      purpose,
      acting_operator_id: ctx.attribution_operator_id,
      acting_operator_session_id: ctx.session_id ?? '',
      // Always NULL here; the success branch in `record` stamps the reprint
      // sequence number on the row it writes (CHECK: non-null only on a
      // successful reprint).
      duplicate_copy_sequence_number: null,
      previous_failed_print_event_ids:
        previousFailedPrintEventIds === null || previousFailedPrintEventIds.length === 0
          ? null
          : JSON.stringify(previousFailedPrintEventIds),
      printed_at: now(),
    };
  }

  /**
   * Shared attempt recorder for first-print and retry. Writes the print_events
   * row + emits the matching audit event; never logs/audits slip content
   * (T242). `successCategory` distinguishes the first-print
   * (`sale.receipt.printed`) and retry (`sale.receipt.print_retried_success`)
   * audit categories; failures always emit `sale.receipt.print_failed`.
   */
  async function record(
    payload: ReceiptPayload,
    ctx: PrintDispatchContext,
    opts: {
      purpose: PrintEventRow['purpose'];
      successCategory:
        | 'sale.receipt.printed'
        | 'sale.receipt.print_retried_success'
        | 'sale.receipt.reprinted';
      previousFailedPrintEventIds: string[] | null;
      duplicateCopySequenceNumber?: number | null;
      /** Extra structural fields merged into the SUCCESS audit payload (e.g. the
       *  reprint's dual-operator attribution). Never slip content (T242). */
      successAuditExtra?: Readonly<Record<string, unknown>>;
    },
  ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }> {
    const result = await pipeline.render(payload);
    const print_event_id = deps.newPrintEventId();
    const created_at = now();
    // The base row carries NULL for duplicate_copy_sequence_number — the
    // print_events CHECK requires it non-null ONLY on a SUCCESSFUL reprint, and
    // null everywhere else (incl. a FAILED reprint). The success branch below
    // stamps it on the row it actually writes.
    const base = baseRow(ctx, print_event_id, opts.purpose, opts.previousFailedPrintEventIds);
    const printed_at = base.printed_at;

    if (result.ok) {
      printEventsRepo.insert({
        ...base,
        outcome: 'success',
        render_path: result.render_path,
        failure_reason: null,
        duplicate_copy_sequence_number: opts.duplicateCopySequenceNumber ?? null,
      });
      auditEmitter.emitRaw({
        action_category: opts.successCategory,
        attribution_operator_id: ctx.attribution_operator_id,
        tenant_id: ctx.tenant_id,
        branch_id: ctx.branch_id,
        originating_terminal_id: ctx.terminal_id,
        session_id: ctx.session_id,
        created_at,
        // Structural ONLY — no slip content (T242).
        payload: {
          sale_id: ctx.sale_id,
          print_event_id,
          render_path: result.render_path,
          ...opts.successAuditExtra,
        },
      });
      logger.info({ msg: opts.successCategory, sale_id: ctx.sale_id, print_event_id });
      return { result, print_event_id, printed_at };
    }

    printEventsRepo.insert({
      ...base,
      outcome: 'failure',
      // A failed print still chose a path — the print_events CHECK requires
      // render_path on failure rows too (only manual_override is null).
      render_path: result.render_path,
      failure_reason: result.failure_reason,
    });
    auditEmitter.emitRaw({
      action_category: 'sale.receipt.print_failed',
      attribution_operator_id: ctx.attribution_operator_id,
      tenant_id: ctx.tenant_id,
      branch_id: ctx.branch_id,
      originating_terminal_id: ctx.terminal_id,
      session_id: ctx.session_id,
      created_at,
      payload: {
        sale_id: ctx.sale_id,
        print_event_id,
        // Structural metadata (T242-safe — not slip content); present on both
        // success and failure audits, mirroring the DB row.
        render_path: result.render_path,
        failure_reason: result.failure_reason,
      },
    });
    logger.warn({
      msg: 'receipt.print_failed',
      sale_id: ctx.sale_id,
      print_event_id,
      failure_reason: result.failure_reason,
    });
    return { result, print_event_id, printed_at };
  }

  return {
    async dispatchFirstPrint(
      payload: ReceiptPayload,
      ctx: PrintDispatchContext,
    ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }> {
      return record(payload, ctx, {
        purpose: 'first_print',
        successCategory: 'sale.receipt.printed',
        previousFailedPrintEventIds: null,
      });
    },

    dispatchRetryPrint(
      payload: ReceiptPayload,
      ctx: PrintDispatchContext,
      previousFailedPrintEventIds: string[],
    ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }> {
      return record(payload, ctx, {
        purpose: 'retry_after_failure',
        successCategory: 'sale.receipt.print_retried_success',
        previousFailedPrintEventIds,
      });
    },

    dispatchReprint(
      payload: ReceiptPayload,
      ctx: PrintDispatchContext,
      opts: { duplicateCopySequenceNumber: number; sellingOperatorId: string },
    ): Promise<{ result: PrintAdapterResult; print_event_id: string; printed_at: string }> {
      return record(payload, ctx, {
        purpose: 'reprint',
        successCategory: 'sale.receipt.reprinted',
        previousFailedPrintEventIds: null,
        duplicateCopySequenceNumber: opts.duplicateCopySequenceNumber,
        // FR-024 / AD-10: the reprinted audit carries BOTH operator ids — the
        // reprinting operator (ctx.attribution_operator_id, already on every
        // audit payload) and the original selling operator.
        successAuditExtra: {
          reprinting_operator_id: ctx.attribution_operator_id,
          selling_operator_id: opts.sellingOperatorId,
          duplicate_copy_sequence_number: opts.duplicateCopySequenceNumber,
        },
      });
    },
  };
}
