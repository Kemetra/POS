/**
 * T042 — <CashEntry> under-tender refusal test.
 *
 * Asserts: when amountAppliedMinor < remainingBalanceMinor and the cashier
 * attempts to confirm, the surface refuses with a generic, non-disclosing
 * message ("amount is not enough" — wording from spec FR-005 / US1-AS3).
 *
 * The structured FR-006 reason name `tender_underpaid` MUST NOT appear in
 * the renderer DOM — that name lives in the audit payload only (Slice 3).
 *
 * References: FR-005, FR-022, US1-AS3, NFR-003 (generic refusal UX).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

import { CashEntry } from '../../../../src/renderer/ui/payments/CashEntry.js';

function setup(remainingBalanceMinor: number) {
  const onConfirm = vi.fn();
  const view = render(
    <CashEntry remainingBalanceMinor={remainingBalanceMinor} onConfirm={onConfirm} />,
  );
  const input = screen.getByTestId('cash-entry-amount-input');
  const confirm = screen.getByTestId('cash-entry-confirm');
  return { ...view, onConfirm, input, confirm };
}

describe('<CashEntry> — under-tender refusal', () => {
  it('does not call onConfirm when amount is under remaining', () => {
    const { onConfirm, input, confirm } = setup(12550);
    fireEvent.change(input, { target: { value: '100.00' } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows generic "amount is not enough" copy when amount is under remaining', () => {
    const { input } = setup(12550);
    fireEvent.change(input, { target: { value: '100.00' } });
    // Generic copy from FR-005 / US1-AS3; bridge-internal `tender_underpaid` MUST NOT appear.
    expect(screen.getByTestId('cash-entry-refusal')).toHaveTextContent(/غير كافٍ/);
  });

  it('hides the refusal copy when amount becomes sufficient again', () => {
    const { input } = setup(12550);
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(screen.queryByTestId('cash-entry-refusal')).not.toBeNull();
    fireEvent.change(input, { target: { value: '125.50' } });
    expect(screen.queryByTestId('cash-entry-refusal')).toBeNull();
  });

  it('does not leak the structured reason name `tender_underpaid` to the DOM', () => {
    const { input } = setup(12550);
    fireEvent.change(input, { target: { value: '100.00' } });
    expect(document.body.innerHTML).not.toContain('tender_underpaid');
  });
});
