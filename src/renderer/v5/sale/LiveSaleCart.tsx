import { useRef, useState, type JSX } from 'react';
import type { CartLineItem, DiscountPlaceholderSeed } from '../../sale/useSaleCartController';
import { format, of } from '../../../shared/money';
import { SaleDialog } from './SaleDialog';

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
  handoffError: string | null;
  onIncrement: (line: CartLineItem) => void;
  onDecrement: (line: CartLineItem) => void;
  onRemove: (line: CartLineItem) => void;
  onSaveNote: (line: CartLineItem, note: string | null) => Promise<boolean>;
  onRemoveDiscount: (placeholderId: string) => void;
  onHandoff: () => void;
  onContinue: () => void;
  onVoid: () => Promise<boolean>;
}

// Legacy LineNotePopover parity: same length cap, unchanged-save and empty-clear guards.
const NOTE_MAX_LENGTH = 200;

function money(minor: number): string {
  return format(of(minor, 'EGP'));
}

export function LiveSaleCart(props: Props): JSX.Element {
  const [noteLine, setNoteLine] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState(false);
  const [voidConfirm, setVoidConfirm] = useState(false);
  const voidBackRef = useRef<HTMLButtonElement>(null);
  const noteFieldRef = useRef<HTMLTextAreaElement>(null);
  const editingLine = props.lines.find((item) => item.lineId === noteLine) ?? null;
  const frozen = props.frozenSubtotalMinor !== null;
  function saveNote(line: CartLineItem, note: string | null): void {
    void props.onSaveNote(line, note).then((ok) => {
      if (ok) setNoteLine(null);
      else setNoteError(true);
    });
  }
  const shownTotal = props.frozenSubtotalMinor ?? props.subtotalMinor;
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
      {props.canVoid && (
        <div className="v5-live-toolbar">
          <button
            type="button"
            className="v5-live-void"
            onClick={() => {
              setVoidConfirm(true);
            }}
          >
            إلغاء البيع
          </button>
        </div>
      )}
      {voidConfirm && (
        <SaleDialog
          label="تأكيد إلغاء البيع"
          onDismiss={() => {
            setVoidConfirm(false);
          }}
          initialFocusRef={voidBackRef}
        >
          <h3 className="v5-live-dialog-title">إلغاء البيع؟</h3>
          <p>سيتم إلغاء السلة الحالية.</p>
          <div>
            <button
              ref={voidBackRef}
              type="button"
              className="v5-live-btn"
              onClick={() => {
                setVoidConfirm(false);
              }}
            >
              العودة
            </button>
            <button
              type="button"
              className="v5-live-btn v5-live-btn--danger"
              onClick={() => {
                void props.onVoid().then((ok) => {
                  if (ok) setVoidConfirm(false);
                });
              }}
            >
              تأكيد الإلغاء
            </button>
          </div>
        </SaleDialog>
      )}
      <div className="v5-sale-cart-table">
        <div className="v5-sale-cart-columns" aria-hidden="true">
          <span>#</span>
          <span>الصنف</span>
          <span>سعر الوحدة</span>
          <span>الكمية</span>
          <span>الإجمالي</span>
        </div>
        {props.lines.length === 0 ? (
          <p className="v5-live-message">لا توجد أصناف في السلة بعد.</p>
        ) : (
          <ol className="v5-sale-cart-lines" aria-label="أصناف السلة">
            {props.lines.map((line, index) => (
              <li key={line.lineId} className="v5-sale-cart-line">
                <span className="v5-sale-line-index" dir="ltr">
                  {index + 1}
                </span>
                <div className="v5-sale-line-product">
                  <strong>{line.displayName}</strong>
                  {line.note && <span className="v5-sale-line-meta">ملاحظة: {line.note}</span>}
                  {!frozen && !props.cancelled && (
                    <div className="v5-live-line-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setNoteLine(line.lineId);
                          setNoteText(line.note ?? '');
                          setNoteError(false);
                        }}
                      >
                        ملاحظة
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          props.onRemove(line);
                        }}
                      >
                        حذف
                      </button>
                    </div>
                  )}
                </div>
                <span className="v5-sale-line-unit" dir="ltr">
                  {money(line.unitPriceMinor)}
                </span>
                <div className="v5-sale-quantity" aria-label={`الكمية ${String(line.quantity)}`}>
                  {!frozen && !props.cancelled && (
                    <button
                      type="button"
                      aria-label={`إنقاص كمية ${line.displayName}`}
                      onClick={() => {
                        if (line.quantity <= 1 && line.note === null) props.onRemove(line);
                        else props.onDecrement(line);
                      }}
                    >
                      −
                    </button>
                  )}
                  <strong dir="ltr">{line.quantity}</strong>
                  {!frozen && !props.cancelled && (
                    <button
                      type="button"
                      aria-label={`زيادة كمية ${line.displayName}`}
                      onClick={() => {
                        props.onIncrement(line);
                      }}
                    >
                      ＋
                    </button>
                  )}
                </div>
                <strong className="v5-sale-line-total" dir="ltr">
                  {money(line.lineSubtotalMinor)}
                </strong>
              </li>
            ))}
          </ol>
        )}
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
        <SaleDialog
          label="ملاحظة الصنف"
          onDismiss={() => {
            setNoteLine(null);
          }}
          initialFocusRef={noteFieldRef}
        >
          <label htmlFor="v5-live-note" className="v5-live-dialog-title">
            ملاحظة الصنف
          </label>
          <textarea
            ref={noteFieldRef}
            id="v5-live-note"
            maxLength={NOTE_MAX_LENGTH}
            value={noteText}
            onChange={(event) => {
              setNoteText(event.target.value);
            }}
          />
          {noteError && <p role="alert">تعذّر حفظ الملاحظة.</p>}
          <div>
            <button
              type="button"
              className="v5-live-btn"
              onClick={() => {
                setNoteLine(null);
              }}
            >
              إلغاء
            </button>
            <button
              type="button"
              className="v5-live-btn"
              disabled={editingLine.note === null}
              onClick={() => {
                saveNote(editingLine, null);
              }}
            >
              مسح الملاحظة
            </button>
            <button
              type="button"
              className="v5-live-btn v5-live-btn--primary"
              disabled={noteText.trim() === (editingLine.note ?? '')}
              onClick={() => {
                saveNote(editingLine, noteText.trim() || null);
              }}
            >
              حفظ
            </button>
          </div>
        </SaleDialog>
      )}
      <footer className="v5-sale-cart-footer">
        <div className="v5-sale-totals" aria-label="ملخص المبالغ">
          <div className="v5-sale-total-row">
            <span>المجموع الفرعي</span>
            <span dir="ltr">{props.lines.length === 0 && !frozen ? '—' : money(shownTotal)}</span>
          </div>
          <div className="v5-sale-total-row v5-sale-tax-row">
            <span>الضريبة</span>
            <span>قيد الإضافة · لا تُحسب هنا</span>
          </div>
          <div className="v5-sale-grand-total">
            <span>الإجمالي الحالي</span>
            <strong dir="ltr">
              {props.lines.length === 0 && !frozen ? '—' : money(shownTotal)}
            </strong>
          </div>
        </div>
        <div className="v5-sale-actions">
          {props.handoffError && <p role="alert">{props.handoffError}</p>}
          {frozen ? (
            <button
              type="button"
              className="v5-sale-checkout"
              disabled={!props.canContinue}
              onClick={props.onContinue}
            >
              المتابعة إلى الدفع ←
            </button>
          ) : props.cancelled ? (
            <p>تم إلغاء البيع.</p>
          ) : (
            <button
              type="button"
              className="v5-sale-checkout"
              disabled={!props.canHandoff || props.handingOff}
              onClick={props.onHandoff}
            >
              {props.handingOff ? 'جارٍ تسليم السلة…' : 'تسليم السلة للدفع ←'}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
