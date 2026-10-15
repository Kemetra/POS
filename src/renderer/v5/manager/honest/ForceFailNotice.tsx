import type { JSX } from 'react';

import { HonestNotice } from './HonestNotice';
import { HONEST_COPY, MANAGER_PATHS } from './honest-copy';

/**
 * RT-503 (VN-S10 S10-6) — the hidden force-fail page's content (G-6 state 21).
 * It is opened from a pending payment only; here it says so and offers
 * «المبيعات المعلقة». It builds no stuck-attempt list (no contract).
 */
export function ForceFailNotice(): JSX.Element {
  return (
    <div className="v5-honest-state">
      <HonestNotice
        notice={HONEST_COPY.forceFail.notice}
        action={{ label: HONEST_COPY.forceFail.action, to: MANAGER_PATHS.recovery }}
        testId="manager-force-fail-route-placeholder"
      />
    </div>
  );
}
