import { useState, type JSX } from 'react';
import type { CartLineItem, DiscountPlaceholderSeed } from '../../sale/useSaleCartController';
import { formatHumanCount } from '../../ui/format/human-format';
import { V5Icon } from '../foundation/V5Icon';
import { CartLineRow, NoteDialog, VoidControl, money } from './LiveCartParts';
import { useRemovalFocus } from './useRemovalFocus';
import { moveRowFocus, useNewestRowInView } from './useCartRowFocus';

interface Props {
  lines: readonly CartLineItem[];
  discounts: readonly DiscountPlaceholderSeed[];
  subtotalMinor: number;
  itemCount: number;
  frozenSubtotalMinor: number | null;
  canHandoff: boolean;
  handingOff: boolean;
  cancelled: boolean;
  canVoid: boolean;
  canContinue: boolean;
  /** The frozen cart's payment is known settled: a completed sale, never re-offered to payment. */
  paid?: boolean;
  /** The previous sale was just voided; acknowledged until the next line lands. */
  voided?: boolean;
  handoffError: string | null;
  /** RT-242: the line the last confirmed add landed on; scrolled into view and flashed. */
  lastAddedLineId?: string | null;
  /** Changes on every add, so a +1 on the same line flashes again. */
  lastAddNonce?: number;
  onIncrement: (line: CartLineItem) => void;
  onDecrement: (line: CartLineItem) => void;
  onRemove: (line: CartLineItem) => void;
  onSaveNote: (line: CartLineItem, note: string | null) => Promise<boolean>;
  onRemoveDiscount: (placeholderId: string) => void;
  onHandoff: () => void;
  onContinue: () => void;
  onVoid: () => Promise<boolean>;
  onNewSale?: () => void;
}

/**
 * RT-242 (VNext W1-B, Direction B): the cart takes the workspace and the money
 * column sits on the inline end — totals, the one primary action and, apart
 * from it, the void. Two sibling regions so the workspace grid can give the
 * money column the full height: the total and the commit are never scrolled
 * away, however long the cart.
 */
export function LiveSaleCart(props: Props): JSX.Element {
  return (
    <>
      <CartRegion {...props} />
      <MoneyColumn {...props} />
    </>
  );
}

function CartRegion(props: Props): JSX.Element {
  const [noteLineId, setNoteLineId] = useState<string | null>(null);
  const editingLine = props.lines.find((item) => item.lineId === noteLineId) ?? null;
  const editable = props.frozenSubtotalMinor === null && !props.cancelled;
  return (
    <section className="v5-sale-cart" aria-labelledby="v5-live-cart-title">
      <div className="v5-sale-cart-heading">
        <h2 id="v5-live-cart-title">سلة المشتريات</h2>
        <CartStateLabel {...props} />
        <span className="v5-sale-count">
          {`الأصناف: ${formatHumanCount(props.lines.length)} · الوحدات: ${formatHumanCount(props.itemCount)}`}
        </span>
      </div>
      {/* Focusable so a frozen cart, which has no line controls, still scrolls by keyboard; ↓ enters the rows. */}
      <div
        className="v5-sale-cart-table"
        role="region"
        aria-label="بنود السلة"
        tabIndex={0}
        onKeyDown={moveRowFocus}
      >
        <div className="v5-sale-cart-columns" aria-hidden="true">
          <span>#</span>
          <span>الصنف</span>
          <span>الكمية</span>
          <span>سعر الوحدة</span>
          <span>الإجمالي</span>
          <span />
        </div>
        <CartLines
          {...props}
          editable={editable}
          onOpenNote={(line) => {
            setNoteLineId(line.lineId);
          }}
        />
        {props.discounts.map((discount) => (
          <div key={discount.placeholderId} className="v5-live-discount">
            <span>خصم قيد المعالجة</span>
            <button
              type="button"
              onClick={() => {
                props.onRemoveDiscount(discount.placeholderId);
              }}
            >
              إزالة الخصم
            </button>
          </div>
        ))}
      </div>
      {editingLine !== null && (
        <NoteDialog
          key={editingLine.lineId}
          line={editingLine}
          onSave={props.onSaveNote}
          onClose={() => {
            setNoteLineId(null);
          }}
        />
      )}
    </section>
  );
}

/** The inline-end money column: totals and the commit at the foot, the void apart below them. */
function MoneyColumn(props: Props): JSX.Element {
  return (
    // A labelled region, not <aside>: a complementary landmark may not nest inside <main>.
    <section className="v5-sale-money" aria-labelledby="v5-live-money-title">
      <h2 id="v5-live-money-title" className="v5-sale-money-title">
        ملخص العملية
      </h2>
      <dl className="v5-sale-money-counts">
        <div>
          <dt>الأصناف</dt>
          <dd dir="ltr">{formatHumanCount(props.lines.length)}</dd>
        </div>
        <div>
          <dt>الوحدات</dt>
          <dd dir="ltr">{formatHumanCount(props.itemCount)}</dd>
        </div>
      </dl>
      <div className="v5-sale-money-commit">
        <CartTotals {...props} />
        <CartActions {...props} />
      </div>
      {props.canVoid && (
        <div className="v5-sale-money-secondary">
          <VoidControl onVoid={props.onVoid} />
        </div>
      )}
    </section>
  );
}

