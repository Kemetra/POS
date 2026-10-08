import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { JSX } from 'react';

import { CheckoutRoute } from '../../../../src/renderer/routes/app/checkout/CheckoutRoute.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import { useCartStore } from '../../../../src/renderer/stores/cart-store.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import { useDrawerNoticeStore } from '../../../../src/renderer/ui/receipts/drawer-notice-store.js';

/**
 * P0 cashier-flow blocker — CheckoutRoute "New sale" wiring (the load-bearing
 * seam that makes the PaymentSurface settled-phase fix actually unstick the
 * cashier in the running app).
 *
 * After payment settles, PaymentSurface renders a "New sale" button but is
 * Router-agnostic — it only fires the optional `onNewSale` callback. The route
 * owner (CheckoutRoute) must supply that callback: reset the payment + cart
 * stores and navigate back to /app/cart so the next sale starts clean. Without
 * this wiring the button is inert (the exact "built-but-not-wired" trap).
 */

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
      line_id: 'line-1',
      item_ref: 'SKU-001',
      display_name: 'Paracetamol 500mg',
      quantity: 2,
      unit_price_minor: 1250,
      line_subtotal_minor: 2500,
      note: null,
      version: 1,
      last_action_id: 'action-1',
    },
  ],
  discount_placeholders: [],
  subtotal_minor: 2500,
  created_at: '2026-06-11T12:00:00.000Z',
  handoff_action_id: 'handoff-001',
};

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="location-probe">{loc.pathname}</div>;
}

/**
 * The post-confirm re-read answers as main does for a settled attempt: the
 * settle leaves every tender line `applied` (there is no settled line state).
 */
function readReturnsSettled(tenderType: string): void {
  const api = (window as unknown as { api: { payments: { read: ReturnType<typeof vi.fn> } } }).api;
  api.payments.read.mockResolvedValue({
    kind: 'ok',
    payment_attempt: {
      payment_attempt_id: 'pa-1',
      state: 'settled',
      envelope_subtotal_minor: 2500,
      started_at: '2026-06-11T12:00:01.000Z',
      settled_at: '2026-06-11T12:00:09.000Z',
      tender_lines: [
        {
          tender_line_id: 'tl-1',
          tender_type: tenderType,
          amount_applied_minor: 2500,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-06-11T12:00:02.000Z',
        },
      ],
    },
  });
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  useCartStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true });
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'session-uuid',
        operator_id: 'op-uuid',
        display_name: 'Test Operator',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-06-11T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(ENVELOPE);
  // window.api so PaymentSurface resolves a (payments+tender) bridge and runs
  // the bridged path; jsdom never sets it otherwise.
  (window as unknown as { api?: unknown }).api = {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' })),
      confirm: vi.fn(() => Promise.resolve({ kind: 'ok', settled_at: '2026-06-11T12:00:09.000Z' })),
      cancel: vi.fn(),
      subscribe: vi.fn(),
      read: vi.fn(() =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            payment_attempt_id: 'pa-1',
            state: 'started',
            envelope_subtotal_minor: 2500,
            started_at: 'x',
            tender_lines: [],
          },
        }),
      ),
    },
    tender: { apply: vi.fn(), reverse: vi.fn(), read: vi.fn() },
    sales: {
      read: vi.fn(),
      findByNumber: vi.fn(),
      subscribe: vi.fn(() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
      unsubscribe: vi.fn(),
    },
  };
});

