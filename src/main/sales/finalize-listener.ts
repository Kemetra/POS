/**
 * T090 + T092 — AD-2 v3 finalize listener (008 Slice 1c.2).
 *
 * Two pieces of process-lifecycle infrastructure for 008:
 *
 *   1. **Steady-state scan worker (T090).** A `setInterval` at default 200 ms
 *      (configurable 100-1000 ms floor/ceiling) that runs this canonical
 *      SELECT each tick:
 *
 *        SELECT ... FROM audit_events
 *         WHERE action_category = 'payment.settled'
 *           AND originating_terminal_id = ?
 *           AND NOT EXISTS (
 *             SELECT 1 FROM sales
 *              WHERE envelope_handoff_action_id
 *                  = json_extract(payload, '$.handoff_action_id')
 *           )
 *         ORDER BY created_at ASC
 *         LIMIT 32
 *
 *      For each returned row, dispatch AD-2 finalize. The `NOT EXISTS`
 *      clause guarantees no double-finalize across concurrent ticks.
 *      Single-flight per tick: tick N+1 doesn't start until tick N's
 *      dispatched finalizes return.
 *
 *      Per AD-2 v3 design (R1 + CR1 + LOCKED 2026-05-27):
 *        - **No `db.updateHook` call** (does not exist in better-sqlite3
 *          ^12.9.0).
 *        - **No `EventEmitter` import from 006.**
 *        - **No `CREATE TRIGGER` migration row.**
 *      Polling only.
 *
 *   2. **One-shot startup recovery sub-scans (T092).** Run once at
 *      main-process startup, NOT periodically:
 *        (1) Print recovery: scan `sales` for any sale whose `print_events`
 *            has no `outcome='success'` AND no `outcome='manual_override'`
 *            row; dispatch a fresh print attempt.
 *        (2) Drawer recovery: scan `sales` for any cash-inclusive sale
 *            (tender_lines_summary_json contains an applied `cash` line)
 *            whose `drawer_events` table has no row; dispatch a fresh
 *            drawer-kick attempt.
 *      Both scoped to the current terminal's (tenant_id, branch_id,
 *      terminal_id). Both complete in a single pass and do not re-run.
 *
 *      The audit-events recovery is NOT a separate scan — it's automatic
 *      via the first steady-state tick (per AD-2 v3 design).
 *
 * The listener is injectable: `setInterval` is replaced by a manual
 * `runTickOnce()` driver in unit tests (vitest fake-timers are not
 * required). `dispatch`, `dispatchPrintRecovery`, and
 * `dispatchDrawerRecovery` are caller-provided so the listener doesn't
 * need to import the finalize-transaction directly (that wiring happens
 * at the main entry point).
 */

import type { DatabaseHandle } from '../db/client.js';

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

// ─── Tick interval bounds (per spec) ────────────────────────────────────────

const TICK_INTERVAL_MIN_MS = 100;
const TICK_INTERVAL_MAX_MS = 1000;

// ─── Scan limit (per spec) ──────────────────────────────────────────────────

const SCAN_LIMIT_PER_TICK = 32;

// ─── The pending set (shared) ───────────────────────────────────────────────

/**
 * The `audit_events` filter of the AD-2 pending set: a `payment.settled`
 * audit of the terminal bound to the one `?` that no Sale row has finalized
 * yet. The steady-state scan below dispatches these; the RT-17 shift cash-up
 * counts them (money taken, not yet a sale) and holds the close until the
 * listener has finalized them. One definition, so both agree on "pending".
 */
