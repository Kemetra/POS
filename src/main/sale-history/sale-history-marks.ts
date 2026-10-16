/**
 * RT-542 (OD-534-8) — the marks a reprint must carry, never weaker than the
 * record. The printed marks are the union of:
 *   • what Backend-Core's detail says (a void summary or `voided`, any recorded
 *     return or a `returnState` other than `none`, its eligibility marks);
 *   • this terminal's own void journal (a live void — pending, unknown or
 *     confirmed — the server may not know yet);
 *   • what the authorization returned.
 * An authorization that drops a mark the detail implies is not printed.
 */

import type { SaleHistoryDetail, SaleHistoryReprintMark } from '../../shared/sale-history/types.js';

const ORDER: readonly SaleHistoryReprintMark[] = ['voided', 'returned'];

/** The marks Backend-Core's own detail implies. */
export function detailMarks(detail: SaleHistoryDetail): ReadonlySet<SaleHistoryReprintMark> {
  const marks = new Set<SaleHistoryReprintMark>(detail.reprint.marks);
  if (detail.summary.voided || detail.void !== null) marks.add('voided');
  if (detail.summary.return_state !== 'none' || detail.returns.length > 0) marks.add('returned');
  return marks;
}

/** True when the authorization carries every mark the detail implies. */
export function coversMarks(
  authorized: readonly SaleHistoryReprintMark[],
  required: ReadonlySet<SaleHistoryReprintMark>,
): boolean {
  return [...required].every((mark) => authorized.includes(mark));
}

/** The marks to print, in a stable order. */
export function printedMarks(
  authorized: readonly SaleHistoryReprintMark[],
  localVoid: boolean,
): SaleHistoryReprintMark[] {
  return ORDER.filter((mark) => authorized.includes(mark) || (mark === 'voided' && localVoid));
}
