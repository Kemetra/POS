import { useRef, useState, type JSX, type MouseEvent } from 'react';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { format, of } from '../../../shared/money';
import { V5Icon } from '../foundation/V5Icon';
import { SaleDialog } from './SaleDialog';
import { focusScanOwner } from './scan-anchor';
import type { RemovalControl } from './useRemovalFocus';

// Legacy LineNotePopover parity: same length cap, unchanged-save and empty-clear guards.
const NOTE_MAX_LENGTH = 200;

export function money(minor: number): string {
  return format(of(minor, 'EGP'));
}

interface LineProps {
  line: CartLineItem;
  index: number;
  editable: boolean;
  onIncrement: (line: CartLineItem) => void;
  onDecrement: (line: CartLineItem) => void;
  onRemove: (line: CartLineItem) => void;
  onOpenNote: (line: CartLineItem) => void;
  /** Keyboard removal: tell the cart where focus should land once the row is gone. */
  onPlanRemoval: (line: CartLineItem, control: RemovalControl) => void;
}

/**
 * RT-239 rule 6. A pointer click on a row control returns focus to the scan
 * owner (a pointer user needs no row focus). Keyboard activation keeps row
 * context: `+` and `−` stay on the same button, and a removal (`حذف`, or `−` on a
 * one-unit line) hands focus to the neighbouring row.
 */
function settleRowFocus(event: MouseEvent<HTMLButtonElement>, keyboardPlan?: () => void): void {
  if (event.detail > 0) focusScanOwner();
  else keyboardPlan?.();
}

export function CartLineRow(props: LineProps): JSX.Element {
  const { line } = props;
  return (
    <li className="v5-sale-cart-line" data-line-id={line.lineId}>
      <span className="v5-sale-line-index" dir="ltr">
        {props.index + 1}
      </span>
      <div className="v5-sale-line-product">
        <strong>{line.displayName}</strong>
        {line.note && <span className="v5-sale-line-meta">ملاحظة: {line.note}</span>}
        {props.editable && (
          <div className="v5-live-line-actions">
            <button
              type="button"
              onClick={() => {
                props.onOpenNote(line);
              }}
            >
              ملاحظة
            </button>
            <button
              type="button"
              data-row-action="remove"
              onClick={(event) => {
                settleRowFocus(event, () => {
                  props.onPlanRemoval(line, 'remove');
                });
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
      <QuantityControl {...props} />
      <strong className="v5-sale-line-total" dir="ltr">
        {money(line.lineSubtotalMinor)}
      </strong>
    </li>
  );
}

function QuantityControl(props: LineProps): JSX.Element {
  const { line } = props;
  // Legacy stepper parity: at one, a note-less line is removed; a noted line decrements.
  function decrement(event: MouseEvent<HTMLButtonElement>): void {
    if (line.quantity <= 1 && line.note === null) {
      settleRowFocus(event, () => {
        props.onPlanRemoval(line, 'decrement');
      });
      props.onRemove(line);
    } else {
      settleRowFocus(event);
      props.onDecrement(line);
    }
  }
  return (
    <div className="v5-sale-quantity" aria-label={`الكمية ${String(line.quantity)}`}>
      {props.editable && (
        <button
          type="button"
          data-row-action="decrement"
          aria-label={`إنقاص كمية ${line.displayName}`}
          onClick={decrement}
        >
          <V5Icon name="minus" />
        </button>
      )}
      <strong dir="ltr">{line.quantity}</strong>
      {props.editable && (
        <button
          type="button"
          data-row-action="increment"
          aria-label={`زيادة كمية ${line.displayName}`}
          onClick={(event) => {
            settleRowFocus(event);
            props.onIncrement(line);
          }}
        >
          <V5Icon name="plus" />
        </button>
      )}
    </div>
  );
}

/** Void entry point + its confirmation; a refused void keeps the dialog open (legacy parity). */
export function VoidControl({ onVoid }: { onVoid: () => Promise<boolean> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        className="v5-live-void"
        onClick={() => {
          setOpen(true);
        }}
      >
        إلغاء البيع
      </button>
      {open && (
        <SaleDialog label="تأكيد إلغاء البيع" onDismiss={close} initialFocusRef={backRef}>
          <h3 className="v5-live-dialog-title">إلغاء البيع؟</h3>
          <p>سيتم إلغاء السلة الحالية.</p>
          <div>
            <button ref={backRef} type="button" className="v5-live-btn" onClick={close}>
              العودة
            </button>
            <button
              type="button"
              className="v5-live-btn v5-live-btn--danger"
              onClick={() => {
                void onVoid().then((ok) => {
                  if (ok) close();
                });
              }}
            >
              تأكيد الإلغاء
            </button>
          </div>
        </SaleDialog>
      )}
    </>
  );
}

export function NoteDialog(props: {
  line: CartLineItem;
  onClose: () => void;
  onSave: (line: CartLineItem, note: string | null) => Promise<boolean>;
}): JSX.Element {
  const { line } = props;
  const [text, setText] = useState(line.note ?? '');
  const [failed, setFailed] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  function save(note: string | null): void {
    void props.onSave(line, note).then((ok) => {
      if (ok) props.onClose();
      else setFailed(true);
    });
  }
  return (
    <SaleDialog label="ملاحظة الصنف" onDismiss={props.onClose} initialFocusRef={fieldRef}>
      <label htmlFor="v5-live-note" className="v5-live-dialog-title">
        ملاحظة الصنف
      </label>
      <textarea
        ref={fieldRef}
        id="v5-live-note"
        data-scan-target="note"
        maxLength={NOTE_MAX_LENGTH}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {failed && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          تعذّر حفظ الملاحظة.
        </p>
      )}
      <div>
        <button type="button" className="v5-live-btn" onClick={props.onClose}>
          إلغاء
        </button>
        <button
          type="button"
          className="v5-live-btn"
          disabled={line.note === null}
          onClick={() => {
            save(null);
          }}
        >
          مسح الملاحظة
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={text.trim() === (line.note ?? '')}
          onClick={() => {
            save(text.trim() || null);
          }}
        >
          حفظ
        </button>
      </div>
    </SaleDialog>
  );
}
