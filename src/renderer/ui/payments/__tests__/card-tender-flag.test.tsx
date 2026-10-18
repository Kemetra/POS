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
import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { TenderPicker } from '../../../v5/checkout/TenderPicker.js';

function makeEnvelope(): PaymentIntentEnvelope {
  return {
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
        display_name: 'باراسيتامول ٥٠٠ مجم',
        quantity: 2,
        unit_price_minor: 1250,
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
}

type TestBridge = { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };

/** The bridge plus a direct handle on `payments.start` (asserted without unbinding). */
function makeBridge(): { bridge: TestBridge; start: ReturnType<typeof vi.fn> } {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: 2500,
    started_at: '2026-09-30T09:59:00.000Z',
    tender_lines: [],
  };
  const start = vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' }));
  const bridge = {
    payments: {
      start,
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: attempt })),
      confirm: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-30T10:00:00.000Z' }),
      ),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    },
    tender: { apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })) },
  } as unknown as TestBridge;
  return { bridge, start };
}

function seedSurface(cardTender: boolean): void {
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
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, cardTender });
}

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

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

async function pickTender(cardTender: boolean, tileTestId: string) {
  seedSurface(cardTender);
  const { bridge, start } = makeBridge();
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId(tileTestId).click();
    await Promise.resolve();
  });
  return start;
}

describe('RT-700 PaymentSurface — the cardTender flag', () => {
  it('flag off: no card tile and no card entry; cash still starts the payment', async () => {
    const start = await pickTender(false, 'tender-cash');
    expect(screen.queryByTestId('tender-external-card')).not.toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('cash-entry')).toBeInTheDocument();
    expect(screen.queryByTestId('external-card-terminal-entry')).not.toBeInTheDocument();
  });

  it('flag on: the card tile starts the payment and mounts the card entry', async () => {
    const start = await pickTender(true, 'tender-external-card');
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('external-card-terminal-entry')).toBeInTheDocument();
  });
});
