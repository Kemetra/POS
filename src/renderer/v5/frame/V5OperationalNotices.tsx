import { useRef, type JSX } from 'react';
import type { ReceiptsBridgeAPI } from '../../../shared/bridge-api';
import type { SaleId } from '../../../shared/sales/types';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { ShiftClosedBanner } from '../../ui/operator/ShiftClosedBanner';
import { PrinterFailureBanner } from '../../ui/receipts/PrinterFailureBanner';
import { useBannerState } from '../../ui/receipts/useBannerState';
import { DrawerNoticeBanner, useDrawerNoticeFeed } from '../../ui/receipts/DrawerNotice';
import { ShiftNotice } from '../shift/ShiftNotice';

type RecoveryAction = 'reprint' | 'manualOverride';

function receiptsBridge(): ReceiptsBridgeAPI | null {
  const api = (window as unknown as { api?: { receipts?: ReceiptsBridgeAPI } }).api;
  return api?.receipts ?? null;
}

/**
 * Wires a banner's recovery control to the EXISTING receipts bridge
 * (`receipts.reprint` / `receipts.manualOverride`), so an enabled control is
 * never inert (enabled ⟹ wired). Each press sends a fresh idempotency key;
 * one call per action and sale may be in flight, so a double press or an
 * impatient repeat cannot fire duplicate recovery mutations. The banner itself
 * dismisses from the banner-state projection once main records the outcome;
 * a refused or failed call leaves the failure visible, which is the truth.
 */
function useRecoveryAction(action: RecoveryAction): (saleId: string) => void {
  const inFlight = useRef(new Set<string>());
  return (saleId) => {
    const bridge = receiptsBridge();
    if (bridge === null || inFlight.current.has(saleId)) return;
    inFlight.current.add(saleId);
    const request = { sale_id: saleId as SaleId, idempotency_key: globalThis.crypto.randomUUID() };
    const call = action === 'reprint' ? bridge.reprint(request) : bridge.manualOverride(request);
    void call
      .catch(() => undefined)
      .finally(() => {
        inFlight.current.delete(saleId);
      });
  };
}

/**
 * The persistent operational banners the legacy app frame carries: forced
 * shift close, printer failure, and the D-B1 drawer notice (RT-241: this
 * session's drawer failure only, until acknowledged). Same components, same
 * session store and banner-state polling, so a v5 screen never hides a real
 * failure. Each banner unmounts when there is nothing to report; with no
 * sales bridge the polling hooks resolve to null.
 *
 * RT-17 slice 4 part 3: the shift notice (the cashier's "shift required"
 * banner, or the way to the shift screens) — nothing while the shift flag is
 * off.
 *
 * The legacy connection pill is deliberately NOT carried: it has no live data
 * source yet, and an always-"Online" indicator would be a fabricated state.
 */
export function V5OperationalNotices(): JSX.Element {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const printFailure = useBannerState();
  // RT-241 (D-B1): shown only for a drawer failure from this session.
  useDrawerNoticeFeed();
  const reprint = useRecoveryAction('reprint');
  const manualOverride = useRecoveryAction('manualOverride');
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
      <PrinterFailureBanner printFailure={printFailure} onReprint={reprint} />
      <DrawerNoticeBanner now={new Date().toISOString()} onManualOverride={manualOverride} />
      <ShiftNotice />
    </>
  );
}
