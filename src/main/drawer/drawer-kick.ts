/**
 * T350 / T351 — drawer-kick dispatcher (008 Slice 4).
 *
 * The main-process-only logic that decides whether a finalized sale's cash
 * drawer should pop, issues the kick via the injected `DrawerKickTransport`
 * (AD-8 separate command), writes the single `drawer_events` row, and emits the
 * matching `sale.drawer.*` audit event. No renderer-callable surface (AD-5).
 *
 * Three-gate firing rule (FR-040), checked in order:
 *   1. Sale durably committed — guaranteed by the caller (this runs in the
 *      finalize → first-print seam, AFTER the AD-2 transaction).
 *   2. Print-success ack received — the caller passes only a successful
 *      first-print's `triggering_print_event_id`.
 *   3. Tender mix includes ≥ 1 applied `cash` line — checked here from the
 *      Sale's `tender_lines_summary_json`.
 *
 * Outcome matrix (exactly ONE `drawer_events` row per sale, ever — UNIQUE(sale_id)
 * at the schema layer, FR-053):
 *   • prior row already exists      → no-op (FR-053 double-kick suppression;
 *                                     covers reprint + retry-after-partial-open).
 *   • cash-inclusive first print    → kick → `opened` | `failed` row + audit.
 *   • …and the kick answers `no_drawer_configured` (RT-531: the cash drawer is
 *     optional; this terminal has none) → `suppressed` / `no_drawer_configured`
 *     row + `sale.drawer.suppressed` audit — never `failed`, so no notice.
 *   • cashless first print          → `suppressed` / `cashless_tender_mix` row
 *                                     + `sale.drawer.suppressed` audit; NO kick.
 *
 * `readBySale` is the application-level FR-053 guard; the UNIQUE(sale_id)
 * constraint is the schema-level backstop. Both hold; the guard avoids relying
 * on a thrown constraint error for control flow.
 */

import type {
  DrawerEventsRepository,
  DrawerEventFailureReason,
  DrawerEventSuppressionReason,
} from '../sales/repositories/drawer-events.repository.js';
import type { DrawerKickTransport } from './drawer-kick-transport.js';
import type { SaleAuditEmitter } from '../sales/audit-emitter.js';
import type { TenderLineSummary } from '../../shared/sales/types.js';

/** Structural logger port — only the levels the dispatcher uses. */
export interface DrawerKickLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * The non-sensitive context the dispatcher needs. Sourced from the finalized
 * Sale row + the triggering first-print event. `tender_lines_summary_json` is
 * the persisted JSON the cash gate reads; `session_id` may be null.
 */
export interface DrawerKickContext {
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  session_id: string | null;
  attribution_operator_id: string;
  tender_lines_summary_json: string;
  /** The successful first-print event that triggers this kick (FK target). */
  triggering_print_event_id: string;
}

export interface DrawerKickDependencies {
  drawerEventsRepo: DrawerEventsRepository;
  transport: DrawerKickTransport;
  auditEmitter: SaleAuditEmitter;
  /** Injected clock — ISO-8601 UTC string. */
  now(): string;
  /** Injected id generator for the drawer_events PK. */
  newDrawerEventId(): string;
  /** Optional structural logger; defaults to a no-op. Never receives slip content. */
  logger?: DrawerKickLogger;
}

export interface DrawerKickDispatcher {
  /**
   * Evaluate gating + dispatch the kick for a freshly-finalized,
   * successfully-first-printed sale. Resolves void; never throws across the
   * fire-and-forget finalize seam (a transport fault becomes a `failed` row +
   * banner, a JSON-parse fault degrades to a no-op).
   */
  dispatchOnFirstPrintSuccess(ctx: DrawerKickContext): Promise<void>;
}

const NOOP_LOGGER: DrawerKickLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * Parse the persisted tender summary and report whether ≥ 1 applied `cash`
 * line is present (FR-040 gate c). A malformed column degrades to `false`
 * (treated as cashless → suppressed, never a spurious kick) — the caller's
 * try/catch additionally guards the whole dispatch.
 */
export function hasCashTender(tender_lines_summary_json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tender_lines_summary_json);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return (parsed as unknown[]).some((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    const line = entry as Partial<TenderLineSummary>;
    return (
      line.tender_type === 'cash' &&
      typeof line.amount_applied_minor === 'number' &&
      line.amount_applied_minor > 0
    );
  });
}

/** The outcome-independent columns of a `drawer_events` row, shared by the
 *  three record helpers. The outcome-specific fields (outcome / reasons /
 *  last_successful_open_at) are filled per branch. */
interface BaseDrawerRow {
  drawer_event_id: string;
  sale_id: string;
  triggering_print_event_id: string;
  terminal_id: string;
  attempted_at: string;
}

