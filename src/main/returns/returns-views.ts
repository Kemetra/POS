/**
 * RT-15 S2 — renderer projections of journal rows.
 *
 * A `ReturnJournalView` carries no operator ids, no `externalId` (the
 * Idempotency-Key) and no request body: those stay in the main process.
 */
import type { ReturnJournalView, ReturnPayoutView } from '../../shared/returns/types.js';
import type { PayoutRow } from './returns-payout-repository.js';
import type { JournalEntry } from './returns-repository.js';

/** The payout as the renderer sees it: when and how, never who (ids stay in main). */
function toPayoutView(payout: PayoutRow | null): ReturnPayoutView | null {
  if (payout === null) return null;
  return { startedAt: payout.startedAt, paidAt: payout.paidAt, method: payout.method };
}

export function toJournalView(
  entry: JournalEntry,
  payout: PayoutRow | null = null,
): ReturnJournalView {
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
    payout: toPayoutView(payout),
  };
}
