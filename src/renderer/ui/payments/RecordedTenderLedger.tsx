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
 * across a remount. One row per applied line, in apply order: the method and
 * main's `amount_applied_minor` (for cash, the amount received). The change is
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
  const ordered = [...lines].sort((a, b) => a.apply_order - b.apply_order);
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
        {ordered.map((line) => (
          <li
            key={line.tender_line_id}
            className="payment-ledger__line"
            data-testid="payment-ledger-line"
          >
            <span>{TENDER_LABEL[line.tender_type]}</span>
            <span className="payment-ledger__amount" dir="ltr">
              {formatCheckoutMoney(line.amount_applied_minor)}
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
