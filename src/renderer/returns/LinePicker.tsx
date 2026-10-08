import type { JSX } from 'react';

import type { ReturnableLineView } from '../../shared/returns/types.js';
import { ReturnNotice } from './ReturnNotice';
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
    <div className="rt-stepper">
      <button
        type="button"
        className="rt-btn rt-btn--secondary rt-stepper__btn"
        aria-label={`إنقاص ${line.lineName}`}
        disabled={locked || quantity <= 0}
        onClick={() => {
          onPick(quantity - 1);
        }}
      >
        −
      </button>
      <output
        className="rt-stepper__value rt-num"
        aria-label={`كمية ${line.lineName}`}
        data-testid={`qty-${line.lineRef}`}
      >
        {quantity}
      </output>
      <button
        type="button"
        className="rt-btn rt-btn--secondary rt-stepper__btn"
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
    <li className="rt-line" data-returnable={line.returnableQuantity > 0}>
      <div className="rt-line__text">
        <span className="rt-line__name">{line.lineName}</span>
        <span className="rt-line__meta">
          مباع <bdi className="rt-num">{line.soldQuantity}</bdi> · مُرجع سابقًا{' '}
          <bdi className="rt-num">{line.returnedQuantity}</bdi> · سعر الوحدة{' '}
          <bdi className="rt-num">{unit}</bdi>
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
        <span className="rt-line__done">أُرجع بالكامل</span>
      )}
    </li>
  );
}

export function LinePicker({ flow, state }: { flow: ReturnFlow; state: SelectState }): JSX.Element {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const busy = flow.busy === 'quote';
  const nothingPicked = pickedLines(state.sale, state.picked).length === 0;

  return (
    <section className="rt-returns__panel" aria-labelledby="rt-returns-select">
      <h2 id="rt-returns-select" ref={heading} tabIndex={-1} className="rt-returns__heading">
        اختر الأصناف المرتجعة
      </h2>
      <p className="rt-returns__meta">
        بيع رقم <bdi className="rt-num">{state.saleNumber}</bdi>
      </p>
      <ul className="rt-lines">
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
      <div className="rt-returns__actions">
        <button
          type="button"
          className="rt-btn rt-btn--ghost"
          disabled={busy}
          onClick={flow.startOver}
        >
          بحث عن بيع آخر
        </button>
        <button
          type="button"
          className="rt-btn rt-btn--primary"
          disabled={nothingPicked || busy}
          aria-busy={busy}
          onClick={() => void flow.getQuote()}
        >
          احسب مبلغ الاسترداد
        </button>
      </div>
    </section>
  );
}
