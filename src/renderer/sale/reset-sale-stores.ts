import { useCartStore } from '../stores/cart-store';
import { usePaymentStore } from '../stores/payment-store';

/**
 * The logical "New sale" reset: drop the renderer's pointer to the finished
 * cart and its payment envelope + attempt. Renderer working state only — the
 * persisted cart, payment attempt and sale are untouched. Never creates a
 * cart; the next one comes from the normal catalogue create path.
 */
export function resetSaleStores(): void {
  usePaymentStore.getState().reset();
  useCartStore.getState().reset();
}
