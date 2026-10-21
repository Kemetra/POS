import type { JSX } from 'react';

import { RefundTotal, ReturnsPanel, SaleNumberMeta } from './ReturnsPanel';
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
}: Readonly<{
  flow: ReturnFlow;
  state: SummaryState;
}>): JSX.Element {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const busy = flow.busy === 'submit';
  const { quote, sale } = state;
  const nameOf = (lineRef: string): string =>
    sale.lines.find((l) => l.lineRef === lineRef)?.lineName ?? '—';

  return (
    <ReturnsPanel id="v5-returns-summary" title="ملخص الاسترداد" headingRef={heading}>
      <div className="v5-manager-panel__body">
        <SaleNumberMeta saleNumber={state.saleNumber} />
        <table className="v5-returns-table v5-returns-table--quote">
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
                  <bdi className="v5-manager-num">{l.quantity}</bdi>
                </td>
                <td>
                  <bdi className="v5-manager-num">
                    {formatReturnMoney(l.amountMinor, quote.currencyCode)}
                  </bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <RefundTotal
          label="إجمالي الاسترداد"
          amount={formatReturnMoney(quote.totalMinor, quote.currencyCode)}
        />
        <p className="v5-returns-meta">طريقة الاسترداد: نقدًا فقط.</p>
        <div className="v5-returns-actions">
          <button
            type="button"
            className="v5-manager-btn v5-btn"
            onClick={flow.edit}
            disabled={busy}
          >
            تعديل الكميات
          </button>
          <button
            type="button"
            className="v5-manager-btn v5-manager-btn--primary v5-btn v5-btn--primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void flow.submit()}
          >
            تأكيد الإرجاع
          </button>
        </div>
      </div>
    </ReturnsPanel>
  );
}
