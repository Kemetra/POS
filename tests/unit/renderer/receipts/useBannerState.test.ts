/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed bridge spies trigger this rule on expect(...) assertions.
 */
/**
 * useBannerState — renderer poll hook for sales.subscribe(banner_state) (RED).
 *
 * Snapshot-subscribe (coordination §S3c mechanism note): the hook polls
 * `sales.subscribe({topic:'banner_state'})` on an interval and maps the
 * BannerState response to the `<PrinterFailureBanner>` prop shape
 * (PrinterFailureState | null). A refused / errored / non-printer-failure
 * response yields null. The interval is cleared on unmount.
 *
 * Bridge is injected (same posture as the components); production falls back
 * to window.api.sales.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import { useBannerState } from '../../../../src/renderer/ui/receipts/useBannerState.js';
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

describe('useBannerState', () => {
  it('maps a printer_failure BannerState to PrinterFailureState on first poll', async () => {
    const bridge = salesBridge({
      printer_failure: {
        sale_id: 'sale-1',
        failure_reason: 'printer_offline',
        has_successful_print: false,
      },
      drawer_failure: null,
    });
    const { result } = renderHook(() =>
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current).toEqual({
      sale_id: 'sale-1',
      failure_reason: 'printer_offline',
      has_successful_print: false,
    });
  });

  it('yields null for a kind:none BannerState', async () => {
    const bridge = salesBridge({ printer_failure: null, drawer_failure: null });
    const { result } = renderHook(() =>
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    // Allow the first poll to resolve.
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('yields null for a drawer_failure BannerState (printer banner only)', async () => {
    const bridge = salesBridge({
      printer_failure: null,
      drawer_failure: { sale_id: 'sale-1', last_successful_open_at: null },
    });
    const { result } = renderHook(() =>
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it('polls again on the interval (picks up a resolution)', async () => {
    // Real timers + a short interval: the first poll reports a failure, the
    // next interval poll reports it resolved → the hook clears.
    let call = 0;
    const bridge: SalesBridgeAPI = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(() => {
        call += 1;
        const banner: BannerState =
          call === 1
            ? {
                printer_failure: {
                  sale_id: 'sale-1',
                  failure_reason: 'printer_offline',
                  has_successful_print: false,
                },
                drawer_failure: null,
              }
            : { printer_failure: null, drawer_failure: null };
        return Promise.resolve({
          kind: 'ok' as const,
          subscription_token: 't',
          banner_state: banner,
        });
      }),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    // 200ms interval: long enough that waitFor reliably observes the first
    // poll's failure state before the next interval poll clears it.
    const { result } = renderHook(() =>
      useBannerState({ intervalMs: 200, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    }); // first poll → failure
    await waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: 2000 },
    ); // interval poll → resolved
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
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
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
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
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
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = (bridge.subscribe as ReturnType<typeof vi.fn>).mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect((bridge.subscribe as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(callsBefore);
  });

  it('returns null when no sales bridge is available (null resolve, no crash)', async () => {
    const { result } = renderHook(() => useBannerState({ intervalMs: 1000 }));
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it('uses the default interval when none is supplied (no options at all)', async () => {
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = {
      sales: salesBridge({
        printer_failure: {
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        },
        drawer_failure: null,
      }),
    };
    const { result } = renderHook(() => useBannerState());
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    delete (window as unknown as { api?: unknown }).api;
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
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
    );
    await waitFor(() => {
      expect(bridge.subscribe).toHaveBeenCalled();
    });
    unmount();
    // Resolve a failure AFTER unmount — the cancelled guard must swallow the
    // setState (no crash / act-warning); state stays null.
    resolveFn({
      kind: 'ok',
      subscription_token: 't',
      banner_state: {
        printer_failure: {
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        },
        drawer_failure: null,
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
      useBannerState({ intervalMs: 1000, _testSalesBridge: bridge }),
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
