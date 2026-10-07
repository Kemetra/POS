/**
 * T261 — `<PrinterFailureBanner>` subscribes to banner_state (RED).
 *
 * The banner observes `sales.subscribe({ topic: 'banner_state' })` for live
 * banner-state updates. This test asserts the component CALLS subscribe on
 * mount and HANDLES each response shape — it does NOT require live push
 * delivery (the push primitive is unbuilt; subscribe is the not_implemented
 * stub on current main, per coordination.md S3c preflight #2). A refused /
 * not_implemented subscribe must degrade gracefully: the banner still renders
 * from its injected `printFailure` prop and does not crash.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PrinterFailureBanner } from '../../../../src/renderer/ui/receipts/PrinterFailureBanner.js';
import type { ReceiptsBridgeAPI, SalesBridgeAPI } from '../../../../src/shared/bridge-api.js';

const FAILURE = {
  sale_id: 'sale-1',
  failure_reason: 'printer_offline' as const,
  has_successful_print: false,
};

function noopReceiptsBridge(): ReceiptsBridgeAPI {
  return { preview: vi.fn(), retryPrint: vi.fn() };
}

function salesBridgeStub(token: { kind: 'ok' | 'refused' }): Partial<SalesBridgeAPI> {
  return {
    subscribe: vi.fn(() =>
      Promise.resolve(
        token.kind === 'ok'
          ? { kind: 'ok' as const, subscription_token: 'sub-1' }
          : { kind: 'refused' as const, reason: 'not_implemented' as const },
      ),
    ),
    unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  };
}

afterEach(() => {
  cleanup();
  // Guard against window.api leaking into later tests if a test throws before
  // its own cleanup (CodeRabbit #281).
  delete (window as unknown as { api?: unknown }).api;
});

describe('T261 — PrinterFailureBanner subscribes to banner_state', () => {
  it('calls sales.subscribe({topic:banner_state}) on mount when a failure is present', async () => {
    const sales = salesBridgeStub({ kind: 'ok' });
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'banner_state' }),
      );
    });
  });

  it('degrades gracefully when subscribe refuses (not_implemented stub) — still renders, no crash', async () => {
    const sales = salesBridgeStub({ kind: 'refused' });
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    // The injected printFailure still drives the render even though the live
    // subscription is inert.
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('does not call subscribe when there is no failure (banner unmounted)', () => {
    const sales = salesBridgeStub({ kind: 'ok' });
    render(
      <PrinterFailureBanner
        printFailure={null}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    expect(sales.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount after a successful subscribe (token cleanup)', async () => {
    const sales = salesBridgeStub({ kind: 'ok' });
    const { unmount } = render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    // Let the subscribe promise resolve + set the token before unmount.
    await Promise.resolve();
    unmount();
    await waitFor(() => {
      expect(sales.unsubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ subscription_token: 'sub-1' }),
      );
    });
  });

  it('renders from window.api.sales when no _testSalesBridge is supplied (prod fallback)', async () => {
    const sales = salesBridgeStub({ kind: 'ok' });
    (window as unknown as { api: { sales: unknown } }).api = { sales };
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    // window.api cleanup is handled by afterEach (CodeRabbit #281).
  });

  it('does not crash when no sales bridge is available at all (null resolve)', () => {
    // No _testSalesBridge and no window.api.sales → resolveSalesBridge returns null.
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('swallows a subscribe REJECTION (IPC throw, not a refused response) — no crash', async () => {
    const sales: Partial<SalesBridgeAPI> = {
      subscribe: vi.fn(() => Promise.reject(new Error('ipc boom'))),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    await Promise.resolve();
    // The subscribe .catch arm held — the banner still renders.
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('swallows an unsubscribe REJECTION on unmount cleanup — no crash', async () => {
    const sales: Partial<SalesBridgeAPI> = {
      subscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const, subscription_token: 'sub-1' })),
      unsubscribe: vi.fn(() => Promise.reject(new Error('unsub boom'))),
    };
    const { unmount } = render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    await Promise.resolve();
    unmount();
    await waitFor(() => {
      expect(sales.unsubscribe).toHaveBeenCalled();
    });
    // The unsubscribe .catch arm held — no unhandled rejection / crash.
    expect(true).toBe(true);
  });

  it('unsubscribes a token that resolves AFTER unmount (orphan cleanup, CodeRabbit #281)', async () => {
    // subscribe resolves only after we trigger it — so cleanup runs first and
    // the late token would otherwise leak with no unsubscribe ever issued.
    let resolveSubscribe: (r: { kind: 'ok'; subscription_token: string }) => void = () => {};
    const sales: Partial<SalesBridgeAPI> = {
      subscribe: vi.fn(
        () =>
          new Promise<{ kind: 'ok'; subscription_token: string }>((resolve) => {
            resolveSubscribe = resolve;
          }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    };
    const { unmount } = render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    // Unmount BEFORE subscribe resolves → cancelled === true.
    unmount();
    // Now the subscription resolves late with a token — the orphan-cleanup arm
    // must immediately unsubscribe it.
    resolveSubscribe({ kind: 'ok', subscription_token: 'late-token' });
    await waitFor(() => {
      expect(sales.unsubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ subscription_token: 'late-token' }),
      );
    });
  });

  it('swallows a REJECTING orphan-cleanup unsubscribe (late token, unsubscribe throws)', async () => {
    // Same orphan path as above, but the late unsubscribe REJECTS. The inner
    // .catch on the cancelled-guard unsubscribe must hold so the late rejection
    // never surfaces as an unhandled promise rejection.
    let resolveSubscribe: (r: { kind: 'ok'; subscription_token: string }) => void = () => {};
    const sales: Partial<SalesBridgeAPI> = {
      subscribe: vi.fn(
        () =>
          new Promise<{ kind: 'ok'; subscription_token: string }>((resolve) => {
            resolveSubscribe = resolve;
          }),
      ),
      unsubscribe: vi.fn(() => Promise.reject(new Error('orphan unsub boom'))),
    };
    const { unmount } = render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
        _testSalesBridge={sales as SalesBridgeAPI}
      />,
    );
    await waitFor(() => {
      expect(sales.subscribe).toHaveBeenCalled();
    });
    unmount(); // cancelled === true before subscribe resolves
    resolveSubscribe({ kind: 'ok', subscription_token: 'late-token' });
    await waitFor(() => {
      expect(sales.unsubscribe).toHaveBeenCalledWith(
        expect.objectContaining({ subscription_token: 'late-token' }),
      );
    });
    // The inner .catch swallowed the rejection — no unhandled rejection / crash.
    expect(true).toBe(true);
  });
});
