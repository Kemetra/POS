import type { JSX } from 'react';

import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope.js';

/**
 * 006-payments-tender S1 — PaymentCartSummary.
 *
 * Read-only summary of the PaymentIntentEnvelope lines shown to the cashier
 * during tender selection. Renders only:
 *   - display_name (safe, non-identifying)
 *   - quantity
 *   - line_subtotal_minor (formatted)
 *   - subtotal_minor (formatted envelope total)
 *
 * SECURITY: no sensitive IDs (cart_id, operator_session_id, tenant_id,
 * branch_id, terminal_id, handoff_action_id, item_ref, last_action_id)
 * are rendered in the DOM (FR-035). No edit affordances.
 */

function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    return '—';
  }
  const whole = Math.floor(minor / 100);
  const frac = Math.abs(minor % 100)
    .toString()
    .padStart(2, '0');
  return `¤${whole.toString()}.${frac}`;
}

export interface PaymentCartSummaryProps {
  envelope: Readonly<PaymentIntentEnvelope>;
}

export function PaymentCartSummary({ envelope }: PaymentCartSummaryProps): JSX.Element {
  return (
    <section
      className="payment-cart-summary"
      data-testid="payment-cart-summary"
      aria-label="ملخص الطلب"
    >
      <h2 className="payment-cart-summary__heading">ملخص الطلب</h2>

      <ol className="payment-cart-summary__lines" aria-label="أصناف السلة">
        {envelope.lines.map((line, idx) => (
          <li key={line.line_id} className="payment-cart-summary__line">
            <span className="payment-cart-summary__line-name">{line.display_name}</span>
            <span className="payment-cart-summary__line-qty" aria-label="الكمية">
              ×{line.quantity}
            </span>
            <span
              className="payment-cart-summary__line-subtotal"
              data-testid={`payment-summary-line-subtotal-${idx.toString()}`}
            >
              {formatMinorUnits(line.line_subtotal_minor)}
            </span>
          </li>
        ))}
      </ol>

      <div className="payment-cart-summary__footer">
        <span className="payment-cart-summary__subtotal-label">الإجمالي الفرعي</span>
        <span
          className="payment-cart-summary__subtotal-value"
          data-testid="payment-summary-subtotal"
        >
          {formatMinorUnits(envelope.subtotal_minor)}
        </span>
      </div>
    </section>
  );
}
