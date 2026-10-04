import { useCallback, useRef } from 'react';

import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import { CartState } from '../../shared/cart/cart-state';
import { useCartStore } from '../stores/cart-store';
import { usePaymentStore } from '../stores/payment-store';

/**
 * RT-26 — Checkout Back / Esc to the active sale.
 *
 * Main is the authority: this asks `cart.returnToSale` and changes renderer
 * state ONLY after main confirms. On `ok` the payment store is reset (the old
 * envelope and any attempt projection are gone — main already invalidated
 * them), the renderer cart mirrors `frozen_handed_off → editing`, and
 * `onReturned` navigates to the Sale, which re-reads the authoritative cart
 * snapshot. A refusal or a transport failure changes nothing and resolves
 * `false`, so the cashier stays in the payment flow.
 *
 * The idempotency key is reused for retries of the SAME handoff: if main
 * applied the Back but the response was lost, the retry replays `ok` instead
 * of being refused as stale.
 */
export interface CheckoutBackToSaleOptions {
  /** Test seam; production reads `window.api.cart` at call time. */
  readonly bridge?: CartBridgeAPI;
  /** Called after main confirmed the return and the stores were updated. */
  readonly onReturned: () => void;
}

function readCartBridge(): CartBridgeAPI | null {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  return api?.cart ?? null;
}

export function useCheckoutBackToSale(options: CheckoutBackToSaleOptions): () => Promise<boolean> {
  const { bridge, onReturned } = options;
  const keyRef = useRef<{ handoff_action_id: string; key: string } | null>(null);

  return useCallback(async (): Promise<boolean> => {
    const envelope = usePaymentStore.getState().envelope;
    const cart = useCartStore.getState().activeCart;
    // Fail closed: only the cart the renderer holds, frozen on this envelope.
    if (
      envelope === null ||
      cart?.cart_id !== envelope.cart_id ||
      cart.state !== CartState.frozen_handed_off
    ) {
      return false;
    }
    const cartBridge = bridge ?? readCartBridge();
    if (cartBridge?.returnToSale === undefined) return false;

    if (keyRef.current?.handoff_action_id !== envelope.handoff_action_id) {
      keyRef.current = {
        handoff_action_id: envelope.handoff_action_id,
        key: crypto.randomUUID(),
      };
    }
    const res = await cartBridge
      .returnToSale({
        cart_id: envelope.cart_id,
        handoff_action_id: envelope.handoff_action_id,
        idempotency_key: keyRef.current.key,
      })
      .catch(() => null);
    if (res?.kind !== 'ok') return false;

    useCartStore.getState().applyReturnedToSale(envelope.cart_id);
    // Drop the old envelope and attempt projection only if they still belong
    // to the cart that returned.
    if (usePaymentStore.getState().envelope?.cart_id === envelope.cart_id) {
      usePaymentStore.getState().reset();
    }
    onReturned();
    return true;
  }, [bridge, onReturned]);
}
