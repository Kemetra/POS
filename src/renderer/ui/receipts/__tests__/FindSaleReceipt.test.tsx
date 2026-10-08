import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { FindSaleReceipt } from '../FindSaleReceipt';
import type {
  ReceiptsBridgeAPI,
  ReceiptsPreviewResponse,
  SalesBridgeAPI,
  SaleSummary,
  SalesFindByNumberResponse,
} from '../../../../shared/bridge-api.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * Phase 5 (POS v3.5) — `<FindSaleReceipt>`.
 *
 * Existing behaviour (lookup idle/searching/found/not_found/empty/no-bridge) is
 * pinned here for the first time. The NEW behaviour is the receipt-preview
 * affordance: in the `found` state a "Preview receipt" control mounts the
 * existing `<ReceiptPreview>` (renderer-only, no new bridge call from this
 * component), and closing it unmounts the preview.
 */

function sale(overrides: Partial<SaleSummary> = {}): SaleSummary {
  return {
    sale_id: 'sale-1',
    sale_number: 'S-1001',
    receipt_number: 'R-1001',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term1',
    terminal_label: 'Till 1',
    selling_operator_id: 'op1',
    selling_operator_display_name: 'Mona',
    subtotal_minor: 1000,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [],
    finalized_at: '2026-06-19T10:00:00Z',
    latest_print_event: { outcome: 'success' } as SaleSummary['latest_print_event'],
    ...overrides,
  } as SaleSummary;
}

function salesBridge(res: SalesFindByNumberResponse): SalesBridgeAPI {
  return {
    findByNumber: vi.fn().mockResolvedValue(res),
  } as unknown as SalesBridgeAPI;
}

function previewBridge(html = '<p>slip</p>'): ReceiptsBridgeAPI {
  const res: ReceiptsPreviewResponse = {
    kind: 'ok',
    preview: { html, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
  };
  return {
    preview: vi.fn().mockResolvedValue(res),
    reprint: vi.fn().mockResolvedValue({ kind: 'ok' }),
  } as unknown as ReceiptsBridgeAPI;
}

function findSale(salesRes: SalesFindByNumberResponse, receipts?: ReceiptsBridgeAPI): void {
  render(
    <FindSaleReceipt
      _testSalesBridge={salesBridge(salesRes)}
      {...(receipts ? { _testReceiptsBridge: receipts } : {})}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Sale number/i), { target: { value: 'S-1001' } });
  fireEvent.click(screen.getByRole('button', { name: /^Find sale$/i }));
}

describe('FindSaleReceipt — lookup behaviour', () => {
  it('renders the find form in the idle state', () => {
    render(
      <FindSaleReceipt
        _testSalesBridge={salesBridge({ kind: 'refused', reason: 'sale_not_found' })}
      />,
    );
    expect(screen.getByLabelText(/Sale number/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Find sale$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Sale not found/i)).not.toBeInTheDocument();
  });

  it('does not look up an empty query', () => {
    const findByNumber = vi.fn().mockResolvedValue({ kind: 'ok', sale: sale() });
    const bridge = { findByNumber } as unknown as SalesBridgeAPI;
    render(<FindSaleReceipt _testSalesBridge={bridge} />);
    fireEvent.click(screen.getByRole('button', { name: /^Find sale$/i }));
    expect(findByNumber).not.toHaveBeenCalled();
  });

  it('shows the found sale summary when the lookup succeeds', async () => {
    findSale({ kind: 'ok', sale: sale() });
    expect(await screen.findByText('S-1001')).toBeInTheDocument();
    expect(screen.getByText(/Mona · Till 1/)).toBeInTheDocument();
  });

  it('shows "Sale not found" when the lookup is refused', async () => {
    findSale({ kind: 'refused', reason: 'sale_not_found' });
    expect(await screen.findByText(/Sale not found/i)).toBeInTheDocument();
  });

  it('shows "Sale not found" when the lookup rejects', async () => {
    const bridge = {
      findByNumber: vi.fn().mockRejectedValue(new Error('ipc')),
    } as unknown as SalesBridgeAPI;
    render(<FindSaleReceipt _testSalesBridge={bridge} />);
    fireEvent.change(screen.getByLabelText(/Sale number/i), { target: { value: 'S-1001' } });
    fireEvent.click(screen.getByRole('button', { name: /^Find sale$/i }));
    expect(await screen.findByText(/Sale not found/i)).toBeInTheDocument();
  });

  it('no-ops when no sales bridge is available', () => {
    // Omit the prop entirely (exactOptionalPropertyTypes); no window.api in jsdom
    // ⟹ resolveSalesBridge returns null ⟹ handleFind early-returns.
    render(<FindSaleReceipt />);
    fireEvent.change(screen.getByLabelText(/Sale number/i), { target: { value: 'S-1001' } });
    fireEvent.click(screen.getByRole('button', { name: /^Find sale$/i }));
    // No bridge → no crash, stays idle.
    expect(screen.queryByText(/Sale not found/i)).not.toBeInTheDocument();
  });
});

describe('FindSaleReceipt — receipt-preview affordance (Phase 5)', () => {
  it('does not show a receipt preview before the operator opens one', async () => {
    findSale({ kind: 'ok', sale: sale() }, previewBridge());
    await screen.findByText('S-1001');
    expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
  });

  it('offers a "Preview receipt" control only once a sale is found', () => {
    const receipts = previewBridge();
    render(
      <FindSaleReceipt
        _testSalesBridge={salesBridge({ kind: 'refused', reason: 'sale_not_found' })}
        _testReceiptsBridge={receipts}
      />,
    );
    // idle: no preview control
    expect(screen.queryByRole('button', { name: /Preview receipt/i })).not.toBeInTheDocument();
  });

  it('mounts <ReceiptPreview> for the found sale when "Preview receipt" is clicked', async () => {
    findSale(
      { kind: 'ok', sale: sale({ sale_id: 'sale-99' as SaleSummary['sale_id'] }) },
      previewBridge(),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Preview receipt/i }));
    const preview = await screen.findByTestId('receipt-preview');
    expect(preview).toBeInTheDocument();
    // It previews the looked-up sale (its slip is labelled with that sale id).
    expect(await screen.findByRole('img', { name: /sale sale-99/i })).toBeInTheDocument();
  });

  it('unmounts the preview when it is closed', async () => {
    findSale({ kind: 'ok', sale: sale() }, previewBridge());
    fireEvent.click(await screen.findByRole('button', { name: /Preview receipt/i }));
    await screen.findByTestId('receipt-preview');
    fireEvent.click(screen.getByRole('button', { name: /Close preview/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
    });
  });

  it('still shows the reprint affordance alongside the preview control', async () => {
    findSale({ kind: 'ok', sale: sale() }, previewBridge());
    expect(await screen.findByRole('button', { name: 'إعادة طباعة الإيصال' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview receipt/i })).toBeInTheDocument();
  });
});
