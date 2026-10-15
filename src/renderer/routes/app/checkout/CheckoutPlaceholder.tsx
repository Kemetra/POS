import type { JSX } from 'react';

import { ScreenSection } from '../../../v5/foundation/ScreenSection';
import { HonestNotice } from '../../../v5/manager/honest/HonestNotice';
import { HONEST_COPY, MANAGER_PATHS } from '../../../v5/manager/honest/honest-copy';

/**
 * RT-503 (VN-S10 S10-6) — `/app/checkout` while the `payments` flag is off
 * (fail-closed default): an Arabic notice inside the frame and the way back to
 * the Sale. It replaces the 003-era reservation of eleven tender slots, which
 * implied a payment surface that is not there. The flag behaviour is unchanged.
 *
 * No payment logic, IPC, persistence or printing.
 */
export function CheckoutPlaceholder(): JSX.Element {
  const copy = HONEST_COPY.checkoutOff;
  return (
    <ScreenSection title={copy.title}>
      <div className="v5-honest-state">
        <HonestNotice
          notice={copy.notice}
          action={{ label: copy.action, to: MANAGER_PATHS.cart }}
          testId="checkout-payments-off-notice"
        />
      </div>
    </ScreenSection>
  );
}
