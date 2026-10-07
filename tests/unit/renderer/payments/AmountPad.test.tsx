/**
 * POS v3.5 Phase 3 — <AmountPad> controlled cash keypad.
 *
 * A presentational, CONTROLLED keypad: the caller owns `valueMinor` and gets
 * updates via `onChange`. Digits fill from the right like a register
 * (1·0·0·0·0 ⇒ 100.00). Includes 0, 00, delete, and quick-amount buttons
 * sourced from the shared `quickAmounts` helper. It performs NO settlement
 * math (no change-due) — it only edits the entered amount.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AmountPad } from '../../../../src/renderer/ui/payments/AmountPad.js';

afterEach(cleanup);

describe('AmountPad', () => {
  it('shows the controlled value in major units, dir=ltr', () => {
    render(<AmountPad valueMinor={12550} onChange={vi.fn()} />);
    const display = screen.getByTestId('amount-pad-display');
    expect(display).toHaveTextContent('125.50');
    expect(display).toHaveAttribute('dir', 'ltr');
  });

  it('pressing a digit right-fills (value*10 + d)', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={5} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-key-7'));
    expect(onChange).toHaveBeenCalledWith(57);
  });

  it('pressing 0 appends a zero', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={5} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-key-0'));
    expect(onChange).toHaveBeenCalledWith(50);
  });

  it('pressing 00 appends two zeros (value*100)', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={5} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-key-00'));
    expect(onChange).toHaveBeenCalledWith(500);
  });

  it('delete removes the last digit (floor(value/10))', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={57} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-delete'));
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('treats a null/undefined value as 0 for editing', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-key-3'));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('caps the value at the 8-digit register ceiling', () => {
    const onChange = vi.fn();
    render(<AmountPad valueMinor={99999999} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('amount-pad-key-9'));
    // Already at ceiling — does not overflow past it.
    expect(onChange).toHaveBeenCalledWith(99999999);
  });

  it('has no quick-amount group: CashEntry owns the one set of chips (RT-238)', () => {
    render(<AmountPad valueMinor={0} onChange={vi.fn()} />);
    expect(document.querySelector('.amount-pad__quick')).toBeNull();
    expect(screen.queryByTestId(/amount-pad-quick-/)).not.toBeInTheDocument();
  });

  it('digit keys meet the 44px touch-target floor', () => {
    render(<AmountPad valueMinor={0} onChange={vi.fn()} />);
    const key = screen.getByTestId('amount-pad-key-1');
    expect(key.style.minHeight).toBe('44px');
  });

  it('displays 0.00 for a non-safe-integer value (defensive)', () => {
    render(<AmountPad valueMinor={Number.NaN} onChange={vi.fn()} />);
    // NaN is not null, so `current` is NaN; the formatter guards it to 0.00.
    expect(screen.getByTestId('amount-pad-display')).toHaveTextContent('0.00');
  });
});
