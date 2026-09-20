/**
 * T044 — <ExternalCardTerminalEntry> overpayment refusal test.
 *
 * Asserts:
 *   - The amount field defaults to remainingBalanceMinor (exact-amount cashier flow).
 *   - The component refuses overpayment (amount > remaining) with generic copy
 *     that the cashier maps to the FR-006 audit category `non_cash_overpayment_refused`.
 *   - The structured reason name `non_cash_overpayment_refused` MUST NOT appear
 *     in the renderer DOM.
 *   - No card-data fields exist (no PAN, CVV, expiry, cardholder name).
 *
 * References: FR-007 / FR-008 / FR-010, spec §"Tender scope" §"Cash overpayment
 * vs. non-cash overpayment", visual-direction §State 3.
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
  const input = screen.getByTestId('external-card-amount-input');
  const confirm = screen.getByTestId('external-card-confirm');
  return { ...view, onConfirm, input, confirm };
}

describe('<ExternalCardTerminalEntry> — defaults to exact amount', () => {
  it('amount field defaults to remainingBalanceMinor', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    expect(input.value).toBe('125.50');
  });

  it('confirm is enabled when amount equals remaining (default)', () => {
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
});

describe('<ExternalCardTerminalEntry> — refuses overpayment', () => {
  it('disables confirm when amount > remaining', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '20000' } });
    expect(confirm).toBeDisabled();
  });

  it('shows generic "amount must be exact" copy when overpay attempted', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '20000' } });
    expect(screen.getByTestId('external-card-refusal')).toHaveTextContent(/مطابقاً تماماً|يطابق/);
  });

  it('does not leak the structured reason `non_cash_overpayment_refused` to the DOM', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '20000' } });
    expect(document.body.innerHTML).not.toContain('non_cash_overpayment_refused');
  });

  it('does not call onConfirm when amount > remaining', () => {
    const onConfirm = vi.fn();
    const { input, confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.change(input, { target: { value: '20000' } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables confirm when amount < remaining (no underpay on non-cash)', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(confirm).toBeDisabled();
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

  it('amount input is the only numeric data input', () => {
    setup();
    const inputs = screen.getAllByRole('textbox');
    // Amount + optional reference field at most.
    expect(inputs.length).toBeLessThanOrEqual(2);
  });
});

describe('<ExternalCardTerminalEntry> — accessibility floor', () => {
  it('confirm button meets 44px touch-target floor', () => {
    const { confirm } = setup();
    expect(confirm.style.minHeight).toBe('44px');
  });
});

describe('<ExternalCardTerminalEntry> — safe-integer guard on remaining', () => {
  it('renders the em-dash in instructional copy when remainingBalanceMinor is unsafe', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    render(<ExternalCardTerminalEntry remainingBalanceMinor={unsafe} onConfirm={vi.fn()} />);
    // formatMinorUnits returns '—' for unsafe input; the instructional copy
    // includes it.
    expect(document.body.textContent).toContain('—');
  });

  it('starts with empty amount input when remainingBalanceMinor is unsafe', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    render(<ExternalCardTerminalEntry remainingBalanceMinor={unsafe} onConfirm={vi.fn()} />);
    const input = screen.getByTestId('external-card-amount-input');
    expect(input.value).toBe('');
  });

  it('refuses an under-amount with the dedicated under-amount refusal copy', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(screen.getByTestId('external-card-refusal-underpay')).toHaveTextContent(/يطابق/);
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
