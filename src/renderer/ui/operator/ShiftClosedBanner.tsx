import type { JSX } from 'react';
import { formatHumanDateTime } from '../format/human-format';

interface ShiftClosedBannerProps {
  closedAt: string;
  onDismiss: () => void;
}

export function ShiftClosedBanner({ closedAt, onDismiss }: ShiftClosedBannerProps): JSX.Element {
  const formatted = formatHumanDateTime(closedAt, { withYear: true, withTime: false }) ?? closedAt;
  return (
    <div
      role="status"
      aria-live="polite"
      className="shift-closed-banner"
      data-testid="shift-closed-banner"
    >
      <span className="shift-closed-banner__message">
        Your previous shift was closed on {formatted} while you were away.
      </span>
      <button
        type="button"
        className="shift-closed-banner__dismiss"
        data-testid="shift-closed-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        Dismiss
      </button>
    </div>
  );
}
