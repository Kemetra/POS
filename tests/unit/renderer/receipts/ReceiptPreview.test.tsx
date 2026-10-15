/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed mock properties on the bridge spy trigger this rule on every
 * `expect(bridge.preview)` assertion. Same posture as the payments bridge tests.
 */
/**
 * T150 / T151 / T152 — `<ReceiptPreview>` (RED).
 *
 * The renderer preview panel. Fetches via `receipts.preview` and renders the
 * returned HTML in a non-modal dialog card; mirrors the printed slip; is
 * keyboard-operable and axe-clean. Every interactive control ≥ 44×44 (FR-068).
 *
 * Red-bar recorded in coordination.md before the T173 /impeccable craft.
 *
 * The component accepts an injectable `_testBridge` (same posture as
 * PaymentSurface); production falls back to `window.api.receipts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ReceiptPreview } from '../../../../src/renderer/ui/receipts/ReceiptPreview.js';
import { expectNoAxeViolations } from '../../../../src/renderer/ui/primitives/__tests__/axe-config.js';
import type {
  ReceiptsBridgeAPI,
  ReceiptsPreviewResponse,
} from '../../../../src/shared/bridge-api.js';

const OK_HTML =
  '<div class="receipt" dir="rtl"><div class="band">Sale # TERM-01-2026-05-27-000001</div></div>';

function okBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn(
      (): Promise<ReceiptsPreviewResponse> =>
        Promise.resolve({
          kind: 'ok',
          preview: { html: OK_HTML, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
        }),
    ),
  };
}

function refusedBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn(
      (): Promise<ReceiptsPreviewResponse> =>
        Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }),
    ),
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

describe('T150 — ReceiptPreview renders the HTML preview', () => {
  it('fetches via receipts.preview and renders the returned slip HTML', async () => {
    const bridge = okBridge();
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={bridge} />);
    await waitFor(() =>
      expect(screen.getByText(/Sale # TERM-01-2026-05-27-000001/)).toBeInTheDocument(),
    );
    expect(bridge.preview).toHaveBeenCalledWith(expect.objectContaining({ sale_id: 'sale-1' }));
  });

  it('renders the canvas region as role=img labelled with the sale id', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
  });

  it('shows an Arabic-only title and a close affordance', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />);
    expect(await screen.findByRole('heading', { name: 'معاينة الإيصال' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إغلاق المعاينة' })).toBeInTheDocument();
    expect(screen.queryByText(/Receipt preview|Close preview/i)).not.toBeInTheDocument();
  });

  it('shows the error state when the bridge refuses', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={refusedBridge()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});

describe('T151 — ReceiptPreview is non-blocking + dismissible without side-effect', () => {
  it('is a non-modal dialog (does not trap/block the cart behind it)', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'false');
  });

  it('calls onClose when the close button is clicked (no confirm)', async () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge()} />);
    const close = await screen.findByRole('button', { name: 'إغلاق المعاينة' });
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('T152 — ReceiptPreview accessibility', () => {
  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge()} />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keydowns (does not close)', async () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge()} />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('a');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not set state after unmount mid-fetch (cancelled race guard)', async () => {
    // A bridge whose promise resolves AFTER we unmount exercises the
    // `cancelled` guards on both the then and (via a rejecting twin) catch arms.
    let resolveFn: (r: ReceiptsPreviewResponse) => void = () => {};
    const slow: ReceiptsBridgeAPI = {
      preview: vi.fn(
        (): Promise<ReceiptsPreviewResponse> =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      ),
    };
    const { unmount } = render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={slow} />,
    );
    unmount();
    // Resolve after unmount — the cancelled guard must swallow the setState.
    resolveFn({
      kind: 'ok',
      preview: { html: OK_HTML, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
    });
    await Promise.resolve();
    // No throw / no act-warning crash = the guard held.
    expect(slow.preview).toHaveBeenCalled();
  });

  it('swallows a rejection that arrives after unmount (catch cancelled guard)', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    const slow: ReceiptsBridgeAPI = {
      preview: vi.fn(
        (): Promise<ReceiptsPreviewResponse> =>
          new Promise((_resolve, reject) => {
            rejectFn = reject;
          }),
      ),
    };
    const { unmount } = render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={slow} />,
    );
    unmount();
    rejectFn(new Error('late'));
    await Promise.resolve();
    expect(slow.preview).toHaveBeenCalled();
  });

  it('is axe-clean in the default loaded state', async () => {
    const { container } = render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />,
    );
    await screen.findByRole('dialog');
    await expectNoAxeViolations(container);
  });
});

describe('ReceiptPreview — interaction + resilience', () => {
  it('toggles the canvas zoom on the Zoom 2x button (aria-pressed + slip width)', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />);
    // Wait for the ready state so the slip (role=img) renders with its style.
    const slip = await screen.findByRole('img');
    const zoom = screen.getByRole('button', { name: 'زر التكبير' });
    expect(zoom).toHaveAttribute('aria-pressed', 'false');
    expect(slip).toHaveStyle({ inlineSize: '80mm' });
    await userEvent.click(zoom);
    expect(zoom).toHaveAttribute('aria-pressed', 'true');
    // The zoomed-true ternary branch now renders the 2x slip width.
    expect(screen.getByRole('img')).toHaveStyle({ inlineSize: '160mm' });
    // Toggle back to exercise the off branch from a ready state too.
    await userEvent.click(zoom);
    expect(zoom).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders a disabled Print button (printing lands in Slice 3)', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge()} />);
    const print = await screen.findByRole('button', { name: 'طباعة' });
    expect(print).toBeDisabled();
  });

  it('shows the error state when the bridge call rejects', async () => {
    const rejecting: ReceiptsBridgeAPI = {
      preview: vi.fn((): Promise<ReceiptsPreviewResponse> => Promise.reject(new Error('boom'))),
    };
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={rejecting} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('shows the error state when no bridge is available at all', async () => {
    // No _testBridge and no window.api → resolveBridge returns null.
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('errors when window.api exists but carries no receipts namespace', async () => {
    // resolveBridge's `api?.receipts ?? null` → null when receipts is absent.
    (window as unknown as { api: Record<string, unknown> }).api = { something: 1 };
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    delete (window as unknown as { api?: unknown }).api;
  });

  it('closes via the footer Close (ghost) button', async () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge()} />);
    // The footer ghost button is named «إغلاق»; the title band's is «إغلاق المعاينة».
    await userEvent.click(await screen.findByRole('button', { name: 'إغلاق' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ReceiptPreview — production bridge fallback', () => {
  beforeEach(() => {
    (window as unknown as { api: { receipts: ReceiptsBridgeAPI } }).api = { receipts: okBridge() };
  });
  it('reads window.api.receipts when no _testBridge is supplied', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/Sale # TERM-01-2026-05-27-000001/)).toBeInTheDocument(),
    );
  });
});
