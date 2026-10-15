import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ReceiptPreview } from '../ReceiptPreview';
import type { ReceiptsBridgeAPI, ReceiptsPreviewResponse } from '../../../../shared/bridge-api.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * Phase 5 (POS v3.5) — `<ReceiptPreview>` brought under the coverage net as it
 * is newly mounted into the find-sale flow. These tests pin the S2 behaviour
 * (loading / ready / error / close / zoom / no-bridge) so the wiring change is
 * proven not to alter the preview itself.
 */

function okBridge(html: string): ReceiptsBridgeAPI {
  const res: ReceiptsPreviewResponse = {
    kind: 'ok',
    preview: { html, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
  };
  return { preview: vi.fn().mockResolvedValue(res) } as unknown as ReceiptsBridgeAPI;
}

function refusedBridge(): ReceiptsBridgeAPI {
  const res: ReceiptsPreviewResponse = { kind: 'refused', reason: 'sale_not_found' };
  return { preview: vi.fn().mockResolvedValue(res) } as unknown as ReceiptsBridgeAPI;
}

function throwingBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn().mockRejectedValue(new Error('ipc down')),
  } as unknown as ReceiptsBridgeAPI;
}

describe('ReceiptPreview (Phase 5 wiring coverage)', () => {
  it('renders the dialog shell with the receipt-preview testid', () => {
    render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge('<p>slip</p>')} />,
    );
    expect(screen.getByTestId('receipt-preview')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'false');
  });

  it('shows the loading state before the bridge resolves', () => {
    // A never-resolving bridge keeps it in loading.
    const pending = { preview: vi.fn(() => new Promise(() => {})) } as unknown as ReceiptsBridgeAPI;
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={pending} />);
    expect(screen.getByText('جارٍ التحضير')).toBeInTheDocument();
  });

  it('renders the slip HTML once the preview resolves ok', async () => {
    render(
      <ReceiptPreview
        saleId="sale-42"
        onClose={() => {}}
        _testBridge={okBridge('<div>RECEIPT BODY</div>')}
      />,
    );
    const slip = await screen.findByRole('img', { name: 'معاينة الإيصال للعملية رقم sale-42' });
    expect(slip).toBeInTheDocument();
    expect(slip).toContainHTML('RECEIPT BODY');
  });

  it('shows the error state when the preview is refused', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={refusedBridge()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّرت معاينة الإيصال');
  });

  it('shows the error state when the bridge rejects', async () => {
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={throwingBridge()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows the error state when no bridge is available', async () => {
    // No injected bridge and no window.api → resolveBridge returns null → error.
    render(<ReceiptPreview saleId="sale-1" onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('invokes onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge('<p>x</p>')} />);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق المعاينة' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge('<p>x</p>')} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on a non-Escape key', () => {
    const onClose = vi.fn();
    render(<ReceiptPreview saleId="sale-1" onClose={onClose} _testBridge={okBridge('<p>x</p>')} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('toggles zoom via aria-pressed on the Zoom button', () => {
    render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge('<p>x</p>')} />,
    );
    const zoom = screen.getByRole('button', { name: 'زر التكبير' });
    expect(zoom).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(zoom);
    expect(zoom).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the Print button disabled (Slice 3 territory)', () => {
    render(
      <ReceiptPreview saleId="sale-1" onClose={() => {}} _testBridge={okBridge('<p>x</p>')} />,
    );
    expect(screen.getByRole('button', { name: 'طباعة' })).toBeDisabled();
  });
});
