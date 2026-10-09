import { useId, useState, type FocusEvent, type JSX, type KeyboardEvent } from 'react';

import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { formatHumanCount, formatHumanMoney } from '../../ui/format/human-format';
import { V5Icon } from '../foundation/V5Icon';

/**
 * RT-243 W1-C (freeze 15 §4, 06 `OrderSummary`; DESIGN.md Frame — Direction B)
 * — the frozen sale being paid, read-only. Replaces `PaymentCartSummary`.
 *
 * Comfortable (1280): a ≈280px column at the inline start listing every line.
 * Compact (a 1024 window): one strip across the top (counts, subtotal and
 * «عرض الأصناف»); the list opens over the tender panel on demand, so the money
 * column never gives up height to it. The switch is a container query in
 * `checkout.css`, not a React viewport branch (the tier hook lags CSS by 100ms).
 *
 * The disclosure is a plain button with `aria-expanded`; it is hidden (and so
 * out of the tab order) at comfortable density, where the list is always shown.
 * Esc inside the open list closes it and is consumed, so it never also means
 * Back (RT-26 layer order: the innermost layer closes first).
 *
 * Renders only display names, quantities and amounts; no identifiers (FR-035).
 * No tax line: VAT is deferred (008), so there is nothing true to show.
 */

export interface OrderSummaryProps {
  envelope: Readonly<PaymentIntentEnvelope>;
}

/** Sum of quantities; a non-safe sum renders as the formatter's dash. */
function unitCount(envelope: Readonly<PaymentIntentEnvelope>): number {
  return envelope.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function OrderSummary({ envelope }: OrderSummaryProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();

  function closeOnEscape(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || !open) return;
    // Consumed here: the Checkout Esc handler skips a handled press.
    event.preventDefault();
    setOpen(false);
  }

  function closeWhenFocusLeaves(event: FocusEvent<HTMLElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
  }

  return (
    <section
      className="v5-order-summary"
      data-testid="payment-cart-summary"
      data-open={open ? 'true' : 'false'}
      aria-labelledby={`${listId}-title`}
      onKeyDown={closeOnEscape}
      onBlur={closeWhenFocusLeaves}
    >
      <div className="v5-order-summary__head">
        <h2 className="v5-checkout-heading" id={`${listId}-title`}>
          ملخص الطلب
        </h2>
        <span className="v5-order-summary__frozen">
          <V5Icon name="lock" size={16} />
          مجمّدة
        </span>
        <p className="v5-order-summary__counts">
          الأصناف <bdi dir="ltr">{formatHumanCount(envelope.lines.length)}</bdi> · القطع{' '}
          <bdi dir="ltr">{formatHumanCount(unitCount(envelope))}</bdi>
        </p>
        <button
          type="button"
          className="v5-order-summary__toggle"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls={listId}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          عرض الأصناف
        </button>
      </div>

      {/* A long cart scrolls inside the list; tabIndex lets a keyboard reach it
          (axe scrollable-region-focusable). Collapsed at 1024, it is display:none. */}
      <ol className="v5-order-summary__lines" id={listId} aria-label="أصناف السلة" tabIndex={0}>
        {envelope.lines.map((line, idx) => (
          <li key={line.line_id} className="v5-order-summary__line">
            <span className="v5-order-summary__name">{line.display_name}</span>
            <span className="v5-order-summary__qty" aria-label="الكمية">
              <bdi dir="ltr">{`×${formatHumanCount(line.quantity)}`}</bdi>
            </span>
            <span
              className="v5-order-summary__amount"
              dir="ltr"
              data-testid={`payment-summary-line-subtotal-${idx.toString()}`}
            >
              {formatHumanMoney(line.line_subtotal_minor)}
            </span>
          </li>
        ))}
      </ol>

      <div className="v5-order-summary__total">
        <span>الإجمالي الفرعي</span>
        <span className="v5-order-summary__amount" dir="ltr" data-testid="payment-summary-subtotal">
          {formatHumanMoney(envelope.subtotal_minor)}
        </span>
      </div>
    </section>
  );
}
