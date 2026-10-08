/**
 * RT-23 — checkout shows EGP, never the generic currency sign `¤`.
 *
 * POS-Pulse is EGP-only (`shared/money.ts`: `CurrencyCode = 'EGP'`). The amount
 * due and the V5 Sale already render through `money.format` (`15.00 EGP`);
 * these checks keep every other checkout amount and label on the same unit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { formatCheckoutMoney } from '../format-checkout-money';
import { CashEntry } from '../CashEntry';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry';
import { VoucherEntry } from '../VoucherEntry';

afterEach(cleanup);

describe('formatCheckoutMoney', () => {
  it.each([
    [1500, '15.00 EGP'],
    [0, '0.00 EGP'],
    [5, '0.05 EGP'],
    [12550, '125.50 EGP'],
  ])('formats %i minor units as %s', (minor, expected) => {
    expect(formatCheckoutMoney(minor)).toBe(expected);
  });

  it('renders a non-safe integer as an em dash, never a wrong number', () => {
    expect(formatCheckoutMoney(Number.MAX_SAFE_INTEGER + 1)).toBe('—');
    expect(formatCheckoutMoney(1.5)).toBe('—');
  });
});

/**
 * RT-240: the label is Arabic and names the unit as the amounts do, `EGP`,
 * isolated left-to-right so it never flips inside the Arabic label.
 */
function expectUnitLabel(text: string): void {
  const label = screen.getByText((_, el) => el?.tagName === 'LABEL' && el.textContent === text);
  const unit = label.querySelector('[dir="ltr"]');
  expect(unit).toHaveTextContent(/^EGP$/);
}

describe('checkout entry components show EGP', () => {
  it('cash suggested amounts carry EGP', () => {
    render(<CashEntry remainingBalanceMinor={1230} onConfirm={vi.fn()} />);
    expectUnitLabel('المبلغ المستلم (EGP)');
    expect(screen.getAllByRole('button', { name: /\d+\.\d{2} EGP/ }).length).toBeGreaterThan(0);
  });

  it('the external card amount and label carry EGP', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={12550} onConfirm={vi.fn()} />);
    expectUnitLabel('المبلغ المخصوم (EGP)');
    expect(screen.getByText('125.50 EGP')).toBeInTheDocument();
  });

  it('the voucher amount label carries EGP', () => {
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={vi.fn()} />,
    );
    expectUnitLabel('المبلغ المطبّق (EGP)');
  });
});

// In an RTL screen, `15.00 EGP` only stays in reading order inside an LTR
// container (FR-21 / D-006); without one it renders as `EGP 15.00`.
describe('EGP amounts stay left-to-right in the RTL checkout', () => {
  function expectEveryEgpAmountIsLtr(root: HTMLElement): void {
    const amounts = Array.from(root.querySelectorAll('*')).filter(
      (el) =>
        el.children.length === 0 &&
        /\d\.\d{2}/.test(el.textContent) &&
        /EGP/.test(el.parentElement?.textContent ?? ''),
    );
    expect(amounts.length).toBeGreaterThan(0);
    for (const el of amounts) {
      expect(el.closest('[dir="ltr"]'), el.textContent).not.toBeNull();
    }
  }

  it('in the order summary', async () => {
    const { PaymentCartSummary } = await import('../PaymentCartSummary');
    const { container } = render(
      <div dir="rtl">
        <PaymentCartSummary
          envelope={
            {
              subtotal_minor: 1500,
              lines: [
                { line_id: 'l-1', display_name: 'بنادول', quantity: 1, line_subtotal_minor: 1500 },
              ],
            } as never
          }
        />
      </div>,
    );
    expectEveryEgpAmountIsLtr(container);
  });

  it('in the cash change due', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const { container } = render(
      <div dir="rtl">
        <CashEntry remainingBalanceMinor={1250} onConfirm={vi.fn()} />
      </div>,
    );
    await userEvent.setup().type(screen.getByTestId('cash-entry-amount-input'), '15.00');
    expect(screen.getByTestId('cash-entry-change-due')).toHaveTextContent('2.50 EGP');
    const changeValue = screen
      .getByTestId('cash-entry-change-due')
      .querySelector('.cash-entry__change-due-value');
    expect(changeValue?.closest('[dir="ltr"]')).not.toBeNull();
    expectEveryEgpAmountIsLtr(container);
  });
});

// Source tripwire, not a rendering check: no checkout component may hard-code
// the generic sign again. The rendering checks above prove the output.
describe('checkout source tripwire', () => {
  it.each([
    'PaymentCartSummary.tsx',
    'CashEntry.tsx',
    'ExternalCardTerminalEntry.tsx',
    'VoucherEntry.tsx',
    'PaymentSurface.tsx',
  ])('%s contains no ¤', (file) => {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(src).not.toContain('¤');
  });
});
