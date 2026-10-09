import { computeChangeDueMinor } from '../../../shared/payments/money-math';

/**
 * RT-243 W1-C — what the cash typed so far would mean, for the pinned ledger
 * (freeze 15 S8/S9; RT-255 item 1: the change must never sit below the fold).
 *
 * A preview of the amount in the field against what is still owed, BEFORE it is
 * applied. Once applied, the ledger shows main's `change_due_minor` instead and
 * this preview is not asked for (re-deriving it against a zero due would show
 * the amount received as change, the RT-237 defect).
 *
 *   received ≥ due → the change (`computeChangeDueMinor`), or nothing when exact
 *   received < due → how much it is short (M-P4)
 *
 * Integer minor units only; anything not a positive safe integer is no preview.
 */
export type CashDraft =
  | { readonly kind: 'change'; readonly changeMinor: number }
  | { readonly kind: 'shortfall'; readonly shortMinor: number };

export function cashDraft(receivedMinor: number | null, dueMinor: number): CashDraft | null {
  if (receivedMinor === null || !Number.isSafeInteger(receivedMinor) || receivedMinor <= 0) {
    return null;
  }
  if (!Number.isSafeInteger(dueMinor) || dueMinor <= 0) return null;
  if (receivedMinor < dueMinor) {
    return { kind: 'shortfall', shortMinor: dueMinor - receivedMinor };
  }
  const changeMinor = computeChangeDueMinor(receivedMinor, dueMinor);
  return changeMinor > 0 ? { kind: 'change', changeMinor } : null;
}
