import type { JSX } from 'react';

import { formatRelativeTime } from '../../../shared/formatters/time-formatters.js';
import { Banner } from '../../v5/foundation/Banner';
import { Notice } from '../../v5/foundation/Notice';
import { acknowledgeDrawerNotice, useDrawerNoticeStore } from './drawer-notice-store';
import { useDrawerBannerState, type DrawerFailureState } from './useDrawerBannerState';

/**
 * RT-241 — the D-B1 drawer notice (freeze 15 §5 M-C4/M-C5, §7 D-B1). It
 * replaces the persistent cross-session DrawerFailureBanner (N-08): shown in
 * the status area and inside cash completion for a failure that happened in
 * this session, cleared on «تم», «بيع جديد», the next successful drawer event,
 * sign-out or restart (lifetime: drawer-notice-store.ts).
 *
 * Kept from the old banner: the manual-receipt recovery (enabled ⟹ wired) and
 * FR-053 — there is no retry-kick and no "open the drawer" action, because a
 * second kick has no audit anchor (UNIQUE(sale_id) on drawer_events).
 */

const MESSAGE = 'لم يُفتح درج النقود. افتحه يدويًا.';

function observeSnapshot(failure: DrawerFailureState | null): void {
  useDrawerNoticeStore.getState().observe(failure);
}

/** Feeds the notice from the existing banner-state poll; returns nothing to render. */
export function useDrawerNoticeFeed(): void {
  useDrawerBannerState({ onSnapshot: observeSnapshot });
}

interface DrawerNoticeBannerProps {
  /** Reference "now" (ISO-8601) for the M-C5 relative time. */
  now: string;
  /** The existing receipts.manualOverride entry point, for the failed sale. */
  onManualOverride: (saleId: string) => void;
}

/** The status-area notice: the one live region for this event. */
export function DrawerNoticeBanner({
  now,
  onManualOverride,
}: DrawerNoticeBannerProps): JSX.Element | null {
  const notice = useDrawerNoticeStore((s) => s.active);
  if (notice === null) return null;

  return (
    <Banner
      tone="warning"
      testId="drawer-notice"
      actions={
        <>
          <button
            type="button"
            onClick={() => {
              onManualOverride(notice.sale_id);
            }}
          >
            إيصال يدوي
          </button>
          <button type="button" onClick={acknowledgeDrawerNotice}>
            تم
          </button>
        </>
      }
    >
      <p>{MESSAGE}</p>
      <p className="v5-banner__meta">
        آخر فتح: {formatRelativeTime(notice.last_successful_open_at, now)}
      </p>
    </Banner>
  );
}

/** The same notice inside cash completion. Visual only: the banner announces it. */
export function DrawerNoticeInline(): JSX.Element | null {
  const notice = useDrawerNoticeStore((s) => s.active);
  if (notice === null) return null;

  return (
    <Notice
      tone="warning"
      announce={false}
      testId="drawer-notice-inline"
      action={
        <button type="button" onClick={acknowledgeDrawerNotice}>
          تم
        </button>
      }
    >
      {MESSAGE}
    </Notice>
  );
}
