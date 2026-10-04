/**
 * RT-15 S2 — renderer projections of journal rows, and the local tender read.
 *
 * A `ReturnJournalView` carries no operator ids, no `externalId` (the
 * Idempotency-Key) and no request body: those stay in the main process.
 */
import type { ReturnJournalView } from '../../shared/returns/types.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import type { JournalEntry } from './returns-repository.js';
import { parseJsonBody } from './returns-wire.js';

export function toJournalView(entry: JournalEntry): ReturnJournalView {
  return {
    returnId: entry.returnId,
    saleId: entry.saleId,
    saleNumber: entry.saleNumber,
    state: entry.state,
    currencyCode: entry.currencyCode,
    quotedTotalMinor: entry.quotedTotalMinor,
    returnTotalMinor: entry.returnTotalMinor,
    returnRef: entry.returnRef,
    refusalReason: entry.refusalReason,
    createdAt: entry.createdAt,
    confirmedAt: entry.confirmedAt,
    lines: entry.lines.map((l) => ({ lineRef: l.lineRef, quantity: l.quantity })),
  };
}

/**
 * D-c on the till's own record: true when the sale's frozen tender summary
 * (`sales.tender_lines_summary_json`) has any non-cash line — a card on the
 * external terminal, a voucher, anything else. An unreadable summary counts as
 * non-cash (fail closed). This guards sales whose capture did not carry
 * `tenders` (RT-79 cutoff), where the server view has none to check.
 */
export function hasNonCashLocalTender(sale: Pick<SaleRow, 'tender_lines_summary_json'>): boolean {
  const parsed = parseJsonBody(sale.tender_lines_summary_json);
  if (!Array.isArray(parsed)) return true;
  return parsed.some((line) => (line as { tender_type?: unknown } | null)?.tender_type !== 'cash');
}
