/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed bridge spies trigger this rule on expect(...) assertions.
 */
/**
 * useDrawerBannerState — renderer poll hook for the `.drawer_failure` slice.
 *
 * Maps the coexistence `BannerState` record's `drawer_failure` slice to the
 * `<DrawerFailureBanner>` prop shape. A printer-only / none / refused / errored
 * response yields null. Printer failures are NOT surfaced here (that's
 * useBannerState). The interval is cleared on unmount.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { useDrawerBannerState } from '../../../../src/renderer/ui/receipts/useDrawerBannerState.js';
import type { SalesBridgeAPI } from '../../../../src/shared/bridge-api.js';
import type { BannerState } from '../../../../src/shared/sales/types.js';

function salesBridge(banner: BannerState): SalesBridgeAPI {
  return {
    read: vi.fn(),
    findByNumber: vi.fn(),
    subscribe: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, subscription_token: 'tok-1', banner_state: banner }),
    ),
    unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDrawerBannerState', () => {
  it('maps a drawer_failure slice to DrawerFailureState on first poll', async () => {
    const bridge = salesBridge({
      printer_failure: null,
      drawer_failure: { sale_id: 'sale-1', last_successful_open_at: '2026-05-29T08:00:00.000Z' },
    });
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current).toEqual({
      sale_id: 'sale-1',
      last_successful_open_at: '2026-05-29T08:00:00.000Z',
    });
  });

  it('yields null for a printer-only failure (drawer banner does not surface it)', async () => {
    const bridge = salesBridge({
      printer_failure: {
        sale_id: 'sale-1',
        failure_reason: 'printer_offline',
        has_successful_print: false,
      },
      drawer_failure: null,
    });
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('surfaces the drawer slice even when a printer failure coexists', async () => {
    // Coexistence: both slices non-null. This hook reads ONLY drawer.
    const bridge = salesBridge({
      printer_failure: {
        sale_id: 'sale-2',
        failure_reason: 'printer_offline',
        has_successful_print: false,
      },
      drawer_failure: { sale_id: 'sale-1', last_successful_open_at: null },
    });
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.sale_id).toBe('sale-1');
  });

  it('yields null for a both-null BannerState', async () => {
    const bridge = salesBridge({ printer_failure: null, drawer_failure: null });
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('yields null when subscribe refuses', async () => {
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('yields null and does not throw when subscribe rejects', async () => {
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(() => Promise.reject(new Error('ipc boom'))),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    const { result } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('stops polling after unmount (no further subscribe calls)', async () => {
    vi.useFakeTimers();
    const bridge = salesBridge({ printer_failure: null, drawer_failure: null });
    const { unmount } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = (bridge.subscribe as ReturnType<typeof vi.fn>).mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect((bridge.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('returns null when no sales bridge is available (no crash)', async () => {
    const { result } = renderHook(() => useDrawerBannerState({ intervalMs: 1000 }));
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it('ignores a resolution that arrives after unmount (cancelled then arm)', async () => {
    let resolveFn: (r: {
      kind: 'ok';
      subscription_token: string;
      banner_state: BannerState;
    }) => void = () => {};
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    const { result, unmount } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    unmount();
    // Resolve a drawer failure AFTER unmount — the cancelled guard must swallow
    // the setState (no crash / act-warning); state stays null.
    resolveFn({
      kind: 'ok',
      subscription_token: 't',
      banner_state: {
        printer_failure: null,
        drawer_failure: { sale_id: 'sale-1', last_successful_open_at: null },
      },
    });
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it('swallows a rejection that resolves after unmount (cancelled catch arm)', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectFn = reject;
          }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    const { unmount } = renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    unmount();
    rejectFn(new Error('late')); // catch arm runs with cancelled === true
    await Promise.resolve();
    expect(bridge.subscribe).toHaveBeenCalled();
  });
});

/**
 * RT-241 (D-B1) — `onSnapshot` reports every KNOWN projection: an `ok` read with
 * or without a drawer failure. A refused or failed read is UNKNOWN and is never
 * reported, so the drawer notice can never take its baseline from "no data".
 */
describe('useDrawerBannerState — onSnapshot (RT-241)', () => {
  it('reports the mapped failure from an ok read', async () => {
    const onSnapshot = vi.fn();
    const bridge = salesBridge({
      printer_failure: null,
      drawer_failure: { sale_id: 'sale-1', last_successful_open_at: null },
    });
    renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge, onSnapshot }),
    );
    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledWith({ sale_id: 'sale-1', last_successful_open_at: null });
    });
  });

  it('reports null from an ok read with no drawer failure', async () => {
    const onSnapshot = vi.fn();
    const bridge = salesBridge({ printer_failure: null, drawer_failure: null });
    renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge, onSnapshot }),
    );
    await waitFor(() => {
      expect(onSnapshot).toHaveBeenCalledWith(null);
    });
  });

  it.each([
    ['refused', () => Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const })],
    ['rejected', () => Promise.reject(new Error('ipc boom'))],
  ])('never reports a %s read', async (_label, subscribe) => {
    const onSnapshot = vi.fn();
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(subscribe),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    renderHook(() =>
      useDrawerBannerState({ intervalMs: 1000, _testSalesBridge: bridge, onSnapshot }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});
