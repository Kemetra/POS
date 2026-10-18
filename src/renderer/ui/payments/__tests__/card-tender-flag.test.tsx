/**
 * RT-700 (P-26-1, OD-26-1) — the card tender is kept out of the pilot cashier UI.
 *
 * `cardTender` is a fail-closed feature flag (`POS_PULSE_FEATURE_CARD_TENDER`).
 * With it off the «بطاقة» tile is not rendered and PaymentSurface starts no
 * payment for a card selection; cash and voucher are unchanged. With it on, the
 * frozen checkout drawing (cash, card, voucher) is unchanged. Main refuses a
 * card `tender.apply` independently (bridge.tender-apply.card-flag.test.ts).
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
  vi.restoreAllMocks();
  useFeatureFlagsStore.getState().reset();
});

function tileIds(): (string | null)[] {
  return screen.getAllByRole('radio').map((tile) => tile.getAttribute('data-testid'));
}

describe('RT-700 TenderPicker', () => {
  it('cardEnabled false: no card tile; cash and voucher keep their slots', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} cardEnabled={false} />);
    expect(screen.queryByTestId('tender-external-card')).not.toBeInTheDocument();
    expect(tileIds()).toEqual(['tender-cash', 'tender-voucher']);
  });

  it('cardEnabled true: the frozen drawing, cash then card then voucher', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} cardEnabled />);
    expect(tileIds()).toEqual(['tender-cash', 'tender-external-card', 'tender-voucher']);
  });
});

describe('RT-700 PaymentSurface — from the cardTender flag', () => {
  it('flag off (the default): no card tile and cash still starts the payment', async () => {
    seedSurface(false);
    const { bridge, start } = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    expect(screen.queryByTestId('tender-external-card')).not.toBeInTheDocument();
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('cash-entry')).toBeInTheDocument();
  });

  it('flag on: the card tile is there and opens the card entry', async () => {
    seedSurface(true);
    const { bridge } = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await act(async () => {
      screen.getByTestId('tender-external-card').click();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('external-card-terminal-entry')).toBeInTheDocument();
  });
});
