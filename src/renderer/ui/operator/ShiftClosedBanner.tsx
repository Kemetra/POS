import type { JSX } from 'react';
import { Banner } from '../../v5/foundation/Banner';
import { formatHumanDateTime } from '../format/human-format';

/**
 * RT-605 (owner scope extension, 2026-10-17) — doc 15 M-W4, owner-approved
 * 2026-10-17: «أُغلقت ورديتك السابقة في ‹date› أثناء غيابك.» with
 * the dismiss action «إخفاء». The date is the absolute-date formatter's
 * output (Arabic month, Western digits), bidi-isolated but not forced LTR, so
 * «16 أكتوبر 2026» keeps its Arabic order.
 */
export const SHIFT_CLOSED_COPY = {
  before: 'أُغلقت ورديتك السابقة في ',
  after: ' أثناء غيابك.',
  dismiss: 'إخفاء',
} as const;

interface ShiftClosedBannerProps {
  closedAt: string;
  onDismiss: () => void;
}

/**
 * The forced-shift-close notice: a V5 info banner in the notices stack. It is
 * shown once per close (the session store owns that) and leaves on dismiss.
 */
export function ShiftClosedBanner({
  closedAt,
  onDismiss,
}: Readonly<ShiftClosedBannerProps>): JSX.Element {
  const formatted = formatHumanDateTime(closedAt, { withYear: true, withTime: false }) ?? closedAt;
  return (
    <Banner
      tone="info"
      testId="shift-closed-banner"
      actions={
        <button
          type="button"
          className="v5-btn"
          data-testid="shift-closed-banner-dismiss"
          onClick={onDismiss}
        >
          {SHIFT_CLOSED_COPY.dismiss}
        </button>
      }
    >
      <p>
        {SHIFT_CLOSED_COPY.before}
        <bdi>{formatted}</bdi>
        {SHIFT_CLOSED_COPY.after}
      </p>
    </Banner>
  );
}
