import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { LiveSaleWorkspace } from './LiveSaleWorkspace';

/** 023 Slice G — the production `/app/cart` element: the live v5 Sale. */
export function V5SaleRoute(): JSX.Element {
  const navigate = useNavigate();
  return (
    <LiveSaleWorkspace
      onPaymentContinue={() => {
        void navigate('/app/checkout');
      }}
    />
  );
}
