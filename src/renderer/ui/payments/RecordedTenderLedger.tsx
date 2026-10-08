import type { JSX } from 'react';

import type { TenderLineRendererView, TenderType } from '../../../shared/payments/types.js';
import { formatCheckoutMoney } from './format-checkout-money.js';

/**
 * RT-243 W1-C — F1 (RT-241 packaged report 11249): the money already recorded
 * on this payment, listed in the pinned amount band beside what is still due.
 *
 * Before this the applied tender was only ever shown inside the open entry, so
 * anything that closed the entry (Esc, or a Checkout remount after a resize
 * below 1024) left «المبلغ المستحق 0.00» and a commit with no method or amount.
 *
 * Source of truth: the payment projection's applied lines, which the store keeps
 * across a remount. One row per tender METHOD, in the order the method was
 * first applied: the method and the sum of main's `amount_applied_minor` over
 * its lines (for cash, the amount received). There are three methods, so the
 * pinned band stays bounded however many split lines an attempt holds (Codex
 * P2 on #583); no scroll region, so no extra tab stop. The change is
 * main's `change_due_minor` (M-P5), never recomputed. A line still applying or
 * already reversed is not recorded money and is not listed. Nothing here claims
 * a settle or a receipt.
 */

/** The method names on the tender tiles (TenderSelection). */
const TENDER_LABEL: Record<TenderType, string> = {
  cash: 'نقدي',
  external_card_terminal: 'بطاقة',
  internal_voucher: 'قسيمة',
};

interface MethodTotal {
  readonly type: TenderType;
  readonly amountMinor: number;
  readonly firstApplyOrder: number;
}

/** Sums per method; a non-safe sum renders as the formatter's dash. */
function totalsByMethod(lines: readonly TenderLineRendererView[]): MethodTotal[] {
  const byType = new Map<TenderType, MethodTotal>();
  for (const line of lines) {
    const prior = byType.get(line.tender_type);
    byType.set(line.tender_type, {
      type: line.tender_type,
      amountMinor: (prior?.amountMinor ?? 0) + line.amount_applied_minor,
      firstApplyOrder: Math.min(prior?.firstApplyOrder ?? Infinity, line.apply_order),
    });
  }
  return [...byType.values()].sort((a, b) => a.firstApplyOrder - b.firstApplyOrder);
}

interface RecordedTenderLedgerProps {
  /** The applied lines of the current attempt. */
  lines: readonly TenderLineRendererView[];
  /** Main's change to hand back over those lines; 0 for none. */
  changeDueMinor: number;
  /** False while the cash entry is open: it already shows the same change. */
  showChange: boolean;
}

export function RecordedTenderLedger({
  lines,
  changeDueMinor,
  showChange,
}: RecordedTenderLedgerProps): JSX.Element | null {
  if (lines.length === 0) return null;
  const totals = totalsByMethod(lines);
  return (
    <div
      className="payment-ledger"
      data-testid="payment-ledger"
      role="group"
      aria-labelledby="payment-ledger-label"
    >
      <span className="payment-ledger__label" id="payment-ledger-label">
        المبالغ المسجَّلة
      </span>
      <ul className="payment-ledger__lines">
        {totals.map((total) => (
          <li key={total.type} className="payment-ledger__line" data-testid="payment-ledger-line">
            <span>{TENDER_LABEL[total.type]}</span>
            <span className="payment-ledger__amount" dir="ltr">
              {formatCheckoutMoney(total.amountMinor)}
            </span>
          </li>
        ))}
      </ul>
      {showChange && changeDueMinor > 0 && (
        <p className="payment-ledger__change" data-testid="payment-ledger-change">
          الباقي للعميل <span dir="ltr">{formatCheckoutMoney(changeDueMinor)}</span>
        </p>
      )}
    </div>
  );
}
