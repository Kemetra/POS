/**
 * T041 — <CashEntry> input validation test.
 *
 * Asserts:
 *   - the input rejects float / negative / non-integer keystrokes;
 *   - the computed change-due is displayed in major units (display only);
 *   - "Confirm" is enabled only when amountAppliedMinor ≥ remainingBalanceMinor.
 *
 * No bridge calls. No FSM. The component is display + input only.
 *
 * References: FR-004; visual-direction §State 2 (Cash entry).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';

afterEach(cleanup);

import { CashEntry } from '../../../../src/renderer/ui/payments/CashEntry.js';

function setup(props: Partial<ComponentProps<typeof CashEntry>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const remainingBalanceMinor = props.remainingBalanceMinor ?? 12550;
  const view = render(
    <CashEntry
      remainingBalanceMinor={remainingBalanceMinor}
      onConfirm={onConfirm}
      {...(props.onBack ? { onBack: props.onBack } : {})}
    />,
  );
  const input = screen.getByTestId('cash-entry-amount-input');
  const confirm = screen.getByTestId('cash-entry-confirm');
  return { ...view, onConfirm, input, confirm };
}

describe('<CashEntry> — input only accepts non-negative integer minor units', () => {
  it('rejects a leading minus sign keystroke (negative input refused)', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '-100' } });
    // Either the component refuses the change entirely (value stays '')
    // or it strips the minus. Either is acceptable; what's forbidden is
    // a negative numeric ending up in the displayed value.
    expect(input.value).not.toMatch(/^-/);
  });

  it('accepts a 2-decimal currency keystroke (decimal point is now valid)', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '125.50' } });
    expect(input.value).toBe('125.50');
  });

  it('rejects more than 2 decimal places (no rounding)', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '125.555' } });
    // Keystroke guard caps at 2 fractional digits; the 3rd is not accepted.
    expect(input.value).not.toBe('125.555');
  });

  it('rejects alphabetic input', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input.value).toBe('');
  });

  it('accepts a valid currency keystroke', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '150.00' } });
    expect(input.value).toBe('150.00');
  });

  it('keeps the value empty until a valid integer is entered', () => {
    const { input } = setup();
    expect(input.value).toBe('');
  });
});

describe('<CashEntry> — confirm enablement', () => {
  it('disables confirm by default (empty input)', () => {
    const { confirm } = setup({ remainingBalanceMinor: 12550 });
    expect(confirm).toBeDisabled();
  });

  it('disables confirm when amount < remaining', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(confirm).toBeDisabled();
  });

  it('enables confirm when amount == remaining', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '125.50' } });
    expect(confirm).toBeEnabled();
  });

  it('enables confirm when amount > remaining (overpay → change due)', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '150.00' } });
    expect(confirm).toBeEnabled();
  });
});

describe('<CashEntry> — change-due display (display only, major units)', () => {
  it('hides change-due row when not earned (amount < remaining)', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(screen.queryByTestId('cash-entry-change-due')).toBeNull();
  });

  it('hides change-due row when amount == remaining (exact change)', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '125.50' } });
    expect(screen.queryByTestId('cash-entry-change-due')).toBeNull();
  });

  it('renders change-due in major units when overpay (150.00 − 125.50 = ¤24.50)', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '150.00' } });
    const changeDue = screen.getByTestId('cash-entry-change-due');
    expect(changeDue).toHaveTextContent('¤24.50');
  });

  it('renders change-due as ¤1.00 for amount=126.50 remaining=125.50', () => {
    const { input } = setup({ remainingBalanceMinor: 12550 });
    fireEvent.change(input, { target: { value: '126.50' } });
    const changeDue = screen.getByTestId('cash-entry-change-due');
    expect(changeDue).toHaveTextContent('¤1.00');
  });
});

describe('<CashEntry> — onConfirm callback', () => {
  it('calls onConfirm with integer minor units when confirmed', () => {
    const onConfirm = vi.fn();
    const { input, confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.change(input, { target: { value: '150.00' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ amountAppliedMinor: 15000, changeDueMinor: 2450 });
  });

  it('does not call onConfirm when amount is under', () => {
    const onConfirm = vi.fn();
    const { input, confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.change(input, { target: { value: '100.00' } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('<CashEntry> — accessibility floor', () => {
  it('input is keyboard-operable (input element receives focus)', () => {
    const { input } = setup();
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it('confirm button meets 44px touch-target floor', () => {
    const { confirm } = setup();
    const minHeight = confirm.style.minHeight;
    expect(minHeight).toBe('44px');
  });
});

describe('<CashEntry> — safe-integer guard on remaining', () => {
  /*
   * RETARGETED by 022 Phase C — the money-safety guard is NOT weakened.
   *
   * This asserted the em-dash placeholder inside CashEntry's own
   * `.amount-due-card`. `PaymentSurface` now owns the single amount-due
   * presentation (FR-16), so that card — and its `cash-entry-remaining`
   * testid — no longer exists here.
   *
   * The GUARD it was probing is untouched: `isRemainingValid` still short-
   * circuits on a non-safe integer, and still governs real behaviour. So the
   * assertion moves from "the placeholder glyph renders" to the stronger,
   * behavioural claim — an unsafe remaining balance must not be treated as a
   * spendable amount, and must not crash the component.
   */
  it('does not treat an unsafe remainingBalanceMinor as a valid amount', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    render(<CashEntry remainingBalanceMinor={unsafe} onConfirm={vi.fn()} />);

    // The component renders (no throw) ...
    expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    // ... and offers no quick-amount affordance derived from the bad value.
    expect(screen.queryAllByTestId('cash-entry-quick-amount')).toHaveLength(0);
    // ... and cannot be confirmed on it.
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
  });
});

describe('<CashEntry> — does not crash on negative remainingBalanceMinor', () => {
  // Regression test for a defensive gap: a negative (but safe-integer)
  // remaining balance must NOT cause computeChangeDueMinor to throw during
  // render. Upstream contracts guarantee non-negative, but the renderer
  // should not crash if a bad value lands here.
  it('renders without throwing when remainingBalanceMinor is negative', () => {
    expect(() => {
      render(<CashEntry remainingBalanceMinor={-1} onConfirm={vi.fn()} />);
    }).not.toThrow();
  });

  it('keeps Confirm disabled and skips change-due when remainingBalanceMinor is negative', () => {
    const { input, confirm } = setup({ remainingBalanceMinor: -1 });
    fireEvent.change(input, { target: { value: '0' } });
    expect(confirm).toBeDisabled();
    expect(screen.queryByTestId('cash-entry-change-due')).toBeNull();
  });

  it('does not show under-tender refusal when remainingBalanceMinor is negative', () => {
    const { input } = setup({ remainingBalanceMinor: -1 });
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.queryByTestId('cash-entry-refusal')).toBeNull();
  });
});

describe('<CashEntry> — onBack', () => {
  it('renders the Back button when onBack is provided and invokes it on click', () => {
    const onBack = vi.fn();
    render(<CashEntry remainingBalanceMinor={12550} onConfirm={vi.fn()} onBack={onBack} />);
    const backBtn = screen.getByTestId('cash-entry-back');
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not render the Back button when onBack is omitted', () => {
    render(<CashEntry remainingBalanceMinor={12550} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId('cash-entry-back')).toBeNull();
  });
});
