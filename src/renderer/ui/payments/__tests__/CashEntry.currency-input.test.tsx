/**
 * CashEntry — cashier enters the natural currency amount the customer pays
 * (e.g. "12.50"), not raw minor units. On overpayment the change-due ("money
 * back to client") is the correct amount (shown by the ledger since RT-243
 * W1-C). Storage/math stay minor units.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { CashEntry } from '../CashEntry.js';

afterEach(cleanup);

// Slice-2 (display-only) mode: pass onConfirm; confirm fires with the parsed
// minor-unit amounts. remainingBalanceMinor = 1250 (a 12.50 EGP sale).
function renderCash(onConfirm = vi.fn()) {
  render(<CashEntry remainingBalanceMinor={1250} onConfirm={onConfirm} />);
  return { onConfirm };
}

describe('CashEntry — currency-amount input (EGP), not minor units', () => {
  it('accepts the typed currency amount "12.50" and enables confirm for an exact-cash sale', () => {
    renderCash();
    const input = screen.getByTestId('cash-entry-amount-input');
    fireEvent.change(input, { target: { value: '12.50' } });
    // Confirm must be enabled — 12.50 covers the 12.50 due.
    expect(screen.getByTestId('cash-entry-confirm')).not.toBeDisabled();
  });

  it('confirms an exact-cash sale with the correct minor units (1250) and zero change', () => {
    const { onConfirm } = renderCash();
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ amountAppliedMinor: 1250, changeDueMinor: 0 });
  });

  it('confirms an overpayment with its change: pays 15.00 for a 12.50 sale → 2.50 EGP (250)', () => {
    // The change is shown by the pinned ledger (RT-243 W1-C), not the entry.
    const { onConfirm } = renderCash();
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '15.00' } });
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ amountAppliedMinor: 1500, changeDueMinor: 250 });
  });

  it('does not confirm an under-tender: pays 10.00 for a 12.50 sale → confirm disabled', () => {
    const { onConfirm } = renderCash();
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '10.00' } });
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not confirm an in-progress bare-dot entry ("12.") — parses to null', () => {
    renderCash();
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '12.' } });
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
  });

  it('the amount label reads «المبلغ المستلم (EGP)» (Arabic only, RT-240), not minor units', () => {
    renderCash();
    expect(screen.getByLabelText('المبلغ المستلم (EGP)')).toBe(
      screen.getByTestId('cash-entry-amount-input'),
    );
  });
});
