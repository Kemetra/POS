/**
 * POS v3.5 Phase 3 — <CashEntry> ⇄ <AmountPad> integration.
 *
 * The AmountPad is a VIEW over CashEntry's single `rawInput` source of truth:
 * pressing pad keys edits the same amount the text input and confirm/bridge
 * logic read. These tests exercise that shared-state round-trip (no second
 * amount-of-record), and the quick-amount → exact-total path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { CashEntry } from '../../../../src/renderer/ui/payments/CashEntry.js';

afterEach(cleanup);

describe('<CashEntry> — AmountPad shared-state integration', () => {
  it('pressing pad digits builds the amount and reflects in the text input', () => {
    render(<CashEntry remainingBalanceMinor={500} onConfirm={vi.fn()} />);
    // Build 1·2·5·5·0 via the pad → 12550 minor units.
    fireEvent.click(screen.getByTestId('amount-pad-key-1'));
    fireEvent.click(screen.getByTestId('amount-pad-key-2'));
    fireEvent.click(screen.getByTestId('amount-pad-key-5'));
    fireEvent.click(screen.getByTestId('amount-pad-key-5'));
    fireEvent.click(screen.getByTestId('amount-pad-key-0'));
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    // Merge reconciliation: after the currency-input fix, `rawInput` holds a
    // currency-amount string ("125.50"), not raw minor units. AmountPad emits
    // minor units (12550) which CashEntry formats via formatMinorToInput.
    expect(input.value).toBe('125.50');
  });

  it('a pad-built sufficient amount enables Confirm (shared gating)', () => {
    render(<CashEntry remainingBalanceMinor={5} onConfirm={vi.fn()} />);
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('amount-pad-key-9')); // 9 >= 5
    expect(screen.getByTestId('cash-entry-confirm')).not.toBeDisabled();
  });

  it('choosing the exact-total quick amount fills the amount and shows zero change', () => {
    render(<CashEntry remainingBalanceMinor={19925} onConfirm={vi.fn()} />);
    // RT-238: one chip group lives in CashEntry; «بالضبط» fills the exact total.
    fireEvent.click(screen.getByRole('button', { name: 'بالضبط' }));
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    // Currency-amount string contract (see note above): 19925 minor → "199.25".
    expect(input.value).toBe('199.25');
    // Exact amount → no change-due row.
    expect(screen.queryByTestId('cash-entry-change-due')).toBeNull();
  });

  it('an overpay quick amount drives the animated change-due (EGP shown)', () => {
    render(<CashEntry remainingBalanceMinor={19925} onConfirm={vi.fn()} />);
    // 200.00 is a quick-amount chip (20000 minor); change due = 20000 − 19925 = 75 → 0.75 EGP.
    fireEvent.click(screen.getByRole('button', { name: /^200\.00/ }));
    const changeDue = screen.getByTestId('cash-entry-change-due');
    expect(changeDue).toHaveTextContent('0.75 EGP');
  });
});
