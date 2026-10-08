export enum CartState {
  empty = 'empty',
  editing = 'editing',
  discount_pending_attribution = 'discount_pending_attribution',
  handing_off = 'handing_off',
  frozen_handed_off = 'frozen_handed_off',
  cancelled = 'cancelled',
}

/**
 * Allowed FSM transitions: Map<from, Set<to>>.
 * Terminal states (cancelled, frozen_handed_off) have no outbound edges
 * except that any state can transition to cancelled.
 *
 * `frozen_handed_off → editing` is deliberately NOT listed here: it is not a
 * generic edge any caller may take, but the main-guarded Checkout Back
 * contract (RT-26, `cart.returnToSale`) — see {@link CHECKOUT_RETURN_TRANSITION}.
 */
export const CART_FSM_TRANSITIONS: Readonly<Record<CartState, ReadonlySet<CartState>>> = {
  [CartState.empty]: new Set([CartState.editing, CartState.cancelled]),
  [CartState.editing]: new Set([
    CartState.discount_pending_attribution,
    CartState.handing_off,
    CartState.cancelled,
  ]),
  [CartState.discount_pending_attribution]: new Set([CartState.editing, CartState.cancelled]),
  [CartState.handing_off]: new Set([
    CartState.frozen_handed_off,
    CartState.editing,
    CartState.cancelled,
  ]),
  [CartState.frozen_handed_off]: new Set([CartState.cancelled]),
  [CartState.cancelled]: new Set(),
};

/**
 * RT-26 — the single guarded way out of `frozen_handed_off` other than
 * cancellation. Main takes it only inside `cart.returnToSale` (no tender
 * activity, no settled / force-failed payment, atomic with envelope
 * invalidation); the renderer mirrors it only after main confirms. Kept out of
 * `CART_FSM_TRANSITIONS` so no generic `transition(…, editing)` can unfreeze a
 * handed-off cart.
 */
export const CHECKOUT_RETURN_TRANSITION = {
  from: CartState.frozen_handed_off,
  to: CartState.editing,
} as const;

export function isValidTransition(from: CartState, to: CartState): boolean {
  return CART_FSM_TRANSITIONS[from].has(to);
}