export const UNFINALIZED_SETTLEMENT_FILTER = `action_category = 'payment.settled'
        AND originating_terminal_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sales
           WHERE envelope_handoff_action_id = json_extract(audit_events.payload, '$.handoff_action_id')
        )`;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface FinalizeListenerConfig {
  db: DatabaseHandle;
  /**
   * Full (tenant_id, branch_id, terminal_id) scoping triple per
   * Constitution §P17. The audit-events scan can rely on
   * `originating_terminal_id` alone (since terminal_id is globally unique
   * in production), but startup recovery sub-scans MUST filter by all
   * three columns to prevent cross-tenant leakage in a misconfigured
   * dev fixture or a multi-tenant database snapshot (per CR1 on PR #266).
   */
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  /** Steady-state worker: invoked for each pending payment.settled row. */
  dispatch: (handoff_action_id: string) => void;
  /** Startup recovery sub-scan #1 (T092). Optional in tests that don't exercise it. */
  dispatchPrintRecovery?: (sale_id: string) => void;
  /** Startup recovery sub-scan #2 (T092). Optional in tests that don't exercise it. */
  dispatchDrawerRecovery?: (sale_id: string) => void;
  /** Tick interval in ms; bounded [100, 1000], default 200. */
  tickIntervalMs: number;
  /** Injected clock; reserved for future timing assertions. */
  now: () => string;
}

export interface FinalizeListener {
  /**
   * Manually run one steady-state scan + dispatch cycle. Production uses
   * `start()` to install a setInterval driver; tests call this directly
   * for deterministic dispatch ordering.
   *
   * Single-flight: re-entrant calls during an in-progress tick short-circuit.
   */
  runTickOnce(): void;
  /**
   * One-shot startup recovery: print sub-scan + drawer sub-scan. Idempotent
   * across multiple invocations — the second call is a no-op (the recovery
   * has already fired).
   */
  runStartupRecovery(): void;
  /** Install the steady-state setInterval driver. Returns the timer handle. */
  start(): NodeJS.Timeout;
  /** Stop the steady-state driver (clearInterval). */
  stop(): void;
}

// ─── Internal row shapes ────────────────────────────────────────────────────

interface AuditEventScanRow {
  handoff_action_id: string;
}