export function createDrawerKickDispatcher(deps: DrawerKickDependencies): DrawerKickDispatcher {
  const { drawerEventsRepo, transport, auditEmitter } = deps;
  const logger = deps.logger ?? NOOP_LOGGER;
  const now = (): string => deps.now();

  function emitDrawer(
    category: 'sale.drawer.opened' | 'sale.drawer.suppressed' | 'sale.drawer.failed',
    ctx: DrawerKickContext,
    payload: Readonly<Record<string, unknown>>,
    created_at: string,
  ): void {
    auditEmitter.emitRaw({
      action_category: category,
      attribution_operator_id: ctx.attribution_operator_id,
      tenant_id: ctx.tenant_id,
      branch_id: ctx.branch_id,
      originating_terminal_id: ctx.terminal_id,
      session_id: ctx.session_id,
      created_at,
      payload,
    });
  }

  // ── Per-outcome record helpers (one drawer_events row + matching audit each).
  // Extracted so the public method stays under the function-length ceiling and
  // the three terminal triples (insert + emit + log) don't repeat inline.

  function recordSuppressed(
    ctx: DrawerKickContext,
    base: BaseDrawerRow,
    created_at: string,
    suppression_reason: DrawerEventSuppressionReason,
  ): void {
    drawerEventsRepo.insert({
      ...base,
      outcome: 'suppressed',
      suppression_reason,
      failure_reason: null,
      last_successful_open_at_for_terminal: null,
    });
    emitDrawer(
      'sale.drawer.suppressed',
      ctx,
      {
        sale_id: ctx.sale_id,
        drawer_event_id: base.drawer_event_id,
        suppression_reason,
      },
      created_at,
    );
    logger.info({ msg: 'sale.drawer.suppressed', sale_id: ctx.sale_id, suppression_reason });
  }

  function recordOpened(ctx: DrawerKickContext, base: BaseDrawerRow, created_at: string): void {
    drawerEventsRepo.insert({
      ...base,
      outcome: 'opened',
      suppression_reason: null,
      failure_reason: null,
      last_successful_open_at_for_terminal: null,
    });
    emitDrawer(
      'sale.drawer.opened',
      ctx,
      { sale_id: ctx.sale_id, drawer_event_id: base.drawer_event_id },
      created_at,
    );
    logger.info({ msg: 'sale.drawer.opened', sale_id: ctx.sale_id });
  }

  function recordFailed(
    ctx: DrawerKickContext,
    base: BaseDrawerRow,
    created_at: string,
    failure_reason: DrawerEventFailureReason,
  ): void {
    // Capture last-known-good open time for incident reconstruction
    // (Constitution §IV) on the failed row + audit payload.
    const last_successful_open_at = drawerEventsRepo.findLastSuccessfulOpenForTerminal(
      ctx.terminal_id,
    );
    drawerEventsRepo.insert({
      ...base,
      outcome: 'failed',
      suppression_reason: null,
      failure_reason,
      last_successful_open_at_for_terminal: last_successful_open_at,
    });
    emitDrawer(
      'sale.drawer.failed',
      ctx,
      {
        sale_id: ctx.sale_id,
        drawer_event_id: base.drawer_event_id,
        failure_reason,
        last_successful_open_at_for_terminal: last_successful_open_at,
      },
      created_at,
    );
    logger.warn({ msg: 'sale.drawer.failed', sale_id: ctx.sale_id, failure_reason });
  }

  return {
    async dispatchOnFirstPrintSuccess(ctx: DrawerKickContext): Promise<void> {
      // FR-053 double-kick suppression (application layer; UNIQUE(sale_id) is
      // the schema backstop): a sale already has at most one drawer_events row.
      // Any prior row (opened | suppressed | failed) means the drawer decision
      // was already made for this sale — a reprint / retry-after-partial-open
      // must NOT write a second row or re-kick.
      //
      // NOTE (T200 hardware follow-up): this readBySale → await kick() → insert
      // is a check-then-act with an await in the middle. UNIQUE(sale_id) + the
      // caller's try/catch prevent a second ROW and a seam crash, but they do
      // NOT prevent a second PHYSICAL kick if two dispatches for the same sale
      // interleave before either INSERTs (the loser kicks, then throws on
      // INSERT, caught + swallowed). Dormant today: the STUB transport never
      // kicks, and the steady-state worker is fenced (it re-scans on
      // `NOT EXISTS sales` and the Sale commits before this fire-and-forget).
      // When the real DK transport lands (T200), serialize kick dispatch per
      // sale_id (an in-flight set) so the loser short-circuits BEFORE kick(),
      // not just before INSERT.
      if (drawerEventsRepo.readBySale(ctx.sale_id) !== null) {
        logger.info({ msg: 'drawer.kick.suppressed_existing_row', sale_id: ctx.sale_id });
        return;
      }

      const created_at = now();
      const base: BaseDrawerRow = {
        drawer_event_id: deps.newDrawerEventId(),
        sale_id: ctx.sale_id,
        triggering_print_event_id: ctx.triggering_print_event_id,
        terminal_id: ctx.terminal_id,
        attempted_at: created_at,
      };

      // Cashless first print → suppressed; no kick (FR-042).
      if (!hasCashTender(ctx.tender_lines_summary_json)) {
        recordSuppressed(ctx, base, created_at, 'cashless_tender_mix');
        return;
      }

      // Cash-inclusive first print → kick. The transport always resolves; a
      // fault becomes a `failed` row + `sale.drawer.failed` audit (Sale stays
      // durable — US1 scenario 9).
      let result: { ok: true } | { ok: false; failure_reason: DrawerEventFailureReason };
      try {
        result = await transport.kick();
      } catch {
        // Defence-in-depth: the port contract says kick() never rejects, but a
        // buggy transport must not crash the finalize seam.
        result = { ok: false, failure_reason: 'os_error' };
      }

      if (result.ok) {
        recordOpened(ctx, base, created_at);
        return;
      }
      // RT-531 (owner decision 2026-10-15, Q3 Option A): a transport that
      // answers `no_drawer_configured` means this terminal has no drawer. That
      // is not a fault to warn about: still exactly one row for the sale
      // (FR-053), recorded `suppressed`, so the projector raises no notice.
      // A configured drawer that fails (printer_dk_failure, os_error) stays
      // `failed`, with its warning.
      if (result.failure_reason === 'no_drawer_configured') {
        recordSuppressed(ctx, base, created_at, 'no_drawer_configured');
        return;
      }
      recordFailed(ctx, base, created_at, result.failure_reason);
    },
  };
}
