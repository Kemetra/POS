import type { JSX } from 'react';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { ShiftClosedBanner } from '../../ui/operator/ShiftClosedBanner';
import { PrinterFailureBanner } from '../../ui/receipts/PrinterFailureBanner';
import { useBannerState } from '../../ui/receipts/useBannerState';
import { DrawerFailureBanner } from '../../ui/receipts/DrawerFailureBanner';
import { useDrawerBannerState } from '../../ui/receipts/useDrawerBannerState';

/**
 * The persistent operational banners the legacy app frame carries: forced
 * shift close, printer failure and drawer failure. Reused unchanged (same
 * components, same session store and banner-state polling) so a v5 screen
 * never hides a real failure. Each banner unmounts when there is nothing to
 * report; with no sales bridge the polling hooks resolve to null.
 *
 * The legacy connection pill is deliberately NOT carried: it has no live data
 * source yet, and an always-"Online" indicator would be a fabricated state.
 */
export function V5OperationalNotices(): JSX.Element {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const printFailure = useBannerState();
  const drawerFailure = useDrawerBannerState();
  const notice = sessionState.kind === 'signedIn' ? sessionState.forced_close_notice : undefined;

  return (
    <>
      {notice !== undefined && (
        <ShiftClosedBanner
          closedAt={notice.closed_at}
          onDismiss={() => {
            useOperatorSessionStore.getState().dismissShiftClosedNotice();
          }}
        />
      )}
      <PrinterFailureBanner printFailure={printFailure} onReprint={() => undefined} />
      <DrawerFailureBanner
        drawerFailure={drawerFailure}
        now={new Date().toISOString()}
        onManualOverride={() => undefined}
      />
    </>
  );
}
