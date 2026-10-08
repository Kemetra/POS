import type { JSX } from 'react';

import { formatReturnMoney } from './returns-format.js';
import type { FlowState } from './return-flow-state.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 3: confirm main's quote. Every amount here is main's
 * (A3); the refund is cash only (D-c). Confirming is a button, never bare
 * Enter: the step focuses its heading, not the commit (D3).
 */
type SummaryState = Extract<FlowState, { step: 'summary' }>;

export function RefundSummary({
  flow,
  state,
}: {
  flow: ReturnFlow;
  state: SummaryState;
}): JSX.Element {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const busy = flow.busy === 'submit';
  const { quote, sale } = state;
  const nameOf = (lineRef: string): string =>
    sale.lines.find((l) => l.lineRef === lineRef)?.lineName ?? '—';

  return (
    <section className="rt-returns__panel" aria-labelledby="rt-returns-summary">
      <h2 id="rt-returns-summary" ref={heading} tabIndex={-1} className="rt-returns__heading">
        ملخص الاسترداد
      </h2>
      <p className="rt-returns__meta">
        بيع رقم <bdi className="rt-num">{state.saleNumber}</bdi>
      </p>
      <table className="rt-table">
        <thead>
          <tr>
            <th scope="col">الصنف</th>
            <th scope="col">الكمية</th>
            <th scope="col">المبلغ</th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((l) => (
            <tr key={l.lineRef}>
              <td>{nameOf(l.lineRef)}</td>
              <td>
                <bdi className="rt-num">{l.quantity}</bdi>
              </td>
              <td>
                <bdi className="rt-num">{formatReturnMoney(l.amountMinor, quote.currencyCode)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rt-total">
        <span>إجمالي الاسترداد</span>
        <bdi className="rt-num rt-total__amount">
          {formatReturnMoney(quote.totalMinor, quote.currencyCode)}
        </bdi>
      </div>
      <p className="rt-returns__meta">طريقة الاسترداد: نقدًا فقط.</p>
      <div className="rt-returns__actions">
        <button
          type="button"
          className="rt-btn rt-btn--secondary"
          onClick={flow.edit}
          disabled={busy}
        >
          تعديل الكميات
        </button>
        <button
          type="button"
          className="rt-btn rt-btn--primary rt-btn--commit"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void flow.submit()}
        >
          تأكيد الإرجاع
        </button>
      </div>
    </section>
  );
}
