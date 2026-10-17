import type { JSX } from 'react';
import { countedParts } from '../../terminal-status/counted-copy';
import { BANNER_COPY } from '../../terminal-status/status-copy';
import { mapStatusBanners, type StatusBanners } from '../../terminal-status/status-mapping';
import { useTerminalStatusStore } from '../../terminal-status/terminal-status-store';
import { useAttentionDeadline } from '../../terminal-status/use-attention-deadline';
import { Banner } from '../foundation/Banner';
import './status-indicator.css';

/**
 * RT-605 (VN-S6 S6-4, doc 24 §4.3) — the status banners of the notices stack.
 * They read the terminal-status store that the nav's StatusIndicator feeds
 * (one bridge subscription for the frame) and derive the banners through the
 * S6-3 mapping, so the 24 h line is the same rule the indicator uses. No
 * snapshot shows nothing. Both are persistent: no dismiss, each leaves when
 * the state it reports is over.
 */
export function useStatusBanners(): StatusBanners {
  const snapshot = useTerminalStatusStore((s) => s.snapshot);
  useAttentionDeadline(snapshot);
  return mapStatusBanners(snapshot, Date.now());
}

/**
 * M-O3 (U2), danger: a dead letter, or a pending sale older than 24 h. The
 * sentence follows the count (RT-646); 1 and 2 are words, with no number run.
 */
export function SyncAttentionBanner({ count }: Readonly<{ count: number }>): JSX.Element {
  const parts = countedParts(count, BANNER_COPY.syncAttention);
  return (
    <Banner tone="danger" testId="v5-sync-attention-banner">
      <p>
        {parts.before}
        {parts.count !== null && (
          <span className="v5-status__num" dir="ltr">
            {String(parts.count)}
          </span>
        )}
        {parts.after}
      </p>
    </Banner>
  );
}

/** M-O1 (U3), warning: offline, or degraded shown as offline (D-6-2). */
export function OfflineBanner(): JSX.Element {
  return (
    <Banner tone="warning" testId="v5-offline-banner">
      <p>{BANNER_COPY.offline}</p>
    </Banner>
  );
}
