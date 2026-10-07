/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed bridge spies trigger this rule on expect(...) assertions.
 */
/**
 * T451 — `<FindSaleReceipt>` surface (RED).
 *
 * A minimal find-sale-by-number surface that hosts the reprint affordance.
 * Looks a sale up via `sales.findByNumber`, renders the sale summary, and
 * mounts `<ReprintAffordance>` gated on whether the sale's latest print event
 * succeeded (AD-10). This is the receipt-affordance slot T451 calls for; the
 * fuller sale-search UI is 005's territory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { FindSaleReceipt } from '../../../../src/renderer/ui/receipts/FindSaleReceipt.js';
import type {
  ReceiptsBridgeAPI,
  SalesBridgeAPI,
  SaleSummary,
} from '../../../../src/shared/bridge-api.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';

function saleSummary(overrides: Partial<SaleSummary> = {}): SaleSummary {
  return {
    sale_id: 'sale-1' as SaleId,
    sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
    receipt_number: 'TERM-01-2026-05-27-000001',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'TERM-01',
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Mohamed Ahmed',
    subtotal_minor: 5500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [],
    finalized_at: '2026-05-27T10:00:06.000Z',
    latest_print_event: {
      print_event_id: 'pe-1',
      outcome: 'success',
      purpose: 'first_print',
      printed_at: '2026-05-27T10:00:07.000Z',
    },
    ...overrides,
  };
}

function salesBridge(response: () => ReturnType<SalesBridgeAPI['findByNumber']>): SalesBridgeAPI {
  return {
    read: vi.fn(),
    findByNumber: vi.fn(response),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

function receiptsBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn(),
    retryPrint: vi.fn(),
    reprint: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        print_event_id: 'pe-reprint-1',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T10:00:09.000Z',
        render_path: 'escpos_direct' as const,
      }),
    ),
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

describe('T451 — FindSaleReceipt surface', () => {
  it('looks up a sale by number and renders its summary + reprint affordance', async () => {
    const sales = salesBridge(() => Promise.resolve({ kind: 'ok', sale: saleSummary() }));
    render(<FindSaleReceipt _testSalesBridge={sales} _testReceiptsBridge={receiptsBridge()} />);

    await userEvent.type(
      screen.getByRole('textbox', { name: /sale number/i }),
      'TERM-01-2026-05-27-000001',
    );
    await userEvent.click(screen.getByRole('button', { name: /find/i }));

    expect(sales.findByNumber).toHaveBeenCalledWith({
      sale_number: 'TERM-01-2026-05-27-000001',
    });
    await waitFor(() => expect(screen.getByText('TERM-01-2026-05-27-000001')).toBeInTheDocument());
    // The reprint affordance is present because latest_print_event succeeded.
    expect(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' })).toBeInTheDocument();
  });

  it('hides the reprint affordance when the latest print did not succeed', async () => {
    const sales = salesBridge(() =>
      Promise.resolve({
        kind: 'ok',
        sale: saleSummary({
          latest_print_event: {
            print_event_id: 'pe-1',
            outcome: 'failure',
            purpose: 'first_print',
            printed_at: '2026-05-27T10:00:07.000Z',
          },
        }),
      }),
    );
    render(<FindSaleReceipt _testSalesBridge={sales} _testReceiptsBridge={receiptsBridge()} />);

    await userEvent.type(screen.getByRole('textbox', { name: /sale number/i }), 'X');
    await userEvent.click(screen.getByRole('button', { name: /find/i }));

    await waitFor(() => expect(screen.getByText('TERM-01-2026-05-27-000001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'إعادة طباعة الإيصال' })).not.toBeInTheDocument();
  });

  it('shows a not-found message on refusal', async () => {
    const sales = salesBridge(() => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }));
    render(<FindSaleReceipt _testSalesBridge={sales} _testReceiptsBridge={receiptsBridge()} />);

    await userEvent.type(screen.getByRole('textbox', { name: /sale number/i }), 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: /find/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not found/i));
    expect(screen.queryByRole('button', { name: 'إعادة طباعة الإيصال' })).not.toBeInTheDocument();
  });

  it('does not call findByNumber with an empty query', async () => {
    const sales = salesBridge(() => Promise.resolve({ kind: 'ok', sale: saleSummary() }));
    render(<FindSaleReceipt _testSalesBridge={sales} _testReceiptsBridge={receiptsBridge()} />);

    await userEvent.click(screen.getByRole('button', { name: /find/i }));
    expect(sales.findByNumber).not.toHaveBeenCalled();
  });

  it('is a no-op (no crash) when no sales bridge is available', async () => {
    // No _testSalesBridge and no window.api.sales → resolveSalesBridge null.
    render(<FindSaleReceipt />);
    await userEvent.type(screen.getByRole('textbox', { name: /sale number/i }), 'TERM-X');
    await userEvent.click(screen.getByRole('button', { name: /find/i }));
    // No sale rendered, no not-found message — the lookup short-circuited.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('falls back to window.api.sales when no bridge is injected (production path)', async () => {
    // No _testSalesBridge → resolveSalesBridge reads window.api.sales (the
    // production fallback arm). The injected bridge here IS the window one.
    const sales = salesBridge(() => Promise.resolve({ kind: 'ok', sale: saleSummary() }));
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = { sales };

    render(<FindSaleReceipt />);
    await userEvent.type(
      screen.getByRole('textbox', { name: /sale number/i }),
      'TERM-01-2026-05-27-000001',
    );
    await userEvent.click(screen.getByRole('button', { name: /find/i }));

    expect(sales.findByNumber).toHaveBeenCalledWith({
      sale_number: 'TERM-01-2026-05-27-000001',
    });
    await waitFor(() => expect(screen.getByText('TERM-01-2026-05-27-000001')).toBeInTheDocument());
  });

  it('shows not-found when findByNumber rejects (catch arm)', async () => {
    const sales = salesBridge(() => Promise.reject(new Error('ipc boom')));
    render(<FindSaleReceipt _testSalesBridge={sales} _testReceiptsBridge={receiptsBridge()} />);

    await userEvent.type(screen.getByRole('textbox', { name: /sale number/i }), 'TERM-X');
    await userEvent.click(screen.getByRole('button', { name: /find/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not found/i));
  });
});
