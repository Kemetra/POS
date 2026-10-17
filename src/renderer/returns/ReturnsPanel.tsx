import type { JSX, ReactNode, Ref } from 'react';

import { V5Icon, type V5IconName } from '../v5/foundation/V5Icon';

/**
 * RT-660 — one Returns step or the journal as a shared v5 manager panel (G6R):
 * a heading row, then the step's body. A step whose heading takes focus on
 * mount passes its ref; the heading then joins the focus order only by script.
 */
export interface ReturnsPanelProps {
  readonly id: string;
  readonly title: string;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  /** Beside the heading (the journal's «تحقّق من غير المؤكدة»). */
  readonly bar?: ReactNode;
  /** The journal fills the rest of the height (RD-3). */
  readonly journal?: boolean;
  readonly children: ReactNode;
}

export function ReturnsPanel({
  id,
  title,
  headingRef,
  bar,
  journal = false,
  children,
}: ReturnsPanelProps): JSX.Element {
  return (
    <section
      className={journal ? 'v5-manager-panel v5-returns-journal' : 'v5-manager-panel'}
      aria-labelledby={id}
    >
      <div className="v5-manager-panel__head">
        <h2 id={id} ref={headingRef} tabIndex={headingRef === undefined ? undefined : -1}>
          {title}
        </h2>
        {bar}
      </div>
      {children}
    </section>
  );
}

/** «بيع رقم ‹the sale number›»: the number is an isolated LTR code. */
export function SaleNumberMeta({ saleNumber }: { readonly saleNumber: string }): JSX.Element {
  return (
    <p className="v5-returns-meta">
      بيع رقم <bdi className="v5-manager-num v5-returns-code">{saleNumber}</bdi>
    </p>
  );
}

/** A state pill: its word and its own glyph, so it never rests on colour alone (RD-5). */
export function StatePill({
  state,
  icon,
  children,
}: {
  readonly state: string;
  readonly icon: V5IconName;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span className="v5-returns-state" data-state={state}>
      <V5Icon name={icon} size={16} />
      {children}
    </span>
  );
}

/** The refund total: the largest figure on the step (G6R .total). */
export function RefundTotal({
  label,
  amount,
}: {
  readonly label: string;
  readonly amount: string;
}): JSX.Element {
  return (
    <div className="v5-returns-total">
      <span>{label}</span>
      <bdi className="v5-manager-num v5-returns-total__amount">{amount}</bdi>
    </div>
  );
}
