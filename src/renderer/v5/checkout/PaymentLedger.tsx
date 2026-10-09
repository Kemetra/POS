import type { JSX, ReactNode } from 'react';

import type { TenderLineRendererView, TenderType } from '../../../shared/payments/types';
import { formatHumanMoney } from '../../ui/format/human-format';
import { Notice } from '../foundation/Notice';
import type { CashDraft } from './cash-draft';

/**
 * RT-243 W1-C (freeze 15 §4 `PaymentLedger`; DESIGN.md Direction B) — the
 * Checkout money column. It sits in the same place and width as the Sale's money
 * column, so the Sale total becomes the amount due and «الدفع» becomes the
 * commit without anything moving.
 *
 *   ┌ amount due (hero) ┐  pinned
 *   │ recorded money     │  scrolls if it must
 *   │ change to hand back│
 *   ├ actions (slots)    ┤  pinned
 *   └────────────────────┘
 *
 * The amount due and the actions are separate grid rows outside the scrolling
 * middle, so neither can be scrolled away (08 I-3) and nothing sticky ever sits
 * over a focused control.
 *
 * Recorded money (RT-243 F1, RT-241 packaged report 11249): the payment
 * projection's applied lines, one row per tender method in the order it was
 * first applied, with the sum of main's `amount_applied_minor` (for cash, the
 * amount received). Three methods bound the list however many split lines an
 * attempt holds. A line still applying or reversed is not recorded money and is
 * not listed. The change is main's `change_due_minor` (M-P5), never recomputed.
 * Nothing here claims a settle, a print or a sync.
 *
 * Cash draft (RT-243 W1-C; RT-255 item 1): while cash is typed and not yet
 * applied, what it would mean sits under the amount due — the change to hand
 * back, or how much it is short (M-P4). It is a preview of the field, kept apart
 * from the recorded money, and it is never asked for once the due is covered
 * (the recorded change is main's from then on).
 *
 * Presentational: amounts in, no store, no bridge. Test hooks the caller owns
 * arrive through `testIds`, so the V5 tree stays free of legacy names.
 */

/** The method names on the tender tiles (`TenderPicker`). */
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

export interface PaymentLedgerTestIds {
  readonly dueLabel?: string;
  readonly due?: string;
}

export interface PaymentLedgerProps {
  /** What is still owed, integer minor units. */
  readonly dueMinor: number;
  /** The applied lines of the current attempt. */
  readonly lines: readonly TenderLineRendererView[];
  /** Main's change to hand back over those lines; 0 for none. */
  readonly changeDueMinor: number;
  /** The cash typed but not yet applied, against the amount due; null for none. */
  readonly draft?: CashDraft | null;
  /** The pinned action region (the Checkout action bar). */
  readonly actions?: ReactNode;
  readonly testIds?: PaymentLedgerTestIds;
}

function DraftPreview(props: { draft: CashDraft }): JSX.Element {
  const { draft } = props;
  return (
    <div className="v5-ledger-draft" data-testid="payment-ledger-draft">
      {draft.kind === 'change' ? (
        <p
          className="v5-ledger-row v5-ledger-row--change"
          data-testid="payment-ledger-draft-change"
        >
          الباقي للعميل{' '}
          <bdi className="v5-ledger-row__amount" dir="ltr">
            {formatHumanMoney(draft.changeMinor)}
          </bdi>
        </p>
      ) : (
        <Notice tone="warning" testId="payment-ledger-draft-shortfall">
          المبلغ المستلم أقل من المستحق بـ <bdi dir="ltr">{formatHumanMoney(draft.shortMinor)}</bdi>
          .
        </Notice>
      )}
    </div>
  );
}

function RecordedMoney(props: {
  lines: readonly TenderLineRendererView[];
  changeDueMinor: number;
}): JSX.Element | null {
  if (props.lines.length === 0) return null;
  return (
    <div
      className="v5-ledger-recorded"
      data-testid="payment-ledger"
      role="group"
      aria-labelledby="v5-ledger-recorded-label"
    >
      <span className="v5-ledger-recorded__label" id="v5-ledger-recorded-label">
        المبالغ المسجَّلة
      </span>
      <ul className="v5-ledger-recorded__lines">
        {totalsByMethod(props.lines).map((total) => (
          <li key={total.type} className="v5-ledger-row" data-testid="payment-ledger-line">
            <span>{TENDER_LABEL[total.type]}</span>
            <span className="v5-ledger-row__amount" dir="ltr">
              {formatHumanMoney(total.amountMinor)}
            </span>
          </li>
        ))}
      </ul>
      {props.changeDueMinor > 0 && (
        <p className="v5-ledger-row v5-ledger-row--change" data-testid="payment-ledger-change">
          الباقي للعميل{' '}
          <span className="v5-ledger-row__amount" dir="ltr">
            {formatHumanMoney(props.changeDueMinor)}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * `1,250.00 EGP` → the figure and its currency as two runs, so the currency can
 * sit one step smaller and the figure keeps its size in a 296–320px column. The
 * text stays `1,250.00 EGP` (one LTR run, isolated); the formatter is unchanged.
 */
function HeroAmount(props: { minor: number; testId?: string | undefined }): JSX.Element {
  const text = formatHumanMoney(props.minor);
  const split = text.lastIndexOf(' ');
  return (
    <span className="v5-ledger__due-value" data-testid={props.testId} dir="ltr">
      {split > 0 ? (
        <>
          {text.slice(0, split)}{' '}
          <span className="v5-ledger__due-currency">{text.slice(split + 1)}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

export function PaymentLedger({
  dueMinor,
  lines,
  changeDueMinor,
  draft = null,
  actions,
  testIds = {},
}: PaymentLedgerProps): JSX.Element {
  return (
    <section className="v5-ledger" aria-label="المبلغ المستحق">
      <div className="v5-ledger__due">
        <span className="v5-ledger__due-label" data-testid={testIds.dueLabel}>
          المبلغ المستحق
        </span>
        <HeroAmount minor={dueMinor} testId={testIds.due} />
      </div>
      <div className="v5-ledger__middle">
        {draft !== null && <DraftPreview draft={draft} />}
        <RecordedMoney lines={lines} changeDueMinor={changeDueMinor} />
      </div>
      {actions !== undefined && <div className="v5-ledger__actions">{actions}</div>}
    </section>
  );
}
