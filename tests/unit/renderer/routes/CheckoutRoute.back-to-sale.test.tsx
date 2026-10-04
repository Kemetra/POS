import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { JSX } from 'react';

import { CheckoutRoute } from '../../../../src/renderer/routes/app/checkout/CheckoutRoute.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import { useCartStore } from '../../../../src/renderer/stores/cart-store.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import { CartState } from '../../../../src/shared/cart/cart-state.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../src/shared/payments/types.js';

/**
 * RT-26 — CheckoutRoute Back / Esc wiring. Main (`cart.returnToSale`) decides;
 * the renderer only drops the envelope and returns to /app/cart after main's
 * `ok`, keeps the cashier on Checkout on a refusal, never offers Back once
 * tender exists, and retries with the SAME idempotency key.
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

let returnToSale: ReturnType<typeof vi.fn>;
let paymentsStart: ReturnType<typeof vi.fn>;

beforeEach(() => {
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
  useCartStore.setState({
    activeCart: { cart_id: 'cart-001', state: CartState.frozen_handed_off, lastLineId: 'line-1' },
  });
  usePaymentStore.getState().mount(ENVELOPE);
  returnToSale = vi.fn(() => Promise.resolve({ kind: 'ok' }));
  paymentsStart = vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }));
  (window as unknown as { api?: unknown }).api = {
    cart: { returnToSale },
    payments: {
      start: paymentsStart,
      confirm: vi.fn(),
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
  };
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  useCartStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function renderCheckout(): void {
  render(
    <MemoryRouter initialEntries={['/app/checkout']}>
      <Routes>
        <Route path="/app/checkout" element={<CheckoutRoute />} />
        <Route path="/app/cart" element={<div data-testid="cart-screen">Cart</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function withAppliedCash(): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-1',
    state: 'started',
    envelope_subtotal_minor: 2500,
    started_at: '2026-06-11T12:00:01.000Z',
    tender_lines: [
      {
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        amount_applied_minor: 1000,
        state: 'applied',
        apply_order: 1,
        applied_at: '2026-06-11T12:00:02.000Z',
      },
    ],
  };
}

describe('CheckoutRoute — Back to the same sale (RT-26)', () => {
  it('Back asks main with the envelope ids, then returns to /app/cart with the cart editable', async () => {
    const user = userEvent.setup();
    renderCheckout();

    await user.click(await screen.findByTestId('payment-surface-back'));

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(returnToSale).toHaveBeenCalledOnce();
    expect(returnToSale).toHaveBeenCalledWith({
      cart_id: 'cart-001',
      handoff_action_id: 'handoff-001',
      idempotency_key: expect.any(String) as string,
    });
    // The old envelope is gone; the SAME cart is editable again.
    expect(usePaymentStore.getState().envelope).toBeNull();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
    expect(useCartStore.getState().activeCart).toEqual({
      cart_id: 'cart-001',
      state: CartState.editing,
      lastLineId: 'line-1',
    });
  });

  it('Esc does the same as Back', async () => {
    const user = userEvent.setup();
    renderCheckout();
    await screen.findByTestId('payment-surface-back');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(returnToSale).toHaveBeenCalledOnce();
  });

  it('Back with a zero-funds started attempt is offered (main cancels the attempt)', async () => {
    const user = userEvent.setup();
    renderCheckout();
    await user.click(await screen.findByTestId('tender-cash'));
    await waitFor(() => {
      expect(usePaymentStore.getState().paymentSlice?.state).toBe('started');
    });

    expect(screen.getByTestId('payment-surface-back')).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
  });

  it('a refusal keeps the cashier on Checkout with the envelope and cart untouched', async () => {
    returnToSale.mockResolvedValue({ kind: 'refused', reason: 'frozen' });
    const user = userEvent.setup();
    renderCheckout();

    await user.click(await screen.findByTestId('payment-surface-back'));

    expect(await screen.findByTestId('payment-surface-bridge-refusal')).toHaveTextContent(
      'تعذّر الرجوع إلى البيع',
    );
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/checkout');
    expect(usePaymentStore.getState().envelope?.handoff_action_id).toBe('handoff-001');
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
  });

  it('a transport failure is a refusal, and the retry reuses the same idempotency key', async () => {
    returnToSale.mockRejectedValueOnce(new Error('ipc lost'));
    const user = userEvent.setup();
    renderCheckout();

    await user.click(await screen.findByTestId('payment-surface-back'));
    expect(await screen.findByTestId('payment-surface-bridge-refusal')).toBeInTheDocument();
    await user.click(screen.getByTestId('payment-surface-back'));

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(returnToSale).toHaveBeenCalledTimes(2);
    const keys = returnToSale.mock.calls.map(
      (call) => (call[0] as { idempotency_key: string }).idempotency_key,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it('is disabled, with the reason shown, once tender exists; Esc does nothing', async () => {
    const user = userEvent.setup();
    renderCheckout();
    await screen.findByTestId('payment-surface-back');
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot(withAppliedCash());
    });

    expect(screen.getByTestId('payment-surface-back')).toBeDisabled();
    expect(screen.getByTestId('payment-surface-back-blocked')).toHaveTextContent(
      'لا يمكن الرجوع إلى البيع',
    );
    await user.keyboard('{Escape}');
    expect(returnToSale).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/checkout');
  });

  it('is disabled while a payment start is in flight', async () => {
    let resolveStart: (v: unknown) => void = () => undefined;
    paymentsStart.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const user = userEvent.setup();
    renderCheckout();
    await user.click(await screen.findByTestId('tender-cash'));

    expect(screen.getByTestId('payment-surface-back')).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(returnToSale).not.toHaveBeenCalled();
    await act(async () => {
      resolveStart({ kind: 'ok', payment_attempt_id: 'pa-1' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-back')).toBeEnabled();
    });
  });

  it('fails closed without calling main when the renderer cart is not the frozen envelope cart', async () => {
    useCartStore.setState({
      activeCart: { cart_id: 'cart-other', state: CartState.frozen_handed_off, lastLineId: null },
    });
    const user = userEvent.setup();
    renderCheckout();

    await user.click(await screen.findByTestId('payment-surface-back'));

    expect(await screen.findByTestId('payment-surface-bridge-refusal')).toBeInTheDocument();
    expect(returnToSale).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/checkout');
  });

  it('direct entry without an envelope still redirects to the Sale and never calls main', async () => {
    usePaymentStore.getState().reset();
    renderCheckout();
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(returnToSale).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
  });
});