interface SaleRecoveryRow {
  sale_id: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createFinalizeListener(config: FinalizeListenerConfig): FinalizeListener {
  if (
    config.tickIntervalMs < TICK_INTERVAL_MIN_MS ||
    config.tickIntervalMs > TICK_INTERVAL_MAX_MS
  ) {
    throw new Error(
      `finalize-listener: tickIntervalMs must be between ${String(TICK_INTERVAL_MIN_MS)} and ${String(TICK_INTERVAL_MAX_MS)} (got ${String(config.tickIntervalMs)})`,
    );
  }

  const {
    db,
    tenant_id,
    branch_id,
    terminal_id,
    dispatch,
    dispatchPrintRecovery,
    dispatchDrawerRecovery,
  } = config;

  // ─── Canonical scan SELECT (steady-state worker) ─────────────────────────

  const scanStmt = db.prepare(
    `SELECT json_extract(payload, '$.handoff_action_id') AS handoff_action_id
       FROM audit_events
      WHERE ${UNFINALIZED_SETTLEMENT_FILTER}
      ORDER BY created_at ASC
      LIMIT ${String(SCAN_LIMIT_PER_TICK)}`,
  ) as PrepareAll<AuditEventScanRow>;

  // ─── Print recovery SELECT (T092 sub-scan #1) ────────────────────────────
  //
  // Scoped by (tenant_id, branch_id, terminal_id) per Constitution §P17
  // and CR1 on PR #266. Terminal_id alone would leak across tenants in a
  // multi-tenant DB snapshot.

  const printRecoveryStmt = db.prepare(
    `SELECT sale_id FROM sales
      WHERE tenant_id = ?
        AND branch_id = ?
        AND terminal_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM print_events
           WHERE print_events.sale_id = sales.sale_id
             AND print_events.outcome IN ('success', 'manual_override')
        )`,
  ) as PrepareAll<SaleRecoveryRow>;

  // ─── Drawer recovery SELECT (T092 sub-scan #2) ───────────────────────────
  //
  // Same tenant/branch/terminal scoping as print recovery. Cash-inclusive
  // heuristic: tender_lines_summary_json contains a JSON object with
  // `"tender_type":"cash"`. SQLite's LIKE is sufficient here because the
  // JSON is produced by the finalize-transaction's JSON.stringify with a
  // stable key order; the JSON1 extension could give us a structural test
  // (`json_extract(..., '$[*].tender_type')`) but the LIKE form is
  // portable to sql.js too.

  const drawerRecoveryStmt = db.prepare(
    `SELECT sale_id FROM sales
      WHERE tenant_id = ?
        AND branch_id = ?
        AND terminal_id = ?
        AND tender_lines_summary_json LIKE '%"tender_type":"cash"%'
        AND NOT EXISTS (
          SELECT 1 FROM drawer_events
           WHERE drawer_events.sale_id = sales.sale_id
        )`,
  ) as PrepareAll<SaleRecoveryRow>;

  // ─── Single-flight state ─────────────────────────────────────────────────

  let tickInFlight = false;
  let startupRecoveryFired = false;
  let intervalHandle: NodeJS.Timeout | null = null;

  // ─── Per-sale success caches for startup recovery (CR7 on PR #266) ────────
  //
  // Without these, a successful print-recovery dispatch followed by a
  // throwing drawer-recovery dispatch would cause the next
  // runStartupRecovery() call to re-dispatch the print (because the
  // startupRecoveryFired flag stayed false, and the SQL scan still matches
  // the same row). The Sets remember per-sale work that already completed
  // so retries narrow to the failed sub-scan only.

  const completedPrintRecoverySaleIds = new Set<string>();
  const completedDrawerRecoverySaleIds = new Set<string>();

  return {
    runTickOnce(): void {
      // Single-flight guard — re-entrant calls during an in-progress tick
      // short-circuit. The real-world driver is setInterval which will
      // happily fire a second timer while the first is still running; this
      // guard makes the worker safe under that contract.
      if (tickInFlight) return;
      tickInFlight = true;
      try {
        const rows = scanStmt.all(terminal_id);
        for (const row of rows) {
          dispatch(row.handoff_action_id);
        }
      } finally {
        tickInFlight = false;
      }
    },

    runStartupRecovery(): void {
      if (startupRecoveryFired) return;
      // Per CR2 + CR7 on PR #266 — flip the fired flag AFTER both sub-scans
      // complete. On throw, leave the flag false so the next
      // runStartupRecovery() call retries. The per-sale completion caches
      // (completedPrintRecoverySaleIds / completedDrawerRecoverySaleIds)
      // ensure that already-successful dispatches are NOT replayed on
      // retry — only the failed sub-scan re-fires. The thrown error
      // propagates so the caller (main entry point) can log + decide
      // whether to retry or crash.
      if (dispatchPrintRecovery !== undefined) {
        const printRows = printRecoveryStmt.all(tenant_id, branch_id, terminal_id);
        for (const row of printRows) {
          if (completedPrintRecoverySaleIds.has(row.sale_id)) continue;
          dispatchPrintRecovery(row.sale_id);
          completedPrintRecoverySaleIds.add(row.sale_id);
        }
      }
      if (dispatchDrawerRecovery !== undefined) {
        const drawerRows = drawerRecoveryStmt.all(tenant_id, branch_id, terminal_id);
        for (const row of drawerRows) {
          if (completedDrawerRecoverySaleIds.has(row.sale_id)) continue;
          dispatchDrawerRecovery(row.sale_id);
          completedDrawerRecoverySaleIds.add(row.sale_id);
        }
      }
      startupRecoveryFired = true;
    },

    /* c8 ignore start — start/stop driver wiring is exercised by the main entry point smoke + Electron manual smoke; unit tests use runTickOnce directly */
    start(): NodeJS.Timeout {
      if (intervalHandle !== null) return intervalHandle;
      intervalHandle = setInterval(() => {
        // Per CR9 on PR #266 — catch errors at the setInterval boundary
        // so a thrown dispatch doesn't take down the main process. The
        // next tick still fires; the NOT EXISTS clause picks up the
        // same row again on the next pass (idempotent). runTickOnce()
        // itself still throws on direct invocation (preserving test
        // assertions); only the setInterval driver catches.
        try {
          this.runTickOnce();
        } catch (err) {
          console.error('[finalize-listener] tick failed; will retry on next interval', err);
        }
      }, config.tickIntervalMs);
      return intervalHandle;
    },

    stop(): void {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
    /* c8 ignore stop */
  };
}
