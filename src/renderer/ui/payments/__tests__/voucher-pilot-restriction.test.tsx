/**
 * RT-103 — the internal voucher tender is unavailable in the pilot cashier UI.
 *
 * RT-10 D2: vouchers are excluded from the pilot. RT-79 already fails closed on the
 * sync side (a voucher-tendered sale is dead-lettered, never sent as another method);
 * this locks the cashier surface so such a sale cannot be started in the first place.
 *
 * The restriction is the DEFAULT: `voucherTender` is a fail-closed feature flag
 * (`POS_PULSE_FEATURE_VOUCHER_TENDER`). With it off the voucher tile renders but is
 * disabled — not clickable, not keyboard-reachable — and PaymentSurface refuses a
 * voucher selection and never mounts VoucherEntry. Cash and external card are unchanged.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenderPicker } from '../../../v5/checkout/TenderPicker.js';
import {
  makeEnvelope,
  pickTender,
  resetTenderSurface,
} from './__helpers__/tender-gate-fixtures.js';

afterEach(resetTenderSurface);

describe('RT-103 TenderPicker — pilot restriction (default)', () => {
  it('renders the voucher tile disabled, and cash + card enabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} cardEnabled />);
    expect(screen.getByTestId('tender-voucher')).toBeDisabled();
    expect(screen.getByTestId('tender-voucher')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('tender-cash')).toBeEnabled();
    expect(screen.getByTestId('tender-external-card')).toBeEnabled();
  });

  it('a click on the voucher tile never selects the voucher tender', async () => {
    const onTenderSelect = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} />);
    await userEvent.click(screen.getByTestId('tender-voucher'));
    expect(onTenderSelect).not.toHaveBeenCalled();
  });

  it('the keyboard path cannot reach or invoke the voucher tender', async () => {
    const onTenderSelect = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} cardEnabled />);
    const user = userEvent.setup();
    const reached: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      await user.tab();
      reached.push(document.activeElement?.getAttribute('data-testid') ?? null);
      await user.keyboard('{Enter}');
    }
    expect(reached).not.toContain('tender-voucher');
    const selected = onTenderSelect.mock.calls.map((c: unknown[]) => c[0]);
    expect(selected).not.toContain('internal_voucher');
    // Cash and card stay keyboard-operable.
    expect(selected).toEqual(expect.arrayContaining(['cash', 'external_card_terminal']));
  });

  it('tells the cashier the voucher is unavailable (not a silent dead tile)', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.getByTestId('tender-voucher')).toHaveTextContent('غير متاحة حاليًا');
  });
});

describe('RT-103 TenderPicker — voucher explicitly enabled', () => {
  it('the voucher tile is enabled and selects internal_voucher', async () => {
    const onTenderSelect = vi.fn();
    render(
      <TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} voucherEnabled />,
    );
    const voucher = screen.getByTestId('tender-voucher');
    expect(voucher).toBeEnabled();
    await userEvent.click(voucher);
    expect(onTenderSelect).toHaveBeenCalledWith('internal_voucher');
  });
});

describe('RT-103 PaymentSurface — pilot restriction from the voucherTender flag', () => {
  it('flag off: selecting the voucher starts no payment and mounts no VoucherEntry', async () => {
    const start = await pickTender({ voucherTender: false }, 'tender-voucher');
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voucher-entry-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('tender-voucher')).toBeDisabled();
  });

  it.each([
    ['flag off: cash still starts the payment', false, 'tender-cash', 'cash-entry'],
    ['flag on: the voucher starts the payment', true, 'tender-voucher', 'voucher-entry-confirm'],
  ])('%s and mounts its entry', async (_name, voucherTender, tile, entryTestId) => {
    const start = await pickTender({ voucherTender }, tile);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId(entryTestId)).toBeInTheDocument();
  });
});
