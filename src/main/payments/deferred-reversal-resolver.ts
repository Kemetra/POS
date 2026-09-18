/**
 * 006 T270 — Deferred-reversal resolver (Wave 5 GREEN).
 *
 * Resolves `reversal_pending` voucher tender lines by retrying
 * `vouchers.reverse` against Data-Pulse-2 (V-A). Lines transition
 * `reversal_pending → reversed` on success. On any non-success outcome
 * the line stays pending for a future retry — conservative posture:
 * we never auto-transition to a clean terminal state on a refused V-A
 * response (the refusal may itself be wrong; manual incident response
 * decides).
 *
 * Triggers (per `contracts/bridge-api.md` §"Deferred reversal" + research §R-13):
 *
 *   (a) **App start** — `start()` calls `runOnce()` immediately so a
 *       process that died mid-pending resumes resolution as soon as
 *       it comes back up.
 *   (b) **Network-restore signal** from 003 — `start()` subscribes a
 *       callback that calls `runOnce()` whenever the signal fires.
 *   (c) **Explicit cashier retry** — `runOnce()` is exported so a
 *       manual-retry bridge surface (Wave 5+) can drive it.
 *
 * AUDIT (T231):
 *   The resolver forwards the original `reversal_pending_since`
 *   timestamp from the row into the `tender.reversed` audit payload
 *   so incident reconstruction can correlate the outage with its
 *   resolution. The row state's `reversal_pending_since` column is
 *   cleared on transition (data-model.md §"PaymentTenderLine" line
 *   156); the audit_events row (append-only) preserves the full
 *   timeline.
 *
 * IDEMPOTENCY:
 *   The resolver uses a deterministic per-line `action_id` of the
 *   form `${tender_line_id}:resolver:retry`. V-A `vouchers.reverse`
 *   is idempotent under the same `Idempotency-Key`, and the local
 *   outbox `UNIQUE(action_id)` constraint means repeated retries
 *   collapse to a single audit row. Once the FSM transitions the
 *   line to `reversed`, subsequent resolver passes don't see the
 *   line in the pending scan, so the action_id collision (had it
 *   reached the outbox) is also moot.
 *
 * SECURITY:
 *   - The redemption_id passed to V-A is opaque (FR-017 allow-list).
 *   - No voucher_redemption_intent_token is ever logged or forwarded
 *     (FR-017 / F-A4B-004).
 *   - The resolver runs main-process-only; no renderer surface.
 */

import type {
  PaymentTenderLinesRepository,
  PaymentTenderLineRow,
} from './repositories/payment-tender-lines.repository.js';
import type { PaymentAttemptsRepository } from './repositories/payment-attempts.repository.js';
import type { TenderLineFsm } from './fsm/tender-line-fsm.js';
import type { PaymentAuditEmitter } from './audit-emitter.js';
import type {
  ReverseVoucherInput,
  ReverseVoucherOutcome,
} from './voucher-authority-client/reverse.js';

export interface ResolverLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * The 003 network-restore signal. Real implementation will land in a
 * future spec (network module not yet present); for now the bootstrap
 * wires a no-op subscribe and the field stays optional in production
 * configurations. The resolver still operates fully via `start()`
 * (app-start trigger) and `runOnce()` (manual retry).
 */
export interface NetworkRestoreSignal {
  subscribe(cb: () => void | Promise<void>): () => void;
}

export interface DeferredReversalResolverDeps {
  linesRepo: Pick<PaymentTenderLinesRepository, 'findReversalPendingLines' | 'findByLineId'>;
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findById'>;
  tenderLineFsm: Pick<TenderLineFsm, 'confirmReversed'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitTenderReversed'>;
  /**
   * V-A `vouchers.reverse` call adapter. The resolver supplies a
   * per-line `idempotencyKey` (derived from `tender_line_id`) so the
   * authority and any local outbox can treat repeated retries as a
   * single logical operation. The bootstrap is responsible for closing
   * over baseUrl / fetch / logger before injection.
   */
  reverseVoucher: (
    input: ReverseVoucherInput,
    options: { idempotencyKey: string },
  ) => Promise<ReverseVoucherOutcome>;
  networkRestoreSignal?: NetworkRestoreSignal;
  logger: ResolverLogger;
  clock: () => Date;
}

export interface DeferredReversalResolver {
  /** Trigger immediately and subscribe to the network-restore signal. */
  start(): Promise<void>;
  /** Single-shot scan-and-retry. Used by the cashier-initiated path. */
  runOnce(): Promise<void>;
  /** Unsubscribe from the network-restore signal (test/teardown hook). */
  stop(): void;
}

