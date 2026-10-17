import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type {
  ReceiptsBridgeAPI,
  ReceiptsPreviewResponse,
  SalesBridgeAPI,
  SaleSummary,
  SalesFindByNumberResponse,
} from '../../../../../shared/bridge-api';
import { expectNoAxeViolations } from '../../../../test-utils/axe-config';
import { SalesLookup } from '../SalesLookup';
import { SALES_COPY as C } from '../sales-copy';

/**
 * T451 / RT-500 (VN-S10 S10-3, G-6) — the Sales lookup, rendered.
 *
 * Ports the behaviour pinned for the screen it replaces (lookup idle /
 * searching / found / not found / empty / no bridge, the receipt preview, the
 * AD-10 reprint gate) and adds the G-6 states: the Arabic copy, the LTR code
 * field, the bdi meta line, and the reprint outcome notices.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { api?: unknown }).api;
});

const NUMBER = 'TERM-01-2026-10-15-000042';

function sale(overrides: Partial<SaleSummary> = {}): SaleSummary {
  return {
    sale_id: 'sale-1',
    sale_number: NUMBER,
    receipt_number: NUMBER,
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term1',
    terminal_label: 'POS-03',
    selling_operator_id: 'op1',
    selling_operator_display_name: 'منى عبد الرحمن',
    subtotal_minor: 1000,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [],
    finalized_at: '2026-10-15T10:00:00Z',
    latest_print_event: { outcome: 'success' } as SaleSummary['latest_print_event'],
    ...overrides,
  } as SaleSummary;
}

const FOUND: SalesFindByNumberResponse = { kind: 'ok', sale: sale() };
const MISSING: SalesFindByNumberResponse = { kind: 'refused', reason: 'sale_not_found' };

function salesBridge(
  respond: () => Promise<SalesFindByNumberResponse> = () => Promise.resolve(FOUND),
): SalesBridgeAPI & { findByNumber: ReturnType<typeof vi.fn> } {
  return { findByNumber: vi.fn(respond) } as unknown as SalesBridgeAPI & {
    findByNumber: ReturnType<typeof vi.fn>;
  };
}

function receiptsBridge(
  reprint: () => Promise<unknown> = () => Promise.resolve({ kind: 'ok' }),
  html = '<p>slip</p>',
): ReceiptsBridgeAPI & { reprint: ReturnType<typeof vi.fn>; preview: ReturnType<typeof vi.fn> } {
  const preview: ReceiptsPreviewResponse = {
    kind: 'ok',
    preview: { html, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
  };
  return {
    preview: vi.fn().mockResolvedValue(preview),
    reprint: vi.fn(reprint),
  } as unknown as ReceiptsBridgeAPI & {
    reprint: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
  };
}

const field = (): HTMLElement => screen.getByRole('textbox', { name: C.saleNumber });
const searchButton = (): HTMLElement => screen.getByRole('button', { name: C.search });

function search(value = NUMBER): void {
  fireEvent.change(field(), { target: { value } });
  fireEvent.click(searchButton());
}

function renderLookup(sales: SalesBridgeAPI, receipts?: ReceiptsBridgeAPI) {
  return render(
    <SalesLookup
      _testSalesBridge={sales}
      {...(receipts !== undefined ? { _testReceiptsBridge: receipts } : {})}
    />,
  );
}

describe('SalesLookup — the panel (G6-Sales)', () => {
  it('shows the panel «البحث عن بيع» with the code field and «بحث»', () => {
    renderLookup(salesBridge());
    const panel = screen.getByRole('region', { name: C.findHeading });
    expect(within(panel).getByRole('heading', { level: 2, name: C.findHeading })).toBeVisible();
    expect(field()).toHaveValue('');
    expect(searchButton()).toBeEnabled();
    expect(screen.queryByTestId('sale-not-found')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sale-result')).not.toBeInTheDocument();
  });

  it('the sale number is an LTR monospace code field', () => {
    renderLookup(salesBridge());
    expect(field()).toHaveAttribute('dir', 'ltr');
    expect(field()).toHaveClass('v5-sales-input--code');
    expect(field()).toHaveAttribute('autocomplete', 'off');
  });

  it('has no axe violations idle', async () => {
    const { container } = renderLookup(salesBridge());
    await expectNoAxeViolations(container);
  });
});

describe('SalesLookup — lookup behaviour', () => {
  it('does not look up an empty or blank query', () => {
    const sales = salesBridge();
    renderLookup(sales);
    fireEvent.click(searchButton());
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.click(searchButton());
    expect(sales.findByNumber).not.toHaveBeenCalled();
  });

  it('trims the number before it is sent', async () => {
    const sales = salesBridge();
    renderLookup(sales);
    search(`  ${NUMBER}  `);
    await screen.findByTestId('sale-result');
    expect(sales.findByNumber).toHaveBeenCalledWith({ sale_number: NUMBER });
  });

  it('submits with Enter in the field', async () => {
    const sales = salesBridge();
    renderLookup(sales);
    await userEvent.type(field(), `${NUMBER}{Enter}`);
    await screen.findByTestId('sale-result');
    expect(sales.findByNumber).toHaveBeenCalledTimes(1);
  });

  it('reads «جارٍ البحث…» and is disabled while a search runs, then sends one call', async () => {
    let settle: (r: SalesFindByNumberResponse) => void = () => undefined;
    const sales = salesBridge(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    renderLookup(sales);
    fireEvent.change(field(), { target: { value: NUMBER } });
    fireEvent.click(searchButton());
    const busy = await screen.findByRole('button', { name: C.searching });
    expect(busy).toBeDisabled();
    // A second submit before the first resolves is ignored (the in-flight guard).
    fireEvent.submit(field().closest('form') as HTMLFormElement);
    fireEvent.submit(field().closest('form') as HTMLFormElement);
    expect(sales.findByNumber).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle(FOUND);
      await Promise.resolve();
    });
    expect(await screen.findByTestId('sale-result')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: C.search })).toBeEnabled();
  });

  it('a search can follow a finished one', async () => {
    const sales = salesBridge();
    renderLookup(sales);
    search();
    await screen.findByTestId('sale-result');
    fireEvent.click(searchButton());
    await waitFor(() => {
      expect(sales.findByNumber).toHaveBeenCalledTimes(2);
    });
  });

  it('no-ops when no sales bridge is available', () => {
    render(<SalesLookup />);
    fireEvent.change(field(), { target: { value: NUMBER } });
    fireEvent.click(searchButton());
    expect(screen.queryByTestId('sale-not-found')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sale-result')).not.toBeInTheDocument();
    expect(searchButton()).toBeEnabled();
  });

  it('falls back to window.api.sales when no bridge is injected (production path)', async () => {
    const sales = salesBridge();
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = { sales };
    render(<SalesLookup />);
    search();
    expect(await screen.findByTestId('sale-result')).toBeInTheDocument();
    expect(sales.findByNumber).toHaveBeenCalledWith({ sale_number: NUMBER });
  });
});

describe('SalesLookup — not found (G6-SalesNotFound)', () => {
  it('shows «لم يُعثر على بيع بهذا الرقم.» in a neutral notice when the lookup is refused', async () => {
    renderLookup(salesBridge(() => Promise.resolve(MISSING)));
    search('TERM-01-2026-10-15-000999');
    const notice = await screen.findByTestId('sale-not-found');
    expect(notice).toHaveTextContent(C.notFound);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('data-tone', 'info');
    expect(screen.queryByTestId('sale-result')).not.toBeInTheDocument();
  });

  it('shows the same notice when the lookup rejects', async () => {
    renderLookup(salesBridge(() => Promise.reject(new Error('ipc'))));
    search();
    expect(await screen.findByTestId('sale-not-found')).toHaveTextContent(C.notFound);
  });

  it('keeps the typed number in the field so it can be corrected', async () => {
    renderLookup(salesBridge(() => Promise.resolve(MISSING)));
    search();
    await screen.findByTestId('sale-not-found');
    expect(field()).toHaveValue(NUMBER);
  });

  it('a later hit clears the notice, a later miss clears the sale', async () => {
    const answers = [MISSING, FOUND, MISSING];
    const sales = salesBridge(() => Promise.resolve(answers.shift() ?? MISSING));
    renderLookup(sales);
    search();
    await screen.findByTestId('sale-not-found');
    fireEvent.click(searchButton());
    await screen.findByTestId('sale-result');
    expect(screen.queryByTestId('sale-not-found')).not.toBeInTheDocument();
    fireEvent.click(searchButton());
    await screen.findByTestId('sale-not-found');
    expect(screen.queryByTestId('sale-result')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderLookup(salesBridge(() => Promise.resolve(MISSING)));
    search();
    await screen.findByTestId('sale-not-found');
    await expectNoAxeViolations(container);
  });
});

describe('SalesLookup — a found sale (G6-SalesFound)', () => {
  it('shows the sale number, the operator and terminal in bdi, and both buttons', async () => {
    renderLookup(salesBridge(), receiptsBridge());
    search();
    const result = await screen.findByTestId('sale-result');

    const number = within(result).getByText(NUMBER);
    expect(number.tagName).toBe('BDI');
    expect(number).toHaveAttribute('dir', 'ltr');

    const meta = result.querySelector('.v5-sales-meta') as HTMLElement;
    expect(meta.textContent).toBe('منى عبد الرحمن · POS-03');
    const parts = Array.from(meta.querySelectorAll('bdi'));
    expect(parts.map((b) => b.textContent)).toEqual(['منى عبد الرحمن', 'POS-03']);
    expect(parts[1]).toHaveAttribute('dir', 'ltr');

    expect(within(result).getByRole('button', { name: C.preview })).toBeEnabled();
    expect(within(result).getByRole('button', { name: C.reprint })).toBeEnabled();
    expect(within(result).queryByTestId('reprint-sent')).not.toBeInTheDocument();
    expect(within(result).queryByTestId('reprint-failed')).not.toBeInTheDocument();
  });

  it('an operator name in Latin script stays isolated in its own bdi', async () => {
    const answer: SalesFindByNumberResponse = {
      kind: 'ok',
      sale: sale({ selling_operator_display_name: 'Mona' }),
    };
    renderLookup(
      salesBridge(() => Promise.resolve(answer)),
      receiptsBridge(),
    );
    search();
    const result = await screen.findByTestId('sale-result');
    expect(within(result).getByText('Mona').tagName).toBe('BDI');
  });

  it('hides «إعادة طباعة الإيصال» when the latest print did not succeed (AD-10), keeping the preview', async () => {
    for (const latest of [
      { outcome: 'failure' },
      { outcome: 'pending' },
      undefined,
      null,
    ] as const) {
      const answer: SalesFindByNumberResponse = {
        kind: 'ok',
        sale: { ...sale(), latest_print_event: latest } as unknown as SaleSummary,
      };
      const { unmount } = renderLookup(
        salesBridge(() => Promise.resolve(answer)),
        receiptsBridge(),
      );
      search();
      await screen.findByTestId('sale-result');
      expect(screen.queryByRole('button', { name: C.reprint })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: C.preview })).toBeInTheDocument();
      unmount();
    }
  });

  it('has no axe violations', async () => {
    const { container } = renderLookup(salesBridge(), receiptsBridge());
    search();
    await screen.findByTestId('sale-result');
    await expectNoAxeViolations(container);
  });
});

describe('SalesLookup — the receipt preview', () => {
  it('opens the preview for the found sale, reading receipts.preview', async () => {
    const receipts = receiptsBridge();
    const answer: SalesFindByNumberResponse = {
      kind: 'ok',
      sale: sale({ sale_id: 'sale-99' as SaleSummary['sale_id'] }),
    };
    renderLookup(
      salesBridge(() => Promise.resolve(answer)),
      receipts,
    );
    expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
    search();
    fireEvent.click(await screen.findByRole('button', { name: C.preview }));
    const dialog = await screen.findByTestId('receipt-preview');
    expect(within(dialog).getByRole('heading', { name: 'معاينة الإيصال' })).toBeVisible();
    expect(await screen.findByRole('img', { name: /sale-99/ })).toBeInTheDocument();
    expect(receipts.preview).toHaveBeenCalledWith(expect.objectContaining({ sale_id: 'sale-99' }));
  });

  it('closes with «إغلاق المعاينة»', async () => {
    renderLookup(salesBridge(), receiptsBridge());
    search();
    fireEvent.click(await screen.findByRole('button', { name: C.preview }));
    await screen.findByTestId('receipt-preview');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق المعاينة' }));
    await waitFor(() => {
      expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
    });
  });

  it('a new lookup closes an open preview', async () => {
    renderLookup(salesBridge(), receiptsBridge());
    search();
    fireEvent.click(await screen.findByRole('button', { name: C.preview }));
    await screen.findByTestId('receipt-preview');
    fireEvent.click(searchButton());
    await screen.findByTestId('sale-result');
    expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
  });

  it('shows no English anywhere in the open preview', async () => {
    renderLookup(salesBridge(), receiptsBridge());
    search();
    fireEvent.click(await screen.findByRole('button', { name: C.preview }));
    const dialog = await screen.findByTestId('receipt-preview');
    await screen.findByRole('img');
    const text = [
      dialog.textContent,
      ...Array.from(dialog.querySelectorAll('[aria-label],[title]')).map(
        (el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`,
      ),
    ].join(' ');
    // The slip is the engine's HTML (`<p>slip</p>`) and the slip's label still
    // carries the sale id (unchanged behaviour); nothing else is Latin.
    expect(text.replace('slip', '').replace('sale-1', '')).not.toMatch(/[A-Za-z]/);
  });
});

describe('SalesLookup — reprint (G6-SalesReprintSent / G6-SalesReprintFailed)', () => {
  async function foundWith(receipts: ReceiptsBridgeAPI): Promise<HTMLElement> {
    renderLookup(salesBridge(), receipts);
    search();
    return screen.findByTestId('sale-result');
  }

  it('sends the sale id with a fresh key and shows the neutral «أُرسل الإيصال للطابعة.»', async () => {
    const receipts = receiptsBridge();
    const result = await foundWith(receipts);
    fireEvent.click(within(result).getByRole('button', { name: C.reprint }));
    const notice = await within(result).findByTestId('reprint-sent');
    expect(notice).toHaveTextContent(C.reprintSent);
    expect(notice).toHaveAttribute('role', 'status');
    // Sent, not proven printed: neither the success tone nor the word «طُبع».
    expect(notice).toHaveAttribute('data-tone', 'info');
    expect(result).not.toHaveTextContent('طُبع');
    expect(receipts.reprint).toHaveBeenCalledWith({
      sale_id: 'sale-1',
      idempotency_key: expect.any(String) as string,
    });
    expect(within(result).queryByTestId('reprint-failed')).not.toBeInTheDocument();
  });

  it.each([
    ['refuses', () => Promise.resolve({ kind: 'refused', reason: 'printer_unavailable' })],
    ['rejects', () => Promise.reject(new Error('ipc'))],
  ])(
    'shows the warning «تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.» when the reprint %s',
    async (_n, answer) => {
      const receipts = receiptsBridge(answer);
      const result = await foundWith(receipts);
      fireEvent.click(within(result).getByRole('button', { name: C.reprint }));
      const notice = await within(result).findByTestId('reprint-failed');
      expect(notice).toHaveTextContent(C.reprintFailed);
      expect(notice).toHaveAttribute('data-tone', 'warning');
      expect(within(result).queryByTestId('reprint-sent')).not.toBeInTheDocument();
      // The button is back so the operator can retry.
      expect(within(result).getByRole('button', { name: C.reprint })).toBeEnabled();
    },
  );

  it('a new lookup clears the previous reprint notice', async () => {
    const result = await foundWith(receiptsBridge());
    fireEvent.click(within(result).getByRole('button', { name: C.reprint }));
    await within(result).findByTestId('reprint-sent');
    fireEvent.click(searchButton());
    const again = await screen.findByTestId('sale-result');
    expect(within(again).queryByTestId('reprint-sent')).not.toBeInTheDocument();
  });

  it('the sent and failed states have no axe violations', async () => {
    let ok = true;
    const receipts = receiptsBridge(() =>
      Promise.resolve(ok ? { kind: 'ok' } : { kind: 'refused', reason: 'printer_unavailable' }),
    );
    renderLookup(salesBridge(), receipts);
    search();
    const result = await screen.findByTestId('sale-result');
    fireEvent.click(within(result).getByRole('button', { name: C.reprint }));
    await within(result).findByTestId('reprint-sent');
    await expectNoAxeViolations(document.body);
    ok = false;
    fireEvent.click(within(result).getByRole('button', { name: C.reprint }));
    await within(result).findByTestId('reprint-failed');
    await expectNoAxeViolations(document.body);
  });
});
