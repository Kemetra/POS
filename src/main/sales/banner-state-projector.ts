/**
 * Banner-state projector (008 follow-up slice — sales.subscribe banner_state).
 *
 * Computes the current terminal's `BannerState` for the renderer's persistent
 * banner. Snapshot-style (mirrors 005/006 `subscribe ≡ read`): the renderer
 * polls this on an interval; no push channel.
 *
 * PER-SALE rule (coordination §S3c projection rule — load-bearing against
 * silent failure, PRODUCT.md Principle 3): a sale is in `printer_failure` iff
 * ITS OWN latest print event is `outcome='failure'`. A newer sale's success
 * must NOT clear an older sale's unresolved failure. The terminal surfaces the
 * most-recently-finalized sale whose own latest print event is a failure.
 *
 * `print_events` is sale-scoped (no `terminal_id`), so the printer query JOINs
 * to `sales` on the session (tenant, branch, terminal) triple. `drawer_events`
 * carries its own `terminal_id`, which the drawer clear-path uses directly.
 * Drawer-failure projection is computed INDEPENDENTLY of printer-failure so the
 * Slice-4 `<DrawerFailureBanner>` can coexist on screen with
 * `<PrinterFailureBanner>` (Slice 4 decision, Ahmed 2026-05-29; T330 / T361 /
 * NFR-008). The result is a record `{ printer_failure; drawer_failure }`, NOT a
 * single-kind union — a union could only report one banner, silently hiding a
 * concurrent failure of the other class.
 *
 * Drawer CLEAR-PATH (Ahmed 2026-05-30, hardware-recovery): a failed drawer row
 * cannot be superseded on its own sale (UNIQUE(sale_id) + no retry-kick,
 * FR-053), so the drawer banner clears when a LATER `opened` drawer event on the
 * same terminal proves the hardware recovered. See the drawer SELECT below.
 *
 * Correlated `NOT EXISTS` "latest event per sale" form (no window functions —
 * portable to the sql.js test adapter, mirroring the finalize-listener scan).
 */

import type { DatabaseHandle } from '../db/client.js';
import type { BannerState, RecentSaleSummary } from '../../shared/sales/types.js';

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

export interface BannerStateScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  /**
   * RT-546 (OD-534-1) — when set, only this operator's sales are projected (a
   * cashier's own sales). Absent or null: every sale in the terminal scope.
   */
  selling_operator_id?: string | null;
}

export interface BannerStateProjector {
  projectBannerState(scope: BannerStateScope): BannerState;
  /** The terminal's most-recently-finalized sale summary, or null (topic='recent'). */
  projectRecentSale(scope: BannerStateScope): RecentSaleSummary | null;
}

interface PrinterFailureRow {
  sale_id: string;
  failure_reason: string;
  has_successful_print: number;
}

interface DrawerFailureRow {
  sale_id: string;
  last_successful_open_at: string | null;
}

interface RecentSaleRow {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
}

