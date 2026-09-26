import { useCallback, type JSX } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { usePaymentStore } from '../../../stores/payment-store';
import { resetSaleStores } from '../../../sale/reset-sale-stores';
import { Workspace } from '../../../shell/regions/Workspace';
import { PaymentSurface } from '../../../ui/payments/PaymentSurface';
import { CheckoutPlaceholder } from './CheckoutPlaceholder';

/**
 * 006-payments-tender — `/app/checkout` route.
 *
 * When the `payments` feature flag is on, the checkout route renders the live
 * `PaymentSurface` (the tender screen). PaymentSurface self-gates: it returns
 * null unless a signed-in operator session AND a non-null payment envelope
 * exist in the payment store. The envelope is mounted by CartPane's
 * "Continue to payment" handler immediately before navigation here, so by the
 * time this route renders the envelope is present.
 *
 * When the flag is off (fail-closed default), the route falls back to the
 * 003-era `CheckoutPlaceholder` — the visual tender-slot reservation — so the
 * route is never blank and pre-006 behaviour is preserved.
 *
 * PaymentSurface reads its own payments + tender + sales bridge from
 * `window.api`. The one prop threaded here is `onNewSale`: after payment
 * settles, PaymentSurface shows a "New sale" button but is Router-agnostic, so
 * the route owner supplies the post-sale reset+navigate. Resetting the payment
 * and cart stores then returning to /app/cart starts the next sale clean and
 * is what unsticks the cashier from the settled surface (the prior dead-end).
 */
export function CheckoutRoute(): JSX.Element {
  const paymentsFlag = useFeatureFlagsStore((s) => s.payments);
  const hasEnvelope = usePaymentStore((s) => s.envelope !== null);
  const navigate = useNavigate();

  const handleNewSale = useCallback((): void => {
    // Clear the just-completed sale's payment envelope + attempt, and the cart,
    // so the next sale starts from empty. (The finalized Sale is already
    // durable in the main process; these stores are renderer-only working
    // state.) Then return to the cart to begin ringing the next sale.
    resetSaleStores();
    void navigate('/app/cart');
  }, [navigate]);

  if (!paymentsFlag) {
    return <CheckoutPlaceholder />;
  }
  // No handed-off sale (direct entry, or a renderer reload lost the envelope):
  // there is nothing to pay here, so return to the Sale instead of an empty pane.
  if (!hasEnvelope) {
    return <Navigate to="/app/cart" replace />;
  }

  // 023 Slice G: checkout renders in the v5 frame, where PaymentSurface's own
  // Arabic heading is the screen's one title (no English-only Workspace title).
  return (
    <Workspace>
      <PaymentSurface onNewSale={handleNewSale} />
    </Workspace>
  );
}
