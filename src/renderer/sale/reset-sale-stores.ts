import { useCartStore } from '../stores/cart-store';
import { useLineFlagsStore } from '../stores/line-flags-store';
import { usePaymentStore } from '../stores/payment-store';

/**
 * The logical "New sale" reset: drop the renderer's pointer to the finished
 * cart, its payment envelope + attempt, and its lines' add-time flags. Renderer working state only — the
 * persisted cart, payment attempt and sale are untouched. Never creates a
 * cart; the next one comes from the normal catalogue create path.
 */
export function resetSaleStores(): void {
  usePaymentStore.getState().reset();
  useCartStore.getState().reset();
  useLineFlagsStore.getState().reset();
}
