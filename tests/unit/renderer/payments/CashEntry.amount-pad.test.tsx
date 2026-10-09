/**
 * POS v3.5 Phase 3 — <CashEntry> ⇄ keypad integration (RT-243 W1-C: the
 * legacy AmountPad is now the V5 `CashKeypad`).
 *
 * The keypad is a VIEW over CashEntry's single `rawInput` source of truth:
 * pressing pad keys edits the same amount the text input and confirm/bridge
 * logic read. These tests exercise that shared-state round-trip (no second
 * amount-of-record), and the quick-amount → exact-total path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { CashEntry } from '../../../../src/renderer/ui/payments/CashEntry.js';

afterEach(cleanup);

describe('<CashEntry> — keypad shared-state integration', () => {
  it('pressing pad digits builds the amount and reflects in the text input', () => {
    render(<CashEntry remainingBalanceMinor={500} onConfirm={vi.fn()} />);
    // Build 1·2·5·5·0 via the pad → 12550 minor units.
    fireEvent.click(screen.getByTestId('cash-keypad-key-1'));
    fireEvent.click(screen.getByTestId('cash-keypad-key-2'));
    fireEvent.click(screen.getByTestId('cash-keypad-key-5'));
    fireEvent.click(screen.getByTestId('cash-keypad-key-5'));
    fireEvent.click(screen.getByTestId('cash-keypad-key-0'));
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    // Merge reconciliation: after the currency-input fix, `rawInput` holds a
    // currency-amount string ("125.50"), not raw minor units. The keypad emits
    // minor units (12550) which CashEntry formats via formatMinorToInput.
    expect(input.value).toBe('125.50');
  });

  it('a pad-built sufficient amount enables Confirm (shared gating)', () => {
    render(<CashEntry remainingBalanceMinor={5} onConfirm={vi.fn()} />);
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('cash-keypad-key-9')); // 9 >= 5
    expect(screen.getByTestId('cash-entry-confirm')).not.toBeDisabled();
  });

  it('choosing the exact-total quick amount fills the amount and presses that chip', () => {
    render(<CashEntry remainingBalanceMinor={19925} onConfirm={vi.fn()} />);
    // RT-238: one chip group lives in CashEntry; «بالضبط» fills the exact total.
    const exact = screen.getByRole('button', { name: 'بالضبط' });
    fireEvent.click(exact);
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    // Currency-amount string contract (see note above): 19925 minor → "199.25".
    expect(input.value).toBe('199.25');
    expect(exact).toHaveAttribute('aria-pressed', 'true');
  });

  it('an overpay quick amount is reported to the ledger and confirms with its change', () => {
    const onDraftChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CashEntry
        remainingBalanceMinor={19925}
        onConfirm={onConfirm}
        onDraftChange={onDraftChange}
      />,
    );
    // 200.00 is a quick-amount chip (20000 minor); change due = 20000 − 19925 = 75.
    fireEvent.click(screen.getByRole('button', { name: /^200\.00/ }));
    expect(onDraftChange).toHaveBeenLastCalledWith(20000);
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ amountAppliedMinor: 20000, changeDueMinor: 75 });
  });
});
