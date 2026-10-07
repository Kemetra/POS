/**
 * RT-259 (UX-08) — the tender amount / reference inputs accept Arabic-Indic
 * (U+0660..) and Persian (U+06F0..) digits and normalize them to ASCII, so a
 * cashier on an Arabic keyboard layout sees their keystrokes appear. Thousands
 * separators are NOT reinterpreted: money is never silently re-read.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CashEntry } from '../CashEntry.js';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry.js';
import { VoucherEntry } from '../VoucherEntry.js';

afterEach(cleanup);

const OK = { kind: 'ok' as const, tender_line_id: 'tl-1', applied_at: '2026-10-07T09:01:00.000Z' };

function change(testId: string, value: string): HTMLInputElement {
  const input = screen.getByTestId<HTMLInputElement>(testId);
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('RT-259 — CashEntry amount input', () => {
  function renderCash() {
    const tenderApply = vi.fn(() => Promise.resolve(OK));
    render(
      <CashEntry
        remainingBalanceMinor={20_000}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
      />,
    );
    return tenderApply;
  }

  it('«١٢٣٫٥٠» shows "123.50" and applies 12350 minor', async () => {
    const tenderApply = renderCash();
    const input = change('cash-entry-amount-input', '١٢٣٫٥٠');
    expect(input.value).toBe('123.50');
    await act(async () => {
      fireEvent.click(screen.getByTestId('cash-entry-confirm'));
      await Promise.resolve();
    });
    expect(tenderApply).toHaveBeenCalledWith(
      expect.objectContaining({ tender_type: 'cash', amount_applied_minor: 12_350 }),
    );
  });

  it('Persian «۵۰» shows "50"', () => {
    renderCash();
    expect(change('cash-entry-amount-input', '۵۰').value).toBe('50');
  });

  it('rejects the Arabic thousands separator: «١٬٠٠٠» leaves the field unchanged', () => {
    renderCash();
    change('cash-entry-amount-input', '12');
    expect(change('cash-entry-amount-input', '١٬٠٠٠').value).toBe('12');
  });

  it('still rejects the ASCII comma', () => {
    renderCash();
    expect(change('cash-entry-amount-input', '1,000').value).toBe('');
  });
});

describe('RT-259 — ExternalCardTerminalEntry inputs', () => {
  function renderCard() {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={7_500} onConfirm={vi.fn()} />);
  }

  it('amount «٥٠٫٠٠» shows "50.00"', () => {
    renderCard();
    expect(change('external-card-amount-input', '٥٠٫٠٠').value).toBe('50.00');
  });

  it('amount rejects the Arabic thousands separator', () => {
    renderCard();
    const before = screen.getByTestId<HTMLInputElement>('external-card-amount-input').value;
    expect(change('external-card-amount-input', '١٬٠٠٠').value).toBe(before);
  });

  it('reference «T١A٢» becomes "T1A2" (digits only; stays [A-Z0-9]{0,6})', () => {
    renderCard();
    expect(change('external-card-reference-input', 'T١A٢').value).toBe('T1A2');
    expect(screen.queryByTestId('external-card-reference-error')).toBeNull();
  });

  it('reference does not map the decimal separator: «T٫1» stays invalid', () => {
    renderCard();
    change('external-card-reference-input', 'T٫1');
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
  });
});

describe('RT-259 — VoucherEntry amount input', () => {
  function renderVoucher() {
    render(
      <VoucherEntry
        remainingBalanceMinor={20_000}
        paymentAttemptId="pa-1"
        tenderApply={vi.fn(() => Promise.resolve(OK))}
      />,
    );
  }

  it('«١٢٣٫٥٠» shows "123.50"', () => {
    renderVoucher();
    expect(change('voucher-entry-amount-input', '١٢٣٫٥٠').value).toBe('123.50');
  });

  it('Persian «۵۰» shows "50"', () => {
    renderVoucher();
    expect(change('voucher-entry-amount-input', '۵۰').value).toBe('50');
  });

  it('rejects the Arabic thousands separator', () => {
    renderVoucher();
    change('voucher-entry-amount-input', '12');
    expect(change('voucher-entry-amount-input', '١٬٠٠٠').value).toBe('12');
  });
});
