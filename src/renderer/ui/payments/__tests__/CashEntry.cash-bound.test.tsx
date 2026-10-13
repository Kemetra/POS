/**
 * RT-437 (D-F2, M-P29) — CashEntry runs the same pure bound as main: above
 * max(EGP 100,000, remaining) the apply is off and the reason is shown under
 * the amount. Main's `cash_amount_out_of_range` shows the same line, keeps the
 * amount in the field and gives the field focus back; never «try again».
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { CashEntry } from '../CashEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../shared/bridge-api.js';

afterEach(cleanup);

const COPY = 'المبلغ أكبر من الحد المسموح للنقدية. راجع المبلغ.';

function renderBridged(
  remainingBalanceMinor: number,
  tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
    Promise.resolve({ kind: 'ok', tender_line_id: 'tl', applied_at: '2026-10-13T10:00:00.000Z' }),
  ),
) {
  render(
    <CashEntry
      remainingBalanceMinor={remainingBalanceMinor}
      paymentAttemptId="pa-1"
      tenderApply={tenderApply}
      onApplied={vi.fn()}
    />,
  );
  return {
    tenderApply,
    input: screen.getByTestId('cash-entry-amount-input'),
    confirm: screen.getByTestId('cash-entry-confirm'),
  };
}

describe('RT-437 — CashEntry cash bound (M-P29)', () => {
  it('13 typed barcode digits: confirm off, the reason under the amount, the field marked invalid', () => {
    const { input, confirm } = renderBridged(1500);
    fireEvent.change(input, { target: { value: '6221000000011' } });
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('cash-entry-out-of-range')).toHaveTextContent(COPY);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'cash-entry-out-of-range');
    expect(screen.queryByText(/حاول|المحاولة/)).toBeNull();
  });

  it('the cap itself is allowed on a small balance; one piastre above is not', () => {
    const { input, confirm } = renderBridged(1500);
    fireEvent.change(input, { target: { value: '100000' } });
    expect(confirm).toBeEnabled();
    expect(screen.queryByTestId('cash-entry-out-of-range')).toBeNull();
    fireEvent.change(input, { target: { value: '100000.01' } });
    expect(confirm).toBeDisabled();
  });

  it('a balance above the cap can be paid exactly', () => {
    const { input, confirm } = renderBridged(15_000_000);
    fireEvent.change(input, { target: { value: '150000' } });
    expect(confirm).toBeEnabled();
    fireEvent.change(input, { target: { value: '150000.01' } });
    expect(confirm).toBeDisabled();
  });

  it("main's cash_amount_out_of_range shows the same line, keeps the amount and refocuses the field", async () => {
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
      Promise.resolve({ kind: 'refused', reason: 'cash_amount_out_of_range' }),
    );
    // Main can refuse an amount the pre-check allowed when its balance is newer.
    const { input, confirm } = renderBridged(1500, tenderApply);
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry-out-of-range')).toHaveTextContent(COPY);
    });
    expect(input).toHaveValue('50');
    expect(input).toHaveFocus();
    expect(screen.queryByTestId('cash-entry-bridge-refusal')).toBeNull();
  });

  it('editing the amount clears the refusal line', async () => {
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
      Promise.resolve({ kind: 'refused', reason: 'cash_amount_out_of_range' }),
    );
    const { input, confirm } = renderBridged(1500, tenderApply);
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry-out-of-range')).toBeInTheDocument();
    });
    fireEvent.change(input, { target: { value: '20' } });
    expect(screen.queryByTestId('cash-entry-out-of-range')).toBeNull();
  });
});

describe('RT-437 — the ledger never previews an out-of-range amount', () => {
  it('reports null to the ledger while the amount is out of range, and the amount again once corrected', () => {
    const onDraftChange = vi.fn<(minor: number | null) => void>();
    render(
      <CashEntry
        remainingBalanceMinor={1500}
        paymentAttemptId="pa-1"
        tenderApply={vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>()}
        onApplied={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    const input = screen.getByTestId('cash-entry-amount-input');
    fireEvent.change(input, { target: { value: '6221000000011' } });
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
    expect(onDraftChange).not.toHaveBeenCalledWith(622_100_000_001_100);
    fireEvent.change(input, { target: { value: '20' } });
    expect(onDraftChange).toHaveBeenLastCalledWith(2000);
  });
});

describe("RT-437 — main's refusal holds until the amount is edited (Codex P2 #652)", () => {
  it('keeps confirm off and the ledger preview empty after main refuses an amount the pre-check allowed', async () => {
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
      Promise.resolve({ kind: 'refused', reason: 'cash_amount_out_of_range' }),
    );
    const onDraftChange = vi.fn<(minor: number | null) => void>();
    // This screen still believes 200,000 is owed; main's newer balance is smaller.
    render(
      <CashEntry
        remainingBalanceMinor={20_000_000}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    const input = screen.getByTestId('cash-entry-amount-input');
    const confirm = screen.getByTestId('cash-entry-confirm');
    fireEvent.change(input, { target: { value: '150000' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry-out-of-range')).toBeInTheDocument();
    });
    expect(confirm).toBeDisabled();
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(confirm);
    expect(tenderApply).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: '100' } });
    expect(confirm).toBeEnabled();
    expect(onDraftChange).toHaveBeenLastCalledWith(10_000);
  });
});

describe('RT-437 — a refusal answers the amount it was sent for (Codex P2 #652)', () => {
  it('an amount edited while the refusal was in flight is not marked refused', async () => {
    let answer: (r: TenderApplyResponse) => void = () => undefined;
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const onDraftChange = vi.fn<(minor: number | null) => void>();
    render(
      <CashEntry
        remainingBalanceMinor={20_000_000}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    const input = screen.getByTestId('cash-entry-amount-input');
    const confirm = screen.getByTestId('cash-entry-confirm');
    fireEvent.change(input, { target: { value: '150000' } });
    fireEvent.click(confirm);
    // The cashier corrects the amount before main answers.
    fireEvent.change(input, { target: { value: '100' } });
    answer({ kind: 'refused', reason: 'cash_amount_out_of_range' });
    await waitFor(() => {
      expect(confirm).toBeEnabled();
    });
    expect(screen.queryByTestId('cash-entry-out-of-range')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(onDraftChange).toHaveBeenLastCalledWith(10_000);
  });
});
