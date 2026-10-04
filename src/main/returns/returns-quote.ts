/**
 * RT-15 S2 — pure returnability, quoting and request building.
 *
 * Inputs are the live `readSale` answer (D-a: the proof of online) and the
 * manager's requested lines. Outputs are either a refusal reason or an exact
 * minor-unit quote whose total the single cash refund tender must equal (AC6).
 * No I/O, no clock, no float.
 */
import { exponentFor, minorUnitsToDecimalString } from '../sales-sync/create-sale-sync-client.js';
import type {
  LocalReturnRefusal,
  ReturnLineInput,
  ReturnQuoteLineView,
  ReturnQuoteView,
  ReturnableLineView,
} from '../../shared/returns/types.js';
import {
  amount4ToMinor,
  parseAmount4,
  parseWholeQuantity,
  priceReturnLine,
} from './returns-money.js';
import type { WireSale, WireSaleLine } from './returns-wire.js';

/** The return's provenance system, as on capture. */
export const RETURN_SOURCE_SYSTEM = 'pos-pulse';

/** A sale line read as whole quantities; null fields make it not returnable. */
interface WholeLine {
  readonly sold: number;
  readonly returned: number;
  readonly returnable: number;
  readonly lineAmount4: bigint;
}

function isAllNumbers(values: readonly (number | null)[]): values is readonly number[] {
  return values.every((v) => v !== null);
}

function wholeLine(line: WireSaleLine): WholeLine | null {
  const quantities = [line.quantity, line.returnedQuantity, line.returnableQuantity].map(
    parseWholeQuantity,
  );
  const lineAmount4 = parseAmount4(line.lineAmount);
  if (lineAmount4 === null || !isAllNumbers(quantities)) return null;
  const [sold = 0, returned = 0, returnable = 0] = quantities;
  return sold > 0 ? { sold, returned, returnable, lineAmount4 } : null;
}

/** D-c: refunds are cash only, so any non-cash tender blocks the return. */
function hasNonCashTender(sale: WireSale): boolean {
  return (sale.tenders ?? []).some((t) => t.method !== 'cash');
}

/** Sale-level refusal from the live server view (AC4, D-c), or null. */
export function assessSale(sale: WireSale): LocalReturnRefusal | null {
  if (sale.voided) return 'sale_voided';
  if (hasNonCashTender(sale)) return 'card_tender_blocked';
  const anyReturnable = sale.lines.some((l) => (wholeLine(l)?.returnable ?? 0) > 0);
  return anyReturnable ? null : 'nothing_returnable';
}

/** The renderer view of every line, with whole quantities (0 when unreadable). */
export function viewLines(sale: WireSale): ReturnableLineView[] {
  const exponent = exponentFor(sale.currencyCode);
  return sale.lines.map((line) => {
    const whole = wholeLine(line);
    const unitPrice4 = parseAmount4(line.unitPrice);
    return {
      lineRef: line.lineRef,
      lineName: line.lineName,
      soldQuantity: whole?.sold ?? 0,
      returnedQuantity: whole?.returned ?? 0,
      returnableQuantity: whole?.returnable ?? 0,
      unitPriceMinor: unitPrice4 === null ? null : amount4ToMinor(unitPrice4, exponent),
    };
  });
}

export type QuoteResult =
  | { readonly kind: 'ok'; readonly quote: ReturnQuoteView }
  | { readonly kind: 'refused'; readonly reason: LocalReturnRefusal };

/** One requested line's contract price in ten-thousandths, or why it is refused. */
function quoteLine(sale: WireSale, input: ReturnLineInput): bigint | LocalReturnRefusal {
  const key = input.lineRef.toLowerCase();
  const line = sale.lines.find((l) => l.lineRef.toLowerCase() === key);
  const whole = line === undefined ? null : wholeLine(line);
  if (whole === null) return 'line_not_returnable';
  const q = input.quantity;
  if (!Number.isSafeInteger(q)) return 'quantity_out_of_range';
  if (q < 1 || q > whole.returnable) return 'quantity_out_of_range';
  // Defensive local bound on top of the server's returnableQuantity.
  if (whole.returned + q > whole.sold) return 'quantity_out_of_range';
  return priceReturnLine({ ...whole, quantity: q });
}

/**
 * Price the requested lines by the contract rule against the live sale (D-e,
 * AC5, AC6). Every per-line amount and the total must be whole minor units,
 * else `amount_not_payable` (cash cannot pay a fraction of a minor unit).
 */
export function quoteReturn(sale: WireSale, lines: readonly ReturnLineInput[]): QuoteResult {
  const exponent = exponentFor(sale.currencyCode);
  const quoted: ReturnQuoteLineView[] = [];
  let total4 = 0n;
  for (const input of lines) {
    const priced = quoteLine(sale, input);
    if (typeof priced === 'string') return { kind: 'refused', reason: priced };
    const amountMinor = amount4ToMinor(priced, exponent);
    if (amountMinor === null) return { kind: 'refused', reason: 'amount_not_payable' };
    quoted.push({ lineRef: input.lineRef, quantity: input.quantity, amountMinor });
    total4 += priced;
  }
  const totalMinor = amount4ToMinor(total4, exponent);
  if (totalMinor === null) return { kind: 'refused', reason: 'amount_not_payable' };
  return {
    kind: 'ok',
    quote: { saleRef: sale.saleRef, currencyCode: sale.currencyCode, lines: quoted, totalMinor },
  };
}

/** The `RecordReturnRequest` body the till sends (cash-only tender = the quote). */
export interface RecordReturnBody {
  sourceSystem: string;
  externalId: string;
  lines: { lineRef: string; quantity: string }[];
  refundTenders: { method: 'cash'; amount: string }[];
}

export function buildRecordReturnBody(
  externalId: string,
  quote: ReturnQuoteView,
): RecordReturnBody {
  const exponent = exponentFor(quote.currencyCode);
  return {
    sourceSystem: RETURN_SOURCE_SYSTEM,
    externalId,
    lines: quote.lines.map((l) => ({ lineRef: l.lineRef, quantity: String(l.quantity) })),
    refundTenders: [
      { method: 'cash', amount: minorUnitsToDecimalString(quote.totalMinor, exponent) },
    ],
  };
}
