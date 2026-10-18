/**
 * RT-700 (P-26-1, OD-26-1 option A) — card is kept out of the pilot by a
 * fail-closed flag, `cardTender` (`POS_PULSE_FEATURE_CARD_TENDER`).
 *
 * Flag off (the default): the «بطاقة» tile is not rendered at all, so the
 * cashier cannot pick card, and PaymentSurface never mounts the card entry.
 * Main refuses a direct `tender.apply` for card too
 * (`tests/unit/main/payments/card-tender-flag.real-stack.test.ts`). Cash and
 * voucher are unchanged. Flag on: the frozen three-tile drawing (freeze 15 §4,
 * 08 I-11) is unchanged.
 */
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenderPicker } from '../../../v5/checkout/TenderPicker.js';
import {
  makeEnvelope,
  pickTender,
  resetTenderSurface,
} from './__helpers__/tender-gate-fixtures.js';

afterEach(resetTenderSurface);

function tileIds(): (string | null)[] {
  const group = screen.getByRole('radiogroup', { name: 'طريقة الدفع' });
  return within(group)
    .getAllByRole('radio')
    .map((tile) => tile.getAttribute('data-testid'));
}

describe('RT-700 TenderPicker — card flag off (default)', () => {
  it('does not render the card tile; cash and voucher keep their tiles', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.queryByTestId('tender-external-card')).not.toBeInTheDocument();
    expect(screen.queryByText('بطاقة')).not.toBeInTheDocument();
    expect(tileIds()).toEqual(['tender-cash', 'tender-voucher']);
    expect(screen.getByTestId('tender-cash')).toBeEnabled();
  });

  it('leaves the voucher rule alone: disabled unless voucherEnabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} voucherEnabled />);
    expect(screen.getByTestId('tender-voucher')).toBeEnabled();
  });
});

describe('RT-700 TenderPicker — card flag on', () => {
  it('renders the frozen three tiles in order: cash, card, voucher', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} cardEnabled />);
    expect(tileIds()).toEqual(['tender-cash', 'tender-external-card', 'tender-voucher']);
    expect(screen.getByTestId('tender-external-card')).toBeEnabled();
    expect(screen.getByTestId('tender-external-card')).toHaveTextContent('بطاقة');
  });

  it('selects external_card_terminal', () => {
    const onTenderSelect = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} cardEnabled />);
    screen.getByTestId('tender-external-card').click();
    expect(onTenderSelect).toHaveBeenCalledWith('external_card_terminal');
  });
});

describe('RT-700 PaymentSurface — the cardTender flag', () => {
  it('flag off: no card tile and no card entry; cash still starts the payment', async () => {
    const start = await pickTender({ cardTender: false }, 'tender-cash');
    expect(screen.queryByTestId('tender-external-card')).not.toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('cash-entry')).toBeInTheDocument();
    expect(screen.queryByTestId('external-card-terminal-entry')).not.toBeInTheDocument();
  });

  it('flag on: the card tile starts the payment and mounts the card entry', async () => {
    const start = await pickTender({ cardTender: true }, 'tender-external-card');
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('external-card-terminal-entry')).toBeInTheDocument();
  });
});
