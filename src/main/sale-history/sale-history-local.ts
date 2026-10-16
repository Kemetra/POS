/**
 * RT-542 — the two local reads the store-wide history needs, over existing
 * tables (no migration):
 *
 *   • `unsynced` — THIS terminal's sales in a `finalized_at` window that the
 *     server has not received yet (no `sale_sync_state` row, or one that is
 *     not `synced`), newest first. A cashier's read is limited to their own
 *     sales (the RT-546 `ownerFilter`). Other terminals' unsent sales cannot be
 *     known here (RT-534 comment 12048 §3).
 *   • `localSaleIds` — for the server `saleRef`s of a page, this terminal's own
 *     `sale_id` (joined by `sale_sync_state.server_sale_ref`, RT-15 S1), so its
 *     own receipt record is used for fidelity.
 *
 * Scope (tenant / branch / terminal) always comes from the session.
 */

import type { DatabaseHandle } from '../db/client.js';
import type { SaleListRow, TenantScope } from '../sales/repositories/sales.repository.js';

export type UnsyncedSync = 'not_started' | 'pending' | 'dead_letter';

export type UnsyncedLocalRow = SaleListRow & { readonly sync: UnsyncedSync };

export interface UnsyncedQuery {
  readonly scope: TenantScope;
  /** Only this operator's sales (a cashier), or null for the terminal scope. */
  readonly selling_operator_id: string | null;
  readonly start_inclusive: string;
  readonly end_exclusive: string;
  readonly limit: number;
}

export interface SaleHistoryLocalReads {
  unsynced(query: UnsyncedQuery): UnsyncedLocalRow[];
  localSaleIds(scope: TenantScope, refs: readonly string[]): ReadonlyMap<string, string>;
}

interface PrepareAll<T> {
  all(...params: unknown[]): T[];
}

type UnsyncedDbRow = SaleListRow & { sync_status: string | null };

const SALE_COLUMNS = `s.sale_id, s.sale_number, s.finalized_at, s.terminal_label,
       s.selling_operator_display_name, s.subtotal_minor, s.total_tax_minor`;

function syncOf(status: string | null): UnsyncedSync {
  if (status === null) return 'not_started';
  return status === 'dead_letter' ? 'dead_letter' : 'pending';
}

export function createSaleHistoryLocalReads(db: DatabaseHandle): SaleHistoryLocalReads {
  const unsyncedStmt = db.prepare(
    `SELECT ${SALE_COLUMNS}, st.sync_status
       FROM sales s
       LEFT JOIN sale_sync_state st ON st.sale_id = s.sale_id
      WHERE s.tenant_id = ? AND s.branch_id = ? AND s.terminal_id = ?
        AND (? IS NULL OR s.selling_operator_id = ?)
        AND s.finalized_at >= ? AND s.finalized_at < ?
        AND (st.sale_id IS NULL OR st.sync_status <> 'synced')
      ORDER BY s.finalized_at DESC, s.sale_id DESC
      LIMIT ?`,
  ) as PrepareAll<UnsyncedDbRow>;

  return {
    unsynced(query) {
      const { scope, selling_operator_id: operator } = query;
      const rows = unsyncedStmt.all(
        scope.tenant_id,
        scope.branch_id,
        scope.terminal_id,
        operator,
        operator,
        query.start_inclusive,
        query.end_exclusive,
        query.limit,
      );
      return rows.map(({ sync_status, ...row }) => ({ ...row, sync: syncOf(sync_status) }));
    },

    localSaleIds(scope, refs) {
      if (refs.length === 0) return new Map();
      const marks = refs.map(() => '?').join(', ');
      const stmt = db.prepare(
        `SELECT st.server_sale_ref AS ref, s.sale_id AS sale_id
           FROM sale_sync_state st
           JOIN sales s ON s.sale_id = st.sale_id
          WHERE s.tenant_id = ? AND s.branch_id = ? AND s.terminal_id = ?
            AND st.server_sale_ref IN (${marks})`,
      ) as PrepareAll<{ ref: string; sale_id: string }>;
      const rows = stmt.all(scope.tenant_id, scope.branch_id, scope.terminal_id, ...refs);
      return new Map(rows.map((r) => [r.ref, r.sale_id]));
    },
  };
}
