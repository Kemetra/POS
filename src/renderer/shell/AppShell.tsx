import type { JSX } from 'react';
import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';

import { TopBar } from './regions/TopBar';
import { NavRail } from './regions/NavRail';
import { ScreenTooSmall } from '../ui/states/ScreenTooSmall';
import { useViewportTier } from './viewport/useViewportTier';
import { useConnectionState } from './connection/useConnectionState';
import type { PairingStatus } from '../../shared/pairing-types';
import { useOperatorSessionStore } from '../stores/operator-session-store';
import { ShiftClosedBanner } from '../ui/operator/ShiftClosedBanner';
import { PrinterFailureBanner } from '../ui/receipts/PrinterFailureBanner';
import { useBannerState } from '../ui/receipts/useBannerState';
import { DrawerNoticeBanner, useDrawerNoticeFeed } from '../ui/receipts/DrawerNotice';

interface AppShellProps {
  pairedStatus?: Extract<PairingStatus, { kind: 'paired' }>;
}

/**
 * T034/T045 — AppShell: the persistent layout shell.
 *
 * Composes TopBar (banner), NavRail (navigation), and MainContent (main / Outlet).
 * At < 1024 px the NavRail is suppressed and ScreenTooSmall replaces MainContent.
 *
 * T045 (US4): wires the ?conn= dev toggle to useConnectionState.
 * The wiring is gated by import.meta.env.DEV so it is tree-shaken from
 * production builds. useDevToggles is imported lazily inside the effect
 * for the same reason.
 */
export function AppShell({ pairedStatus }: AppShellProps): JSX.Element {
  const tier = useViewportTier();
  const { state: connectionState, setState: setConnectionState } = useConnectionState();
  const sessionState = useOperatorSessionStore((s) => s.state);
  // T291 — printer-failure banner state, polled from sales.subscribe(banner_state).
  const printFailure = useBannerState();
  // T361 / RT-241 (D-B1) — the drawer notice, fed by the same snapshot's
  // `.drawer_failure` slice; shown only for a failure from this session.
  useDrawerNoticeFeed();

  // Dev-only: wire ?conn= URL param → useConnectionState.
  // The cast keeps TS happy while Vite tree-shakes the dev branch from production.
  useEffect(() => {
    const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (!metaEnv?.DEV) return;
    // Dynamically read the dev toggle to keep the module tree-shakeable.
    // useDevToggles reads window.location.search synchronously — no async.
    void import('./dev/useDevToggles').then(({ getDevToggles }) => {
      const { conn } = getDevToggles();
      setConnectionState(conn);
    });
    // Intentionally run only on mount; URL search params are static per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tenantId = pairedStatus?.tenant_id ?? '';
  const branchId = pairedStatus?.branch_id ?? '';
  const terminalLabel = pairedStatus?.terminal_label ?? '';
  const notice = sessionState.kind === 'signedIn' ? sessionState.forced_close_notice : undefined;

  if (tier === 'too-small') {
    return (
      <div className="app-shell" data-testid="app-shell" dir="rtl">
        <TopBar
          tenantId={tenantId}
          branchId={branchId}
          terminalLabel={terminalLabel}
          connectionState={connectionState}
        />
        <ScreenTooSmall />
      </div>
    );
  }

  return (
    // POS v3.5 Slice 1: the whole terminal shell is RTL (Arabic-first). IDs,
    // SKUs, money and mono identifiers re-isolate to dir="ltr" inside their own
    // child components (IdentityStrip terminal chip, etc.), not here.
    <div className="app-shell" data-testid="app-shell" dir="rtl">
      <TopBar
        tenantId={tenantId}
        branchId={branchId}
        terminalLabel={terminalLabel}
        connectionState={connectionState}
      />
      <div className="app-shell__body">
        <NavRail />
        <main className="app-shell__content">
          {notice !== undefined ? (
            <ShiftClosedBanner
              closedAt={notice.closed_at}
              onDismiss={() => {
                useOperatorSessionStore.getState().dismissShiftClosedNotice();
              }}
            />
          ) : undefined}
          {/* T291 — persistent printer-failure banner, fed by the snapshot
              poll hook. Unmounts when there is no unresolved failure. Reprint /
              Manual are entry-points (handlers land Slice 5 / Slice 6). */}
          <PrinterFailureBanner
            printFailure={printFailure}
            onReprint={() => {
              // Slice 5 (receipts.reprint) — entry-point only for now.
            }}
            /* T512: Manual receipt now calls receipts.manualOverride directly
               inside the banner; no onManualOverride prop. The banner dismisses
               via the banner_state projection once the override row lands. */
          />
          {/* T361 / RT-241 (D-B1) — the drawer notice, stacked BELOW the
              printer banner (NFR-008 order). Coexists with it. Manual receipt
              is the same entry-point stub as before (unchanged here). */}
          <DrawerNoticeBanner
            now={new Date().toISOString()}
            onManualOverride={() => {
              // Slice 6 (receipts.manualOverride) — entry-point only for now.
            }}
          />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