afterEach(() => {
  cleanup();
  useDrawerNoticeStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  useCartStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('CheckoutRoute — New sale wiring', () => {
  it('clicking New sale (after settle) resets the payment store and navigates to /app/cart', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/app/checkout']}>
        <Routes>
          <Route path="/app/checkout" element={<CheckoutRoute />} />
          <Route path="/app/cart" element={<div data-testid="cart-screen">Cart</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );

    // Seed the applied line AFTER render: PaymentSurface's mount effect calls
    // clearAttempt(), so a pre-render seed would be wiped (matches the
    // post-render seeding in PaymentSurface.confirm.test.tsx).
    usePaymentStore.getState().applyAttemptSnapshot({
      payment_attempt_id: 'pa-1',
      state: 'started',
      envelope_subtotal_minor: 2500,
      started_at: '2026-06-11T12:00:01.000Z',
      tender_lines: [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 2500,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-06-11T12:00:02.000Z',
        },
      ],
    });

    await user.click(await screen.findByTestId('payment-surface-confirm'));
    await user.click(await screen.findByTestId('payment-surface-new-sale'));

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    // Payment store cleared so the next sale starts with no carried envelope.
    expect(usePaymentStore.getState().envelope).toBeNull();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
  });

  it('RT-241 (D-B1): the drawer notice shows inside cash completion, and «بيع جديد» acknowledges it', async () => {
    const user = userEvent.setup();
    readReturnsSettled('cash');
    render(
      <MemoryRouter initialEntries={['/app/checkout']}>
        <Routes>
          <Route path="/app/checkout" element={<CheckoutRoute />} />
          <Route path="/app/cart" element={<div data-testid="cart-screen">Cart</div>} />
        </Routes>
      </MemoryRouter>,
    );
    usePaymentStore.getState().applyAttemptSnapshot({
      payment_attempt_id: 'pa-1',
      state: 'started',
      envelope_subtotal_minor: 2500,
      started_at: '2026-06-11T12:00:01.000Z',
      tender_lines: [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 2500,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-06-11T12:00:02.000Z',
        },
      ],
    });
    await user.click(await screen.findByTestId('payment-surface-confirm'));
    await screen.findByTestId('payment-surface-settled');

    // The sale finalizes asynchronously; its drawer kick fails in this session.
    const notice = useDrawerNoticeStore.getState();
    notice.observe(null);
    notice.observe({ sale_id: 'sale-now', last_successful_open_at: null });

    expect(await screen.findByTestId('drawer-notice-inline')).toHaveTextContent(
      'لم يُفتح درج النقود. افتحه يدويًا.',
    );
    await user.click(screen.getByTestId('payment-surface-new-sale'));
    expect(useDrawerNoticeStore.getState().active).toBeNull();
  });

  it.each(['external_card_terminal', 'internal_voucher'])(
    'RT-241 (D-B1, Codex P2 on #579): a %s completion does not carry an earlier cash sale’s drawer notice',
    async (tenderType) => {
      const user = userEvent.setup();
      readReturnsSettled(tenderType);
      // An earlier cash sale's drawer kick failed in this session.
      const notice = useDrawerNoticeStore.getState();
      notice.observe(null);
      notice.observe({ sale_id: 'sale-earlier', last_successful_open_at: null });

      render(
        <MemoryRouter initialEntries={['/app/checkout']}>
          <Routes>
            <Route path="/app/checkout" element={<CheckoutRoute />} />
            <Route path="/app/cart" element={<div data-testid="cart-screen">Cart</div>} />
          </Routes>
        </MemoryRouter>,
      );
      usePaymentStore.getState().applyAttemptSnapshot({
        payment_attempt_id: 'pa-1',
        state: 'started',
        envelope_subtotal_minor: 2500,
        started_at: '2026-06-11T12:00:01.000Z',
        tender_lines: [
          {
            tender_line_id: 'tl-1',
            tender_type: tenderType,
            amount_applied_minor: 2500,
            state: 'applied',
            apply_order: 1,
            applied_at: '2026-06-11T12:00:02.000Z',
          },
        ],
      });
      await user.click(await screen.findByTestId('payment-surface-confirm'));
      await screen.findByTestId('payment-surface-settled');

      // The notice is still active for the status area; this completion has no cash.
      expect(useDrawerNoticeStore.getState().active).not.toBeNull();
      expect(screen.queryByTestId('drawer-notice-inline')).not.toBeInTheDocument();
    },
  );
});
