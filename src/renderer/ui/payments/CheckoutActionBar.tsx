import { createContext, useContext, useEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * RT-238 (VNext A3) — the Checkout action bar and its two fixed slots.
 *
 * Freeze package 15 §4 A2 `ActionSlots`: inline-end holds the primary/commit,
 * inline-start holds cancel. A slot that is empty in one state stays empty; it is
 * never reused by an action of the opposite consequence in the next state (the
 * N-02 slip: «تأكيد الدفع» used to take the exact place «إلغاء» held a moment
 * earlier, and a click aimed at Cancel settled a payment).
 *
 * The bar sits OUTSIDE the scrolling panes, so the commit can never scroll out
 * of view. The entry components (cash, card, voucher) own their apply handlers,
 * so they render their apply-commit INTO the end slot through `PinnedPrimary`;
 * React events and state stay with the entry, only the DOM node lives here.
 */

/**
 * The end (primary) slot and who owns it. `PaymentSurface` is the single place
 * that decides ownership: an open entry owns the slot while money is still owed;
 * otherwise the settle commit does.
 */
export interface PrimarySlot {
  /** The end-slot DOM node, once mounted. Null outside a Checkout action bar. */
  readonly node: HTMLElement | null;
  readonly entryOwnsPrimary: boolean;
}

export const PrimarySlotContext = createContext<PrimarySlot>({
  node: null,
  entryOwnsPrimary: false,
});

/**
 * An entry's apply-commit. Inside the Checkout bar it is portaled into the end
 * slot while the entry owns it, and NOT rendered once nothing is owed (it could
 * only be a dead, disabled second commit beside «تأكيد الدفع»). Rendered on its
 * own (no bar: unit tests, Slice-2 mode) it stays in place, unchanged.
 */
export function PinnedPrimary(props: { children: ReactNode }): JSX.Element | null {
  const { node, entryOwnsPrimary } = useContext(PrimarySlotContext);
  if (node === null) return <>{props.children}</>;
  return entryOwnsPrimary ? createPortal(props.children, node) : null;
}

interface CheckoutActionBarProps {
  /** Inline-start slot: cancel. Empty, but present, when there is no cancel. */
  cancel: ReactNode;
  /** Inline-end slot: the settle commit, when it is the primary action. */
  commit: ReactNode;
  /** Why the commit cannot proceed, shown under it. Absent when it can. */
  reason: ReactNode;
  /** Refusals and hints that must stay in view next to the commit. */
  notices: ReactNode;
  /** Receives the end-slot node so entries can portal their commit into it. */
  endSlotRef: (node: HTMLElement | null) => void;
}

export function CheckoutActionBar(props: CheckoutActionBarProps): JSX.Element {
  return (
    <div className="checkout-actions" data-testid="payment-surface-actions">
      {props.notices}
      {/* RT-243 W1-C: in the money column the slots stack, commit above cancel
          (as «الدفع» above the void on the Sale), so the end slot comes first in
          DOM and Tab order matches what the cashier sees. */}
      <div className="checkout-actions__row">
        <div
          ref={props.endSlotRef}
          className="checkout-actions__slot checkout-actions__slot--end"
          data-slot="end"
        >
          {props.commit}
          {props.reason}
        </div>
        <div className="checkout-actions__slot checkout-actions__slot--start" data-slot="start">
          {props.cancel}
        </div>
      </div>
    </div>
  );
}

/**
 * Move focus to `find()` when `active` turns true. The primary action changes
 * under the cashier's hands (apply → settle, or back to the method tiles), and
 * the control that held focus is gone; without this focus would fall to <body>
 * and a keyboard-only cashier would lose their place.
 */
export function FocusWhen(props: {
  active: boolean;
  find: () => HTMLElement | null;
  /** Called after focus was moved, e.g. to arm a guard against a held key. */
  onFocused?: () => void;
}): null {
  const findRef = useRef(props.find);
  findRef.current = props.find;
  const onFocusedRef = useRef(props.onFocused);
  onFocusedRef.current = props.onFocused;
  const { active } = props;
  useEffect(() => {
    if (!active) return;
    const target = findRef.current();
    if (target === null) return;
    target.focus();
    onFocusedRef.current?.();
  }, [active]);
  return null;
}
