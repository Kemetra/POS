import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { refusalMessage } from '../returns-messages.js';
import {
  fakeBridge,
  L1,
  L3,
  QUOTE,
  lookUpSale,
  pickAndQuote,
  renderReturns,
  resetStores,
  SALE_NUMBER,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — A1..A5: the renderer only asks; main decides keys, money and scope. */
afterEach(() => {
  cleanup();
  resetStores();
  vi.unstubAllGlobals();
});

describe('authority (A1, A2)', () => {
  it('sends only the sale number and the picked whole lines, never money or identity', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    await submitReturn(user);
    await screen.findByRole('heading', { name: 'نتيجة المرتجع' });

    const picked = { saleNumber: SALE_NUMBER, lines: [{ lineRef: L1, quantity: 1 }] };
    expect(bridge.lookup.mock.calls).toEqual([[{ saleNumber: SALE_NUMBER }]]);
    expect(bridge.quote.mock.calls).toEqual([[picked]]);
    expect(bridge.submit.mock.calls).toEqual([[picked]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalises Arabic-Indic digits in the sale number before asking main', async () => {
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user, ' T1-٠٠٠٠٤٢ ');
    expect(bridge.lookup).toHaveBeenCalledWith({ saleNumber: 'T1-000042' });
  });

  it('does not ask main for an empty sale number', async () => {
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), '   {Enter}');
    expect(bridge.lookup).not.toHaveBeenCalled();
    expect(screen.getByText('أدخل رقم البيع.')).toBeInTheDocument();
  });
});

describe('money comes from main (A3)', () => {
  it('shows the quoted line amount and total, not unit price × quantity', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    await pickAndQuote(user);
    const summary = screen.getByRole('region', { name: 'ملخص الاسترداد' });
    expect(within(summary).getAllByText('24.99 EGP')).toHaveLength(2);
    expect(within(summary).queryByText('25.00 EGP')).not.toBeInTheDocument();
    expect(within(summary).getByText(/نقدًا فقط/)).toBeInTheDocument();
  });
});

describe('a quoted line the lookup did not name (A3)', () => {
  it("shows a dash for its name but still main's amount", async () => {
    const bridge = fakeBridge();
    const stray = '0190a000-0000-7000-8000-0000000000ff';
    bridge.quote.mockResolvedValueOnce({
      kind: 'ok',
      quote: { ...QUOTE, lines: [{ lineRef: stray, quantity: 1, amountMinor: 2499 }] },
    });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    await pickAndQuote(user);
    const summary = screen.getByRole('region', { name: 'ملخص الاسترداد' });
    expect(within(summary).getByText('—')).toBeInTheDocument();
    expect(within(summary).getAllByText('24.99 EGP')).toHaveLength(2);
  });
});

describe('quantity bounds (A4)', () => {
  it('steps a quantity back down to zero, which disables the quote again', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    const minus = screen.getByRole('button', { name: 'إنقاص بانادول 500 مجم' });
    await user.click(minus);
    expect(screen.getByTestId(`qty-${L1}`)).toHaveTextContent('0');
    expect(minus).toBeDisabled();
    expect(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' })).toBeDisabled();
  });

  it('bounds a line at its returnable quantity and blocks a fully returned line', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    const quote = screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' });
    expect(quote).toBeDisabled();
    const plus = screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' });
    await user.click(plus);
    await user.click(plus);
    expect(plus).toBeDisabled();
    expect(screen.getByTestId(`qty-${L1}`)).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: 'زيادة فيتامين سي' })).not.toBeInTheDocument();
    expect(screen.getByText('أُرجع بالكامل')).toBeInTheDocument();
    expect(quote).toBeEnabled();
  });
});

describe('the submitted lines are the quoted lines (A5)', () => {
  it('discards the quote when quantities are edited, and re-quotes before submit', async () => {
    const both = [
      { lineRef: L1, quantity: 1 },
      { lineRef: L3, quantity: 1 },
    ];
    const bridge = fakeBridge();
    // Main's quote echoes the requested lines (S2 quoteReturn), priced by main.
    bridge.quote.mockResolvedValueOnce({ kind: 'ok', quote: QUOTE }).mockResolvedValueOnce({
      kind: 'ok',
      quote: { ...QUOTE, lines: both.map((l) => ({ ...l, amountMinor: 1 })), totalMinor: 2 },
    });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    await pickAndQuote(user);
    await user.click(screen.getByRole('button', { name: 'تعديل الكميات' }));
    expect(screen.queryByRole('button', { name: 'تأكيد الإرجاع' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'زيادة شاش طبي' }));
    await user.click(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
    await screen.findByRole('heading', { name: 'ملخص الاسترداد' });
    expect(bridge.quote).toHaveBeenLastCalledWith({ saleNumber: SALE_NUMBER, lines: both });
    await user.click(screen.getByRole('button', { name: 'تأكيد الإرجاع' }));
    expect(bridge.submit).toHaveBeenCalledWith({ saleNumber: SALE_NUMBER, lines: both });
  });
});

describe('who and when (A6, A7)', () => {
  it.each([
    ['a cashier session', { role: 'cashier' as const }, refusalMessage('role_denied')],
    ['the flag off', { flag: false }, refusalMessage('feature_disabled')],
    ['no returns bridge', { bridge: null }, 'المرتجعات غير متاحة في هذه النسخة من التطبيق.'],
  ])('with %s shows a notice, no lookup form, and calls nothing', (_, options, text) => {
    const bridge = fakeBridge();
    renderReturns({ bridge, ...options });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByLabelText('رقم البيع')).not.toBeInTheDocument();
    for (const fn of [bridge.lookup, bridge.list, bridge.resolve])
      expect(fn).not.toHaveBeenCalled();
  });
});