function CartLines(
  props: Props & { editable: boolean; onOpenNote: (line: CartLineItem) => void },
): JSX.Element {
  const planRemoval = useRemovalFocus(props.lines);
  const flashing = useNewestRowInView(props.lastAddedLineId ?? null, props.lastAddNonce ?? 0);
  if (props.lines.length === 0)
    return <p className="v5-live-message">لا توجد أصناف في السلة بعد.</p>;
  return (
    <ol className="v5-sale-cart-lines" aria-label="أصناف السلة">
      {props.lines.map((line, index) => (
        <CartLineRow
          key={line.lineId}
          line={line}
          index={index}
          lastAdded={line.lineId === props.lastAddedLineId}
          flashing={flashing && line.lineId === props.lastAddedLineId}
          editable={props.editable}
          onIncrement={props.onIncrement}
          onDecrement={props.onDecrement}
          onRemove={props.onRemove}
          onOpenNote={props.onOpenNote}
          onPlanRemoval={planRemoval}
        />
      ))}
    </ol>
  );
}

type StateTone = 'info' | 'success' | 'neutral';

/**
 * Where the transaction stands, derived only from props the cart already
 * receives. Editing needs no label: the editable lines say it. Not a live
 * region: the actions area announces the change itself.
 */
function cartState(props: Props): { label: string; tone: StateTone } | null {
  if (props.paid === true) return { label: 'مدفوعة', tone: 'success' };
  if (props.cancelled) return { label: 'ملغاة', tone: 'neutral' };
  if (props.frozenSubtotalMinor !== null) return { label: 'مُسلّمة للدفع', tone: 'info' };
  return null;
}

function CartStateLabel(props: Props): JSX.Element | null {
  const state = cartState(props);
  if (state === null) return null;
  return (
    <span className="v5-live-cart-state" data-tone={state.tone}>
      {state.label}
    </span>
  );
}

function CartTotals(props: Props): JSX.Element {
  const frozen = props.frozenSubtotalMinor !== null;
  // Before any line exists the total is a placeholder, never a fabricated 0.00.
  const shown =
    props.lines.length === 0 && !frozen
      ? '—'
      : money(props.frozenSubtotalMinor ?? props.subtotalMinor);
  return (
    <div className="v5-sale-totals" aria-label="ملخص المبالغ">
      <div className="v5-sale-total-row">
        <span>المجموع الفرعي</span>
        <span dir="ltr">{shown}</span>
      </div>
      <div className="v5-sale-total-row v5-sale-tax-row">
        <span>الضريبة</span>
        <span>قيد الإضافة · لا تُحسب هنا</span>
      </div>
      <div className="v5-sale-grand-total">
        <span>الإجمالي الحالي</span>
        <strong dir="ltr">{shown}</strong>
      </div>
    </div>
  );
}

function CartActions(props: Props): JSX.Element {
  return (
    <div className="v5-sale-actions">
      {props.handoffError && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          {props.handoffError}
        </p>
      )}
      {props.voided === true && (
        <p role="status" className="v5-live-notice">
          تم إلغاء البيع.
        </p>
      )}
      <PrimaryAction {...props} />
    </div>
  );
}

function PrimaryAction(props: Props): JSX.Element {
  if (props.paid === true)
    return (
      <>
        <p role="status" className="v5-live-notice v5-live-notice--success">
          تم الدفع لهذه السلة.
        </p>
        <button type="button" className="v5-sale-checkout" onClick={props.onNewSale}>
          بيع جديد
        </button>
      </>
    );
  if (props.frozenSubtotalMinor !== null)
    return (
      <button
        type="button"
        className="v5-sale-checkout"
        disabled={!props.canContinue}
        onClick={props.onContinue}
      >
        <span>المتابعة إلى الدفع</span>
        <V5Icon name="forward" size={24} />
      </button>
    );
  if (props.cancelled) return <p className="v5-live-notice">تم إلغاء البيع.</p>;
  return (
    <button
      type="button"
      className="v5-sale-checkout"
      disabled={!props.canHandoff || props.handingOff}
      onClick={props.onHandoff}
    >
      <span>{props.handingOff ? 'جارٍ تسليم السلة…' : 'تسليم السلة للدفع'}</span>
      {!props.handingOff && <V5Icon name="forward" size={24} />}
    </button>
  );
}
