import { useEffect, useState } from 'react';

import type { SalesBridgeAPI } from '../../../shared/bridge-api.js';
import type { PrinterFailureState } from './PrinterFailureBanner.js';

/**
 * useBannerState — renderer poll hook backing `<PrinterFailureBanner>`.
 *
 * Snapshot-subscribe (coordination §S3c mechanism note): polls
 * `sales.subscribe({topic:'banner_state'})` on an interval and maps the
 * `BannerState` response to the banner's `printFailure` prop
 * (`PrinterFailureState | null`). No `webContents.send` push — consistent with
 * the poll-based AD-2 finalize design. A refused / errored / non-printer
 * BannerState yields `null` (banner unmounts). The interval is cleared on
 * unmount, and a poll resolving after unmount is ignored.
 *
 * Drawer-failure state is intentionally NOT surfaced here — that is the
 * drawer notice's own hook (useDrawerBannerState) against the same snapshot.
 */

export interface UseBannerStateOptions {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /** Injected for tests; production falls back to `window.api.sales`. */
  _testSalesBridge?: SalesBridgeAPI;
}

function resolveSalesBridge(injected?: SalesBridgeAPI): SalesBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { sales?: SalesBridgeAPI } }).api;
  return api?.sales ?? null;
}

const DEFAULT_INTERVAL_MS = 1000;

export function useBannerState(options: UseBannerStateOptions = {}): PrinterFailureState | null {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const bridge = options._testSalesBridge;
  const [printFailure, setPrintFailure] = useState<PrinterFailureState | null>(null);

  useEffect(() => {
    const sales = resolveSalesBridge(bridge);
    if (sales === null) {
      setPrintFailure(null);
      return;
    }
    let cancelled = false;

    const poll = (): void => {
      void sales
        .subscribe({ topic: 'banner_state' })
        .then((res) => {
          if (cancelled) return;
          if (res.kind === 'ok' && 'banner_state' in res && res.banner_state.printer_failure) {
            const b = res.banner_state.printer_failure;
            setPrintFailure({
              sale_id: b.sale_id,
              failure_reason: b.failure_reason,
              has_successful_print: b.has_successful_print,
            });
          } else {
            setPrintFailure(null);
          }
        })
        .catch(() => {
          if (!cancelled) setPrintFailure(null);
        });
    };

    poll(); // immediate first poll
    const handle = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [bridge, intervalMs]);

  return printFailure;
}
