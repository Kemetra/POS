/**
 * RT-17 slice 3 part 3 — the cash-up calculator's sources, read from the
 * local sale and return tables of ONE terminal for ONE window
 * [from, to] (both ends included):
 *
 *   • sales: `sales` rows of the scope (tenant, branch, terminal) whose
 *     `finalized_at` is in the window, with their frozen tender summary
 *     (008; append-only, so a sale's cash never changes after the fact);
 *   • refunds: RT-15 return payouts COMPLETED (`return_payouts.paid_at`) in
 *     the window, joined to the journaled return of the scope for its
 *     server-confirmed amount (`return_total_minor`), its server reference
 *     (`return_ref`) and its currency. `drawer` and `manual` payouts both
 *     count: either way the cash left this drawer (RT-15 S4: `manual` = the
 *     operator opened the drawer by hand). A started payout that never
 *     completed has no `paid_at` and matches no window.
 *
 * Instants are compared as instants (`julianday`), never as strings.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { CashupRefund, CashupSale } from './shift-cashup-calculator.js';
import type { ShiftScope } from './shift-cashup-repo.js';

export interface CashupWindow {
  /** The shift's `openedAt`. */
  from: string;
  /** Now (a pay-out) or the close's `closedAt`. */
  to: string;
}

export interface CashupSourceQuery {
  scope: ShiftScope;
  window: CashupWindow;
}

export interface ShiftCashupSources {
  salesIn(query: CashupSourceQuery): CashupSale[];
  refundsIn(query: CashupSourceQuery): CashupRefund[];
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

const IN_WINDOW = 'BETWEEN julianday(?) AND julianday(?)';

const SALES_SQL = `
  SELECT tender_lines_summary_json AS tenderLinesSummaryJson
  FROM sales
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
    AND julianday(finalized_at) ${IN_WINDOW}
  ORDER BY finalized_at, sale_id`;

const REFUNDS_SQL = `
  SELECT j.return_ref AS returnRef, j.return_total_minor AS amountMinor,
         j.currency_code AS currencyCode
  FROM return_payouts p JOIN return_journal j ON j.return_id = p.return_id
  WHERE j.tenant_id = ? AND j.branch_id = ? AND j.terminal_id = ?
    AND julianday(p.paid_at) ${IN_WINDOW}
  ORDER BY p.paid_at, j.return_id`;

export function createShiftCashupSources(db: DatabaseHandle): ShiftCashupSources {
  function read<Row>(sql: string, query: CashupSourceQuery): Row[] {
    const { scope, window } = query;
    return (db.prepare(sql) as PrepareAll<Row>).all(
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      window.from,
      window.to,
    );
  }

  return {
    salesIn: (query) => read<CashupSale>(SALES_SQL, query),
    refundsIn: (query) => read<CashupRefund>(REFUNDS_SQL, query),
  };
}
