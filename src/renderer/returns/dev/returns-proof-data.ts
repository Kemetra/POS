import type {
  ReturnJournalView,
  ReturnPayoutView,
  ReturnQuoteView,
  ReturnableLineView,
  ReturnableSaleView,
} from '../../../shared/returns/types';

/**
 * RT-660 — the sample data the G6R references draw (visual-acceptance/
 * G6-Returns/tools/gen_g6r.py), as the shapes main returns. Illustrative only.
 */
export const PROOF_SALE_NUMBER = 'TERM-01-2026-10-15-000042';

/** [name, sold, returned, unit price minor] */
type LineRow = readonly [string, number, number, number];

const LINES: readonly LineRow[] = [
  ['بنادول إكسترا 500 مجم — 24 قرص', 2, 0, 4500],
  ['أموكسيسيلين/كلافولانيت 875/125 مجم', 1, 0, 18750],
  ['فولتارين جل 1% — 50 جم', 1, 1, 6800],
  ['كونجستال أقراص', 3, 0, 2950],
];

function lineRef(i: number): string {
  return `0190a000-0000-7000-8000-00000000000${String(i + 1)}`;
}

function line([lineName, sold, returned, unit]: LineRow, i: number): ReturnableLineView {
  return {
    lineRef: lineRef(i),
    lineName,
    soldQuantity: sold,
    returnedQuantity: returned,
    returnableQuantity: sold - returned,
    unitPriceMinor: unit,
  };
}

const SALE_REF = '0190a000-0000-7000-8000-0000000000aa';

export const PROOF_SALE: ReturnableSaleView = {
  saleId: 'sale-42',
  saleNumber: PROOF_SALE_NUMBER,
  saleRef: SALE_REF,
  currencyCode: 'EGP',
  lines: LINES.map((row, i) => line(row, i)),
};

export const PROOF_QUOTE: ReturnQuoteView = {
  saleRef: SALE_REF,
  currencyCode: 'EGP',
  lines: [
    { lineRef: lineRef(0), quantity: 1, amountMinor: 4500 },
    { lineRef: lineRef(1), quantity: 1, amountMinor: 18750 },
  ],
  totalMinor: 23250,
};

/** A payout started whose kick provably never left: complete or retry (G6R Interrupted). */
export const STARTED: ReturnPayoutView = {
  startedAt: '2026-10-17T11:21:00',
  paidAt: null,
  method: null,
  kick: 'failed_before_send',
  kickCount: 1,
  kickPending: false,
};

export function paidPayout(method: 'drawer' | 'no_drawer'): ReturnPayoutView {
  return { ...STARTED, kick: 'opened', paidAt: '2026-10-17T11:22:00', method };
}

const PAID = paidPayout('drawer');

/** [sale number, local time, state, amount minor, server ref, payout] */
type JournalRow = readonly [
  string,
  string,
  ReturnJournalView['state'],
  number,
  string | null,
  ReturnPayoutView | null,
];

function journalView(
  [saleNumber, at, state, minor, ref, payout]: JournalRow,
  i: number,
): ReturnJournalView {
  return {
    returnId: `ret-${String(i)}-${saleNumber}`,
    saleId: `sale-${saleNumber}`,
    saleNumber,
    state,
    currencyCode: 'EGP',
    quotedTotalMinor: minor,
    returnTotalMinor: state === 'refused' || state === 'unknown' ? null : minor,
    returnRef: ref,
    refusalReason: state === 'refused' ? 'over_return' : null,
    createdAt: at,
    confirmedAt: ref === null ? null : at,
    lines: [],
    payout,
    attemptCount: 1,
    lastAttemptAt: at,
    lastCause: state === 'unknown' ? 'timeout' : null,
  };
}

/** Two paid-out returns: the journal below every flow state. */
export const SHORT_JOURNAL: readonly ReturnJournalView[] = (
  [
    ['TERM-01-2026-10-17-000031', '2026-10-17T10:02', 'paid_out', 9000, 'RET-000317', PAID],
    ['TERM-01-2026-10-16-000118', '2026-10-16T18:47', 'paid_out', 6800, 'RET-000309', PAID],
  ] as const satisfies readonly JournalRow[]
).map(journalView);

/** One row of each kind and action (G6R HistoryRows). */
export const FULL_JOURNAL: readonly ReturnJournalView[] = (
  [
    ['TERM-01-2026-10-17-000044', '2026-10-17T11:58', 'unknown', 2950, null, null],
    ['TERM-01-2026-10-17-000040', '2026-10-17T11:20', 'confirmed', 18750, 'RET-000318', null],
    ['TERM-01-2026-10-17-000036', '2026-10-17T10:44', 'confirmed', 4500, 'RET-000316', STARTED],
    ['TERM-01-2026-10-17-000031', '2026-10-17T10:02', 'paid_out', 9000, 'RET-000317', PAID],
    ['TERM-01-2026-10-16-000121', '2026-10-16T19:15', 'refused', 37500, null, null],
  ] as const satisfies readonly JournalRow[]
).map(journalView);

/** The return the flow's submit records, optionally with a payout already started. */
export function submittedReturn(payout: ReturnPayoutView | null = null): ReturnJournalView {
  return {
    ...journalView(
      [PROOF_SALE_NUMBER, '2026-10-17T11:20', 'confirmed', 23250, 'RET-000318', payout],
      9,
    ),
    lines: PROOF_QUOTE.lines.map(({ lineRef: ref, quantity }) => ({ lineRef: ref, quantity })),
  };
}
