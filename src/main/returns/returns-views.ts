/**
 * RT-15 S2 — renderer projections of journal rows.
 *
 * A `ReturnJournalView` carries no operator ids, no `externalId` (the
 * Idempotency-Key) and no request body: those stay in the main process.
 */
import type { ReturnJournalView } from '../../shared/returns/types.js';
import type { JournalEntry } from './returns-repository.js';

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
