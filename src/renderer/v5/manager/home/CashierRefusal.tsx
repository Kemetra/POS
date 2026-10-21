import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { Notice } from '../../foundation/Notice';
import { HOME_COPY } from './home-copy';
import './manager-home.css';

const SALE_PATH = '/app/cart';

/**
 * RT-499 (G-6) — a cashier who opens `/app/dashboard` directly: one honest
 * sentence and the way back to the Sale. The route and main still refuse every
 * manager call; this only replaces the English «Section unavailable».
 */
export function CashierRefusal(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="v5-manager-state">
      <Notice
        tone="info"
        testId="manager-home-refusal"
        action={
          <button
            type="button"
            className="v5-manager-btn v5-manager-btn--primary v5-btn"
            onClick={() => {
              void navigate(SALE_PATH);
            }}
          >
            {HOME_COPY.backToSale}
          </button>
        }
      >
        <p>{HOME_COPY.cashierRefusal}</p>
      </Notice>
    </div>
  );
}
