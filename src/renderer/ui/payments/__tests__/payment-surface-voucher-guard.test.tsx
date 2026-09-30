/**
 * RT-103 — PaymentSurface's own voucher guard (defence in depth behind the disabled tile).
 *
 * The disabled tile never calls `onTenderSelect`, so clicking it cannot prove the surface
 * guard exists. Here TenderSelection is stubbed with an always-clickable voucher button,
 * so the ONLY thing standing between a voucher selection and `payments.start` is
 * `PaymentSurface.handleTenderSelect`. The flag-on case is the positive control: it
 * shows the stub really reaches the handler.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

vi.mock('../TenderSelection.js', () => ({
  TenderSelection: (props: { onTenderSelect: (tender: string) => void }) => (
    <button
      type="button"
      data-testid="stub-voucher"
      onClick={() => {
        props.onTenderSelect('internal_voucher');
      }}
    >
      voucher
    </button>
  ),
}));

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  lines: [
    {
      line_id: 'line-001',
      item_ref: 'item-001',
      display_name: 'باراسيتامول',
      quantity: 1,
      unit_price_minor: 2500,
      line_subtotal_minor: 2500,
      note: null,
      version: 1,
      last_action_id: 'act-001',
    },
  ],
  discount_placeholders: [],
  subtotal_minor: 2500,
  created_at: '2026-09-30T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

/** Seed a signed-in session + envelope, click the stub voucher, return the start spy. */
async function clickVoucher(voucherTender: boolean): Promise<ReturnType<typeof vi.fn>> {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-30T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(ENVELOPE);
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, voucherTender });
  const start = vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' }));
  const bridge = {
    payments: { start, read: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
    tender: { apply: vi.fn() },
  } as unknown as { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId('stub-voucher').click();
    await Promise.resolve();
  });
  return start;
}

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('RT-103 PaymentSurface voucher guard', () => {
  it('flag off: a voucher selection reaching the surface starts no payment', async () => {
    const start = await clickVoucher(false);
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-surface-tender-selected')).not.toBeInTheDocument();
  });

  it('flag on (positive control): the same selection starts the payment', async () => {
    const start = await clickVoucher(true);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
