import { create } from 'zustand';

import {
  CHECKOUT_RETURN_TRANSITION,
  CartState,
  isValidTransition,
} from '../../shared/cart/cart-state.js';

interface ActiveCart {
  readonly cart_id: string;
  readonly state: CartState;
  /** Last confirmed line_id from a bridge add/merge response. */
  readonly lastLineId: string | null;
}

export interface CartStore {
  activeCart: ActiveCart | null;

  /** Bridge confirmed cart.create → { kind: 'ok', cart_id }. Sets state = empty. */
  applyCartCreated(cart_id: string): void;

  /** Bridge confirmed cart.lines.add → { kind: 'ok' }. Transitions empty → editing. */
  applyLineAdded(line_id: string): void;

  /** Bridge confirmed cart.discountPlaceholders.add requires_manager_attribution=true. */
  applyDiscountAttributionRequired(): void;

  /** Manager attribution resolved; transitions discount_pending_attribution → editing. */
  applyDiscountAttributionResolved(): void;

  /** Renderer initiates handoff; transitions editing → handing_off. */
  applyHandoffStarted(): void;

  /** Bridge confirmed cart.handoff → { kind: 'ok' }. Transitions handing_off → frozen_handed_off. */
  applyFrozen(): void;

  /** Bridge confirmed cart.void → { kind: 'ok' }. Transitions any → cancelled. */
  applyCancelled(): void;

  /**
   * RT-26 — main confirmed `cart.returnToSale` → { kind: 'ok' } for THIS cart.
   * Mirrors the guarded `frozen_handed_off → editing` edge only; any other
   * cart or state is left untouched. Never called on renderer intent alone.
   */
  applyReturnedToSale(cart_id: string): void;

  /** Test-only: resets store to initial state. */
  reset(): void;
}

function transition(
  cart: ActiveCart,
  to: CartState,
  extra?: Partial<ActiveCart>,
): ActiveCart | null {
  if (!isValidTransition(cart.state, to)) {
    return null;
  }
  return { ...cart, state: to, ...extra };
}

export const useCartStore = create<CartStore>((set) => ({
  activeCart: null,

  applyCartCreated: (cart_id: string) => {
    set({
      activeCart: { cart_id, state: CartState.empty, lastLineId: null },
    });
  },

  applyLineAdded: (line_id: string) => {
    set((s) => {
      if (s.activeCart === null) return s;
      if (s.activeCart.state === CartState.empty) {
        const next = transition(s.activeCart, CartState.editing, { lastLineId: line_id });
        if (next === null) return s;
        return { activeCart: next };
      }
      if (s.activeCart.state === CartState.editing) {
        return { activeCart: { ...s.activeCart, lastLineId: line_id } };
      }
      return s;
    });
  },

  applyDiscountAttributionRequired: () => {
    set((s) => {
      if (s.activeCart === null) return s;
      const next = transition(s.activeCart, CartState.discount_pending_attribution);
      if (next === null) return s;
      return { activeCart: next };
    });
  },

  applyDiscountAttributionResolved: () => {
    set((s) => {
      if (s.activeCart === null) return s;
      const next = transition(s.activeCart, CartState.editing);
      if (next === null) return s;
      return { activeCart: next };
    });
  },

  applyHandoffStarted: () => {
    set((s) => {
      if (s.activeCart === null) return s;
      const next = transition(s.activeCart, CartState.handing_off);
      if (next === null) return s;
      return { activeCart: next };
    });
  },

  applyFrozen: () => {
    set((s) => {
      if (s.activeCart === null) return s;
      const next = transition(s.activeCart, CartState.frozen_handed_off);
      if (next === null) return s;
      return { activeCart: next };
    });
  },

  applyCancelled: () => {
    set((s) => {
      if (s.activeCart === null) return s;
      const next = transition(s.activeCart, CartState.cancelled);
      if (next === null) return s;
      return { activeCart: next };
    });
  },

  applyReturnedToSale: (cart_id: string) => {
    set((s) => {
      const cart = s.activeCart;
      if (cart?.cart_id !== cart_id || cart.state !== CHECKOUT_RETURN_TRANSITION.from) return s;
      return { activeCart: { ...cart, state: CHECKOUT_RETURN_TRANSITION.to } };
    });
  },

  reset: () => {
    set({ activeCart: null });
  },
}));
