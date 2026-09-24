import { useState, type JSX } from 'react';
import type { CartLineItem, DiscountPlaceholderSeed } from '../../sale/useSaleCartController';
import { CartLineRow, NoteDialog, VoidControl, money } from './LiveCartParts';

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

export function LiveSaleCart(props: Props): JSX.Element {
  const [noteLineId, setNoteLineId] = useState<string | null>(null);
  const editingLine = props.lines.find((item) => item.lineId === noteLineId) ?? null;
  const editable = props.frozenSubtotalMinor === null && !props.cancelled;
  return (
    <section className="v5-sale-cart" aria-labelledby="v5-live-cart-title">
      <div className="v5-sale-cart-heading">
        <div>
          <span className="v5-sale-eyebrow">المعاملة الجارية</span>
          <h2 id="v5-live-cart-title">سلة المشتريات</h2>
        </div>
        <span className="v5-sale-count">
          {props.lines.length} أصناف · {props.itemCount} وحدات
        </span>
      </div>
      {props.canVoid && <VoidControl onVoid={props.onVoid} />}
      <div className="v5-sale-cart-table">
        <div className="v5-sale-cart-columns" aria-hidden="true">
          <span>#</span>
          <span>الصنف</span>
          <span>سعر الوحدة</span>
          <span>الكمية</span>
          <span>الإجمالي</span>
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
      <footer className="v5-sale-cart-footer">
        <CartTotals {...props} />
        <CartActions {...props} />
      </footer>
    </section>
  );
}

function CartLines(
  props: Props & { editable: boolean; onOpenNote: (line: CartLineItem) => void },
): JSX.Element {
  if (props.lines.length === 0)
    return <p className="v5-live-message">لا توجد أصناف في السلة بعد.</p>;
  return (
    <ol className="v5-sale-cart-lines" aria-label="أصناف السلة">
      {props.lines.map((line, index) => (
        <CartLineRow
          key={line.lineId}
          line={line}
          index={index}
          editable={props.editable}
          onIncrement={props.onIncrement}
          onDecrement={props.onDecrement}
          onRemove={props.onRemove}
          onOpenNote={props.onOpenNote}
        />
      ))}
    </ol>
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
      {props.handoffError && <p role="alert">{props.handoffError}</p>}
      {props.voided === true && <p role="status">تم إلغاء البيع.</p>}
      <PrimaryAction {...props} />
    </div>
  );
}

function PrimaryAction(props: Props): JSX.Element {
  if (props.paid === true)
    return (
      <>
        <p role="status">تم الدفع لهذه السلة.</p>
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
        المتابعة إلى الدفع ←
      </button>
    );
  if (props.cancelled) return <p>تم إلغاء البيع.</p>;
  return (
    <button
      type="button"
      className="v5-sale-checkout"
      disabled={!props.canHandoff || props.handingOff}
      onClick={props.onHandoff}
    >
      {props.handingOff ? 'جارٍ تسليم السلة…' : 'تسليم السلة للدفع ←'}
    </button>
  );
}
