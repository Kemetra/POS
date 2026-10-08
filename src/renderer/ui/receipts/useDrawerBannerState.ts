import { useEffect, useRef, useState } from 'react';

import type { SalesBridgeAPI } from '../../../shared/bridge-api.js';

/**
 * useDrawerBannerState — renderer poll hook backing the drawer notice (RT-241 D-B1).
 *
 * The drawer-side twin of `useBannerState`. Polls
 * `sales.subscribe({topic:'banner_state'})` on an interval and maps the
 * `.drawer_failure` slice of the coexistence `BannerState` record to the
 * banner's `drawerFailure` prop (`DrawerFailureState | null`). Snapshot-subscribe
 * (no `webContents.send` push — consistent with the poll-based AD-2 finalize
 * design). A refused / errored / printer-only response yields `null` (banner
 * unmounts). The interval is cleared on unmount; a poll resolving after unmount
 * is ignored.
 *
 * Printer-failure state is intentionally NOT surfaced here — that is
 * `useBannerState`'s job against the same snapshot. Both hooks read their own
 * slice so the two banners coexist (Slice 4 decision).
 */

/** The projected drawer failure: which sale's drawer failed + last-open time. */
export interface DrawerFailureState {
  sale_id: string;
  /** UTC ISO-8601 of the terminal's last successful drawer open, or null. */
  last_successful_open_at: string | null;
}

export interface UseDrawerBannerStateOptions {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /** Injected for tests; production falls back to `window.api.sales`. */
  _testSalesBridge?: SalesBridgeAPI;
  /**
   * RT-241 (D-B1) — called with every KNOWN projection: the failure, or null
   * when an `ok` read has none. A refused or failed read is unknown and is
   * never reported.
   */
  onSnapshot?: (failure: DrawerFailureState | null) => void;
}

function resolveSalesBridge(injected?: SalesBridgeAPI): SalesBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { sales?: SalesBridgeAPI } }).api;
  return api?.sales ?? null;
}

const DEFAULT_INTERVAL_MS = 1000;

export function useDrawerBannerState(
  options: UseDrawerBannerStateOptions = {},
): DrawerFailureState | null {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const bridge = options._testSalesBridge;
  const [drawerFailure, setDrawerFailure] = useState<DrawerFailureState | null>(null);
  // A ref, so a new callback identity never restarts the poll interval.
  const onSnapshotRef = useRef(options.onSnapshot);
  onSnapshotRef.current = options.onSnapshot;

  useEffect(() => {
    const sales = resolveSalesBridge(bridge);
    if (sales === null) {
      setDrawerFailure(null);
      return;
    }
    let cancelled = false;

    const poll = (): void => {
      void sales
        .subscribe({ topic: 'banner_state' })
        .then((res) => {
          if (cancelled) return;
          if (res.kind === 'ok' && 'banner_state' in res && res.banner_state.drawer_failure) {
            const d = res.banner_state.drawer_failure;
            const failure = {
              sale_id: d.sale_id,
              last_successful_open_at: d.last_successful_open_at,
            };
            setDrawerFailure(failure);
            onSnapshotRef.current?.(failure);
          } else {
            setDrawerFailure(null);
            if (res.kind === 'ok' && 'banner_state' in res) onSnapshotRef.current?.(null);
          }
        })
        .catch(() => {
          if (!cancelled) setDrawerFailure(null);
        });
    };

    poll(); // immediate first poll
    const handle = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [bridge, intervalMs]);

  return drawerFailure;
}
