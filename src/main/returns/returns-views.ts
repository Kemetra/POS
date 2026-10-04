/**
 * RT-15 S2 — renderer projections of journal rows.
 *
 * A `ReturnJournalView` carries no operator ids, no `externalId` (the
 * Idempotency-Key) and no request body: those stay in the main process.
 */
import type {
  ReturnJournalView,
  ReturnPayoutKick,
  ReturnPayoutView,
} from '../../shared/returns/types.js';
import { kickStateOf } from './returns-drawer.js';
import type { PayoutRow } from './returns-payout-repository.js';
import type { JournalEntry } from './returns-repository.js';

/** A kick still `sending` (a crash mid-kick) may have opened the drawer: unknown. */
function kickOf(payout: PayoutRow): ReturnPayoutKick {
  if (payout.kickOutcome === null) return 'none';
  return payout.kickOutcome === 'sending' ? 'unknown' : payout.kickOutcome;
}

/** The payout as the renderer sees it: when and how, never who (ids stay in main). */
function toPayoutView(payout: PayoutRow | null, now: string | null): ReturnPayoutView | null {
  if (payout === null) return null;
  return {
    startedAt: payout.startedAt,
    paidAt: payout.paidAt,
    method: payout.method,
    kick: kickOf(payout),
    kickCount: payout.kickCount,
    // Codex P1 (a55ae8e): in flight = sending within the lease, as main judges it.
    kickPending: kickStateOf(payout, now) === 'in_flight',
  };
}

export function toJournalView(
  entry: JournalEntry,
  payout: PayoutRow | null = null,
  /** The app clock, for the kick lease (null: a sending kick is in flight). */
  now: string | null = null,
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
    payout: toPayoutView(payout, now),
  };
}
