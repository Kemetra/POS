import type { JSX } from 'react';

import type { ReturnableLineView } from '../../shared/returns/types.js';
import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel, SaleNumberMeta, StatePill } from './ReturnsPanel';
import { formatReturnMoney } from './returns-format.js';
import { pickedLines, type FlowState } from './return-flow-state.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 2: pick whole quantities, 0..returnable, from the live sale
 * main read (D-e, A4). The bound is a convenience; main enforces it.
 */
type SelectState = Extract<FlowState, { step: 'select' }>;

interface StepperProps {
  readonly line: ReturnableLineView;
  readonly quantity: number;
  /** True while main prices the picked lines: they must not change under it. */
  readonly locked: boolean;
  readonly onPick: (quantity: number) => void;
}

function Stepper({ line, quantity, locked, onPick }: StepperProps): JSX.Element {
  return (
    <div className="v5-returns-stepper">
      <button
        type="button"
        className="v5-returns-step"
        aria-label={`إنقاص ${line.lineName}`}
        disabled={locked || quantity <= 0}
        onClick={() => {
          onPick(quantity - 1);
        }}
      >
        −
      </button>
      <output
        className="v5-returns-qty v5-manager-num"
        aria-label={`كمية ${line.lineName}`}
        data-testid={`qty-${line.lineRef}`}
      >
        {quantity}
      </output>
      <button
        type="button"
        className="v5-returns-step"
        aria-label={`زيادة ${line.lineName}`}
        disabled={locked || quantity >= line.returnableQuantity}
        onClick={() => {
          onPick(quantity + 1);
        }}
      >
        +
      </button>
    </div>
  );
}

interface LineRowProps {
  readonly line: ReturnableLineView;
  readonly currencyCode: string;
  readonly quantity: number;
  readonly locked: boolean;
  readonly onPick: (lineRef: string, quantity: number) => void;
}

function LineRow({ line, currencyCode, quantity, locked, onPick }: LineRowProps): JSX.Element {
  const unit =
    line.unitPriceMinor === null ? '—' : formatReturnMoney(line.unitPriceMinor, currencyCode);
  return (
    <li className="v5-returns-line" data-returnable={line.returnableQuantity > 0}>
      <div className="v5-returns-line__text">
        <span className="v5-returns-line__name">{line.lineName}</span>
        <span className="v5-returns-line__meta">
          مباع <bdi className="v5-manager-num">{line.soldQuantity}</bdi> · مُرجع سابقًا{' '}
          <bdi className="v5-manager-num">{line.returnedQuantity}</bdi> · سعر الوحدة{' '}
          <bdi className="v5-manager-num">{unit}</bdi>
        </span>
      </div>
      {line.returnableQuantity > 0 ? (
        <Stepper
          line={line}
          quantity={quantity}
          locked={locked}
          onPick={(q) => {
            onPick(line.lineRef, q);
          }}
        />
      ) : (
        <StatePill state="done" icon="status.success">
          أُرجع بالكامل
        </StatePill>
      )}
    </li>
  );
}

export function LinePicker({
  flow,
  state,
}: Readonly<{ flow: ReturnFlow; state: SelectState }>): JSX.Element {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const busy = flow.busy === 'quote';
  const nothingPicked = pickedLines(state.sale, state.picked).length === 0;

  return (
    <ReturnsPanel id="v5-returns-select" title="اختر الأصناف المرتجعة" headingRef={heading}>
      <div className="v5-manager-panel__body">
        <SaleNumberMeta saleNumber={state.saleNumber} />
        <ul className="v5-returns-lines">
          {state.sale.lines.map((line) => (
            <LineRow
              key={line.lineRef}
              line={line}
              currencyCode={state.sale.currencyCode}
              quantity={state.picked[line.lineRef] ?? 0}
              locked={busy}
              onPick={flow.pick}
            />
          ))}
        </ul>
        <ReturnNotice notice={state.notice} />
        <div className="v5-returns-actions">
          <button
            type="button"
            className="v5-manager-btn v5-manager-btn--ghost v5-btn v5-btn--quiet"
            disabled={busy}
            onClick={flow.startOver}
          >
            بحث عن بيع آخر
          </button>
          <button
            type="button"
            className="v5-manager-btn v5-manager-btn--primary v5-btn v5-btn--primary"
            disabled={nothingPicked || busy}
            aria-busy={busy}
            onClick={() => void flow.getQuote()}
          >
            احسب مبلغ الاسترداد
          </button>
        </div>
      </div>
    </ReturnsPanel>
  );
}
