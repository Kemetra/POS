import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { LiveSaleWorkspace } from './LiveSaleWorkspace';
import { PARKED_SALES_PATH } from '../park/ParkedSalesRoute';

/** 023 Slice G — the production `/app/cart` element: the live v5 Sale. */
export function V5SaleRoute(): JSX.Element {
  const navigate = useNavigate();
  return (
    <LiveSaleWorkspace
      onPaymentContinue={() => {
        void navigate('/app/checkout');
      }}
      onShowParked={() => {
        void navigate(PARKED_SALES_PATH);
      }}
    />
  );
}
