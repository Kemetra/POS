/**
 * T044 — <ExternalCardTerminalEntry> exact-amount test (RT-243 W1-C: the amount
 * is a fact, not a field).
 *
 * Asserts:
 *   - The entry records exactly remainingBalanceMinor and shows that figure.
 *     There is no amount field, so neither an overpayment nor an underpayment can
 *     be entered (FR-006: no overpay and no underpay on a non-cash tender; main
 *     refuses either as `non_cash_overpayment_refused`, whose name MUST NOT
 *     appear in the renderer DOM).
 *   - Nothing to charge (zero, negative, unsafe) cannot be recorded.
 *   - No card-data fields exist (no PAN, CVV, expiry, cardholder name).
 *
 * References: FR-007 / FR-008 / FR-010, spec §"Tender scope" §"Cash overpayment
 * vs. non-cash overpayment", 08 I-10, freeze 15 S10.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';

afterEach(cleanup);

import { ExternalCardTerminalEntry } from '../../../../src/renderer/ui/payments/ExternalCardTerminalEntry.js';

function setup(props: Partial<ComponentProps<typeof ExternalCardTerminalEntry>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const remainingBalanceMinor = props.remainingBalanceMinor ?? 12550;
  const view = render(
    <ExternalCardTerminalEntry
      remainingBalanceMinor={remainingBalanceMinor}
      onConfirm={onConfirm}
    />,
  );
  const confirm = screen.getByTestId('external-card-confirm');
  return { ...view, onConfirm, confirm };
}

describe('<ExternalCardTerminalEntry> — records exactly what is owed', () => {
  it('shows the amount to key into the terminal, LTR and grouped', () => {
    setup({ remainingBalanceMinor: 125_050 });
    const value = screen.getByTestId('external-card-amount-value');
    expect(value).toHaveTextContent('1,250.50 EGP');
    expect(value).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('external-card-amount')).toHaveTextContent('المبلغ المُقتطع');
  });

  it('has no amount field: the amount cannot be over or under what is owed', () => {
    setup();
    expect(screen.queryByTestId('external-card-amount-input')).toBeNull();
    // The reference is the only text field.
    expect(screen.getAllByRole('textbox')).toEqual([
      screen.getByTestId('external-card-reference-input'),
    ]);
  });

  it('confirm is enabled for a positive amount owed', () => {
    const { confirm } = setup({ remainingBalanceMinor: 12550 });
    expect(confirm).toBeEnabled();
  });

  it('calls onConfirm with the exact remaining amount and null reference by default', () => {
    const onConfirm = vi.fn();
    const { confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      amountAppliedMinor: 12550,
      externalReference: null,
    });
  });

  it('never puts the structured reason `non_cash_overpayment_refused` in the DOM', () => {
    setup();
    expect(document.body.innerHTML).not.toContain('non_cash_overpayment_refused');
  });

  it('shows the M-P6 instruction: charge on the terminal, then record the result', () => {
    setup();
    expect(screen.getByTestId('external-card-instruction')).toHaveTextContent(
      'أكمل العملية على جهاز البطاقات، ثم سجّل النتيجة.',
    );
  });
});

describe('<ExternalCardTerminalEntry> — nothing to charge cannot be recorded', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('%s: confirm is disabled and onConfirm never fires', (_label, remaining) => {
    const onConfirm = vi.fn();
    const { confirm } = setup({ remainingBalanceMinor: remaining, onConfirm });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders an em dash, never a wrong figure, for an unsafe amount', () => {
    setup({ remainingBalanceMinor: Number.MAX_SAFE_INTEGER + 1 });
    expect(screen.getByTestId('external-card-amount-value').textContent).toBe('—');
  });
});

describe('<ExternalCardTerminalEntry> — no card data fields', () => {
  it('renders no PAN field', () => {
    setup();
    expect(screen.queryByLabelText(/PAN|card number|primary account/i)).toBeNull();
  });

  it('renders no CVV field', () => {
    setup();
    expect(screen.queryByLabelText(/CVV|CVC|security code|verification/i)).toBeNull();
  });

  it('renders no expiry field', () => {
    setup();
    expect(screen.queryByLabelText(/expiry|exp\.?|expiration/i)).toBeNull();
  });

  it('renders no cardholder name field', () => {
    setup();
    expect(screen.queryByLabelText(/cardholder|holder name/i)).toBeNull();
  });
});

describe('<ExternalCardTerminalEntry> — accessibility floor', () => {
  it('confirm button meets 44px touch-target floor', () => {
    const { confirm } = setup();
    // RT-238: a commit is the large control (56px), which keeps the 44px floor.
    expect(Number.parseFloat(confirm.style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(confirm.style.minHeight).toBe('56px');
  });

  it('ties an invalid reference to its error (aria-invalid + aria-describedby)', () => {
    setup();
    const input = screen.getByTestId('external-card-reference-input');
    expect(input).not.toHaveAttribute('aria-invalid');
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'صيغة المرجع غير صحيحة. استخدم حتى 6 أحرف إنجليزية كبيرة أو أرقام.',
    );
  });
});

describe('<ExternalCardTerminalEntry> — onBack', () => {
  it('renders the Back button when onBack is provided and invokes it on click', () => {
    const onBack = vi.fn();
    render(
      <ExternalCardTerminalEntry
        remainingBalanceMinor={12550}
        onConfirm={vi.fn()}
        onBack={onBack}
      />,
    );
    const backBtn = screen.getByTestId('external-card-back');
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not render the Back button when onBack is omitted', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={12550} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId('external-card-back')).toBeNull();
  });
});
