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

/** The DOM node of the end (primary) slot, once mounted. */
export const PrimarySlotContext = createContext<HTMLElement | null>(null);

/**
 * Render `children` in the pinned primary slot when `pinned` and a slot exists;
 * otherwise render them in place. Entries rendered on their own (unit tests, no
 * bar) therefore keep working unchanged.
 */
export function PinnedPrimary(props: { pinned: boolean; children: ReactNode }): JSX.Element {
  const slot = useContext(PrimarySlotContext);
  if (props.pinned && slot !== null) return createPortal(props.children, slot);
  return <>{props.children}</>;
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
      <div className="checkout-actions__row">
        <div className="checkout-actions__slot checkout-actions__slot--start" data-slot="start">
          {props.cancel}
        </div>
        <div
          ref={props.endSlotRef}
          className="checkout-actions__slot checkout-actions__slot--end"
          data-slot="end"
        >
          {props.commit}
          {props.reason}
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
export function FocusWhen(props: { active: boolean; find: () => HTMLElement | null }): null {
  const findRef = useRef(props.find);
  findRef.current = props.find;
  const { active } = props;
  useEffect(() => {
    if (active) findRef.current()?.focus();
  }, [active]);
  return null;
}
