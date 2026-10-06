/**
 * RT-17 slice 3 part 3 — the pure shift cash-up calculator (Jira RT-17
 * comment 10919, "Expected cash"; the POS computes it and is authoritative):
 *
 *   expected = opening float
 *            + Σ net cash tenders of this terminal's sales finalized in the window
 *            − Σ completed drawer refund payouts of this terminal in the window
 *            + pay-ins − pay-outs
 *
 * Sources (read by `shift-cashup-sources.ts`):
 *   • a sale's frozen `tender_lines_summary_json` (008: the APPLIED tender
 *     lines only). Its net cash is every `cash` line's `amount_applied_minor`
 *     less its `change_due_minor` (RT-160 D-3: cash is net of change, as the
 *     sale capture sends it). Card and voucher lines are not drawer cash. A
 *     sale with no tender lines (tender-unknown, RT-10 D8) adds no cash but is
 *     still a sale of the window (`saleCount`).
 *   • a refund: the server-confirmed `return_total_minor` the RT-15 payout paid
 *     from this drawer, and its server return reference (`return_ref`), which
 *     the close reports in `cashRefundReturnRefs`.
 *
 * A source that cannot be read faithfully is refused (`ShiftCashupSourceError`)
 * rather than guessed: an unreadable tender summary, a refund amount that is
 * not a safe non-negative integer, or a refund in another currency than the
 * shift's (Backend-Core would refuse it 422 `currency_mismatch`). Totals are
 * summed in `bigint` and must come back as safe integers.
 *
 * The expected cash may come out negative (refunds above the drawer's cash);
 * the close builder refuses such a close (`invalid_amount`), and the pay-out
 * guard then refuses every pay-out. Integer minor units only, never a float.
 */

export type ShiftCashupSourceReason =
  | 'unreadable_sale_tenders'
  | 'invalid_refund'
  | 'refund_currency_mismatch'
  | 'total_out_of_range';

/** A cash-up source the POS refuses to compute from. Names the reason only (P7). */
export class ShiftCashupSourceError extends Error {
  readonly reason: ShiftCashupSourceReason;

  constructor(reason: ShiftCashupSourceReason) {
    super(`shift cash-up source refused: ${reason}`);
    this.name = 'ShiftCashupSourceError';
    this.reason = reason;
  }
}

/** A sale finalized on this terminal inside the window. */
export interface CashupSale {
  tenderLinesSummaryJson: string;
}

/** A refund paid out from this terminal's drawer inside the window. */
export interface CashupRefund {
  returnRef: string;
  amountMinor: number;
  currencyCode: string;
}

export interface CashupInput {
  /** The shift's currency. */
  currencyCode: string;
  openingFloatMinor: number;
  payInTotalMinor: number;
  payOutTotalMinor: number;
  sales: readonly CashupSale[];
  refunds: readonly CashupRefund[];
}

/** The computed cash-up of a window (the close adds the counted cash). */
export interface Cashup {
  cashSalesTotalMinor: number;
  cashRefundsTotalMinor: number;
  /** May be negative; see the module header. */
  expectedCashMinor: number;
  saleCount: number;
  cashRefundReturnRefs: string[];
}

interface TenderLine {
  tender_type?: unknown;
  amount_applied_minor?: unknown;
  change_due_minor?: unknown;
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTenderLine(value: unknown): value is TenderLine {
  return typeof value === 'object' && value !== null;
}

function unreadable(): never {
  throw new ShiftCashupSourceError('unreadable_sale_tenders');
}

function parseLines(json: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    unreadable();
  }
  return Array.isArray(parsed) ? parsed : unreadable();
}

/** The net drawer cash of one tender line (0 for a non-cash line). */
function netCashOf(line: unknown): bigint {
  if (!isTenderLine(line)) unreadable();
  if (line.tender_type !== 'cash') return 0n;
  const applied = line.amount_applied_minor;
  const change = line.change_due_minor ?? 0;
  if (!isSafeNonNegative(applied) || !isSafeNonNegative(change) || change > applied) {
    unreadable();
  }
  return BigInt(applied) - BigInt(change);
}

function saleCash(sale: CashupSale): bigint {
  return parseLines(sale.tenderLinesSummaryJson).reduce<bigint>(
    (sum, line) => sum + netCashOf(line),
    0n,
  );
}

function refundAmount(refund: CashupRefund, currencyCode: string): bigint {
  if (!isSafeNonNegative(refund.amountMinor)) {
    throw new ShiftCashupSourceError('invalid_refund');
  }
  if (refund.currencyCode !== currencyCode) {
    throw new ShiftCashupSourceError('refund_currency_mismatch');
  }
  return BigInt(refund.amountMinor);
}

/** A bigint total as a number; any total beyond ±(2^53 − 1) converts to an unsafe one. */
function safe(total: bigint): number {
  const value = Number(total);
  if (!Number.isSafeInteger(value)) {
    throw new ShiftCashupSourceError('total_out_of_range');
  }
  return value;
}

/** The cash-up of one window. Pure; see the module header. */
export function computeCashup(input: CashupInput): Cashup {
  const cashSales = input.sales.reduce<bigint>((sum, sale) => sum + saleCash(sale), 0n);
  const cashRefunds = input.refunds.reduce<bigint>(
    (sum, refund) => sum + refundAmount(refund, input.currencyCode),
    0n,
  );
  const expected =
    BigInt(input.openingFloatMinor) +
    cashSales -
    cashRefunds +
    BigInt(input.payInTotalMinor) -
    BigInt(input.payOutTotalMinor);
  return {
    cashSalesTotalMinor: safe(cashSales),
    cashRefundsTotalMinor: safe(cashRefunds),
    expectedCashMinor: safe(expected),
    saleCount: input.sales.length,
    cashRefundReturnRefs: input.refunds.map((refund) => refund.returnRef),
  };
}