export function bindBannerStateProjector(db: DatabaseHandle): BannerStateProjector {
  // Most-recently-finalized sale (for this terminal) whose OWN latest print
  // event is a failure. "Latest for its sale" = no other print_events row for
  // the same sale_id with a strictly greater printed_at.
  const printerFailureStmt = db.prepare(
    `SELECT pe.sale_id AS sale_id,
            pe.failure_reason AS failure_reason,
            EXISTS (
              SELECT 1 FROM print_events pe2
               WHERE pe2.sale_id = pe.sale_id AND pe2.outcome = 'success'
            ) AS has_successful_print
       FROM print_events pe
       JOIN sales s ON s.sale_id = pe.sale_id
      WHERE pe.outcome = 'failure'
        AND s.tenant_id = ? AND s.branch_id = ? AND s.terminal_id = ?
        AND (? IS NULL OR s.selling_operator_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM print_events later
           WHERE later.sale_id = pe.sale_id
             AND later.printed_at > pe.printed_at
        )
      ORDER BY s.finalized_at DESC, pe.printed_at DESC
      LIMIT 1`,
  ) as PrepareGet<PrinterFailureRow>;

  // A sale whose drawer event outcome is 'failed', UNLESS the drawer has since
  // RECOVERED. drawer_events has UNIQUE(sale_id) + is append-only with NO
  // retry-kick (FR-053), so a failed row can never be superseded on its OWN
  // sale — unlike the printer banner, which clears via a later same-sale
  // success. The drawer banner is a HARDWARE-state signal (it surfaces the
  // terminal's "last opened" time): it therefore clears when a LATER successful
  // `opened` drawer event on the SAME TERMINAL proves the drawer recovered
  // (Slice 4 clear-path decision, Ahmed 2026-05-30 — "hardware-recovery").
  // "Later" = strictly greater `attempted_at` (with a drawer_event_id tie-break
  // for same-instant determinism). The cashier's manual-override affordance
  // remains the immediate action; a Slice-6 per-sale manual_override clear can
  // compose on top of this clause later.
  //
  // RT-531 (the cash drawer is optional): a `failed` row whose reason is
  // `no_drawer_configured` is never a notice. Before RT-531 the stub wrote that
  // row for EVERY cash sale on a terminal with no drawer; the table is
  // append-only and a drawerless terminal never produces the later `opened`
  // that clears it, so without this filter an upgraded terminal would show the
  // notice for ever. New code records that case `suppressed`, which the
  // `outcome = 'failed'` filter already skips. A configured drawer that fails
  // (printer_dk_failure, os_error) still surfaces.
  const drawerFailureStmt = db.prepare(
    `SELECT de.sale_id AS sale_id,
            de.last_successful_open_at_for_terminal AS last_successful_open_at
       FROM drawer_events de
       JOIN sales s ON s.sale_id = de.sale_id
      WHERE de.outcome = 'failed'
        AND de.failure_reason IS NOT 'no_drawer_configured'
        AND s.tenant_id = ? AND s.branch_id = ? AND s.terminal_id = ?
        AND (? IS NULL OR s.selling_operator_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM drawer_events rec
           WHERE rec.terminal_id = de.terminal_id
             AND rec.outcome = 'opened'
             AND (
               rec.attempted_at > de.attempted_at
               OR (rec.attempted_at = de.attempted_at AND rec.drawer_event_id > de.drawer_event_id)
             )
        )
      ORDER BY s.finalized_at DESC
      LIMIT 1`,
  ) as PrepareGet<DrawerFailureRow>;

  // Most-recently-finalized sale for the terminal (topic='recent').
  const recentSaleStmt = db.prepare(
    `SELECT sale_id, sale_number, finalized_at
       FROM sales
      WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
        AND (? IS NULL OR selling_operator_id = ?)
      ORDER BY finalized_at DESC
      LIMIT 1`,
  ) as PrepareGet<RecentSaleRow>;

  // Bind parameters for one scoped statement: the terminal triple, then the
  // optional owner filter twice (`? IS NULL OR selling_operator_id = ?`).
  const params = (scope: BannerStateScope): unknown[] => {
    const owner = scope.selling_operator_id ?? null;
    return [scope.tenant_id, scope.branch_id, scope.terminal_id, owner, owner];
  };

  return {
    projectRecentSale(scope: BannerStateScope): RecentSaleSummary | null {
      const row = recentSaleStmt.get(...params(scope));
      if (row === undefined) return null;
      return {
        sale_id: row.sale_id,
        sale_number: row.sale_number,
        finalized_at: row.finalized_at,
      };
    },

    projectBannerState(scope: BannerStateScope): BannerState {
      // Each failure class is projected independently — no early return — so a
      // printer failure cannot silently hide a concurrent drawer failure
      // (coexistence; Slice 4 decision).
      const printerRow = printerFailureStmt.get(...params(scope));
      const drawerRow = drawerFailureStmt.get(...params(scope));

      return {
        printer_failure:
          printerRow === undefined
            ? null
            : {
                sale_id: printerRow.sale_id,
                failure_reason: printerRow.failure_reason,
                has_successful_print: printerRow.has_successful_print === 1,
              },
        drawer_failure:
          drawerRow === undefined
            ? null
            : {
                sale_id: drawerRow.sale_id,
                last_successful_open_at: drawerRow.last_successful_open_at,
              },
      };
    },
  };
}
