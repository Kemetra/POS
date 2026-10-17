import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { resetSaleStores } from '../../sale/reset-sale-stores';
import { useCartStore } from '../../stores/cart-store';
import { V5_SALE_PATH } from '../frame/nav-model';
import { parkBridgeOf, windowCartBridge } from './park-bridge';
import { ParkedSalesScreen } from './ParkedSalesScreen';

/** RT-445 — `/app/cart/parked`: the parked list and the resume review, inside the Sale entry. */
export const PARKED_SALES_PATH = `${V5_SALE_PATH}/parked`;

export function ParkedSalesRoute(): JSX.Element {
  const navigate = useNavigate();
  const cart = windowCartBridge();
  return (
    <ParkedSalesScreen
      parked={parkBridgeOf(cart)}
      cart={cart}
      onBackToSale={() => {
        void navigate(V5_SALE_PATH);
      }}
      onResumed={(cartId) => {
        // Same shape as a confirmed create; the Sale's snapshot read sets the real lines and state.
        resetSaleStores();
        useCartStore.getState().applyCartCreated(cartId);
        void navigate(V5_SALE_PATH);
      }}
    />
  );
}