export function createDeferredReversalResolver(
  deps: DeferredReversalResolverDeps,
): DeferredReversalResolver {
  const {
    linesRepo,
    attemptsRepo,
    tenderLineFsm,
    auditEmitter,
    reverseVoucher,
    networkRestoreSignal,
    logger,
    clock,
  } = deps;

  let unsubscribeSignal: (() => void) | null = null;
  let running = false;

  async function processLine(line: PaymentTenderLineRow): Promise<void> {
    if (line.voucher_authority_redemption_id === null) {
      // Defence-in-depth — a `reversal_pending` voucher line without a
      // persisted V-A redemption_id is impossible under T261 / T262
      // (both paths only mark `reversal_pending` AFTER a redemption_id
      // was stamped). But the column is nullable, so a corrupted row
      // could appear in the scan; refuse to send a malformed V-A
      // request and log for triage.
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          reason: 'missing_voucher_authority_redemption_id',
        },
        'deferred_reversal_resolver:skipped_malformed_row',
      );
      return;
    }
    if (line.reversal_pending_since === null) {
      // Same defence-in-depth posture for the timestamp — the FSM
      // transition always stamps it, but a corrupted row would lack it.
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          reason: 'missing_reversal_pending_since',
        },
        'deferred_reversal_resolver:skipped_malformed_row',
      );
      return;
    }
    const attempt = attemptsRepo.findById(line.payment_attempt_id);
    if (attempt === undefined) {
      // FK violation — defence-in-depth.
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          reason: 'orphan_line_attempt_missing',
        },
        'deferred_reversal_resolver:skipped_orphan',
      );
      return;
    }
    const action_id = `${line.tender_line_id}:resolver:retry`;
    const outcome = await reverseVoucher(
      { redemption_id: line.voucher_authority_redemption_id },
      { idempotencyKey: action_id },
    );
    if (outcome.kind === 'authority_unreachable') {
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          outcome: 'authority_unreachable',
        },
        'deferred_reversal_resolver:retry_unreachable',
      );
      return;
    }
    if (outcome.kind === 'refused') {
      // Conservative: leave the line in `reversal_pending` so manual
      // incident response can investigate. The structured refusal
      // reason goes to the warn log for ops triage.
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          refusal_reason: outcome.reason,
          outcome: 'refused',
        },
        'deferred_reversal_resolver:retry_refused',
      );
      return;
    }
    // Success — drive the FSM transition + emit the resolution audit.
    // Read `reversal_pending_since` BEFORE the transition (the repo
    // UPDATE clears the column on `state='reversed'`).
    const reversed_at = clock().toISOString();
    const fsmOutcome = tenderLineFsm.confirmReversed({
      tender_line_id: line.tender_line_id,
      payment_attempt_id: line.payment_attempt_id,
      reversed_at,
      attribution_operator_id: line.attribution_operator_id,
      action_id,
    });
    if (fsmOutcome.kind === 'refused') {
      // The line moved underneath us (e.g., another resolver pass /
      // process race). Log and continue.
      logger.warn(
        {
          tender_line_id: line.tender_line_id,
          payment_attempt_id: line.payment_attempt_id,
          fsm_refusal_reason: fsmOutcome.reason,
        },
        'deferred_reversal_resolver:fsm_refused_transition',
      );
      return;
    }
    auditEmitter.emitTenderReversed({
      tender_line_id: line.tender_line_id,
      payment_attempt_id: line.payment_attempt_id,
      tender_type: 'internal_voucher',
      reversed_at: fsmOutcome.reversed_at,
      attribution_operator_id: line.attribution_operator_id,
      tenant_id: attempt.tenant_id,
      branch_id: attempt.branch_id,
      originating_terminal_id: attempt.terminal_id,
      // Resolver fires outside any operator session (app-start /
      // network-restore). The audit row reflects this with a null
      // session id; the cashier session that originally owned the
      // attempt is recorded in audit history via the earlier
      // `tender.reversal_pending` event.
      session_id: null,
      manual_void_required: false,
      // T231 — preserve the original outage moment for incident
      // reconstruction.
      reversal_pending_since: line.reversal_pending_since,
    });
    logger.info(
      {
        tender_line_id: line.tender_line_id,
        payment_attempt_id: line.payment_attempt_id,
        reversed_at: fsmOutcome.reversed_at,
      },
      'deferred_reversal_resolver:line_resolved',
    );
  }

  async function runOnce(): Promise<void> {
    if (running) {
      // Reentrancy guard — a network-restore signal landing while an
      // app-start sweep is still in flight should not double-sweep.
      // The in-flight sweep will pick up new pending lines naturally
      // (the scan is re-issued at the start of the next call).
      return;
    }
    running = true;
    try {
      const pending = linesRepo.findReversalPendingLines();
      for (const line of pending) {
        // Per-line try/catch (CR-2): a thrown error from one line — e.g., a
        // V-A transport rejection in `reverseVoucher` or an unexpected FSM
        // throw — must NOT abort the sweep. Other pending lines in the
        // same pass still deserve their retry. The error is logged with
        // the line id for triage; the line stays in `reversal_pending`
        // and will be picked up on the next sweep (app-restart / network-
        // restore signal / cashier retry).
        try {
          await processLine(line);
        } catch (err: unknown) {
          logger.error(
            {
              tender_line_id: line.tender_line_id,
              payment_attempt_id: line.payment_attempt_id,
              error: err instanceof Error ? err.message : String(err),
            },
            'deferred_reversal_resolver:line_threw',
          );
        }
      }
    } finally {
      running = false;
    }
  }

  async function start(): Promise<void> {
    if (networkRestoreSignal !== undefined) {
      unsubscribeSignal = networkRestoreSignal.subscribe(() => {
        // Fire-and-forget — surface failures via the logger but never
        // throw into the signal source.
        void runOnce().catch((err: unknown) => {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'deferred_reversal_resolver:run_failed',
          );
        });
      });
    }
    await runOnce();
  }

  function stop(): void {
    if (unsubscribeSignal !== null) {
      unsubscribeSignal();
      unsubscribeSignal = null;
    }
  }

  return { start, runOnce, stop };
}
