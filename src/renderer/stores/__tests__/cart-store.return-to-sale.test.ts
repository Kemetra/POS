import { afterEach, describe, expect, it } from 'vitest';

import {
  CART_FSM_TRANSITIONS,
  CHECKOUT_RETURN_TRANSITION,
  CartState,
  isValidTransition,
} from '../../../shared/cart/cart-state';
import { useCartStore } from '../cart-store';

/**
 * RT-26 — `frozen_handed_off → editing` exists ONLY as the guarded Checkout
 * Back edge, mirrored after main confirms. No generic transition can unfreeze.
 */

afterEach(() => {
  useCartStore.getState().reset();
});

function frozen(cart_id = 'cart-1'): void {
  useCartStore.setState({
    activeCart: { cart_id, state: CartState.frozen_handed_off, lastLineId: 'line-1' },
  });
}

describe('cart store — applyReturnedToSale (RT-26)', () => {
  it('moves the matching frozen cart to editing, keeping its id and last line', () => {
    frozen();
    useCartStore.getState().applyReturnedToSale('cart-1');
    expect(useCartStore.getState().activeCart).toEqual({
      cart_id: 'cart-1',
      state: CartState.editing,
      lastLineId: 'line-1',
    });
  });

  it('ignores another cart, and any non-frozen state', () => {
    frozen();
    useCartStore.getState().applyReturnedToSale('cart-other');
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);

    for (const state of [CartState.cancelled, CartState.handing_off, CartState.empty]) {
      useCartStore.setState({ activeCart: { cart_id: 'cart-1', state, lastLineId: null } });
      useCartStore.getState().applyReturnedToSale('cart-1');
      expect(useCartStore.getState().activeCart?.state).toBe(state);
    }
  });

  it('keeps the generic FSM closed: frozen_handed_off only goes to cancelled', () => {
    expect([...CART_FSM_TRANSITIONS[CartState.frozen_handed_off]]).toEqual([CartState.cancelled]);
    expect(isValidTransition(CartState.frozen_handed_off, CartState.editing)).toBe(false);
    expect(CHECKOUT_RETURN_TRANSITION).toEqual({
      from: CartState.frozen_handed_off,
      to: CartState.editing,
    });
    // A generic "back to editing" action cannot unfreeze a handed-off cart.
    frozen();
    useCartStore.getState().applyDiscountAttributionResolved();
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
  });
});
