import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import { CartWorkspace } from '../../../../../src/renderer/routes/app/CartWorkspace.js';
import { useOperatorSessionStore } from '../../../../../src/renderer/stores/operator-session-store.js';
import { useCartStore } from '../../../../../src/renderer/stores/cart-store.js';
import { usePaymentStore } from '../../../../../src/renderer/stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../../src/renderer/stores/feature-flags-store.js';

/**
 * 023 Slice G — the legacy Sale screen is no longer routed (`/app/cart` is the
 * v5 Sale) but stays in the tree as the rollback source. Rollback is only safe
 * if that screen still works, so its end-to-end wiring (scan → Add → hand off
 * → Continue → navigate to checkout) is kept here, mounted directly. This is
 * the pre-cutover body of `cart-to-checkout-wiring.test.tsx`, unchanged except
 * for the mount point.
 */

const MANAGER_SESSION = {
  id: 'sess-legacy',
  operator_id: 'op-legacy',
  display_name: 'Manager',
  role: 'manager' as const,
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-06-11T09:00:00.000Z',
};

const ENVELOPE = {
  envelope_version: 'v1' as const,
  cart_id: 'cart-checkout',
  handoff_action_id: 'handoff-legacy',
  created_at: '2026-06-11T09:05:00.000Z',
  subtotal_minor: 1250,
  currency_code: 'EGP',
  lines: [
    {
      line_id: 'line-1',
      display_name: 'Paracetamol 500mg Tablets',
      quantity: 1,
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      note: null,
    },
  ],
  discount_placeholders: [],
};

interface ApiFixture {
  cart: {
    create: ReturnType<typeof vi.fn>;
    lines: { add: ReturnType<typeof vi.fn> };
    handoff: ReturnType<typeof vi.fn>;
  };
}

function api(): ApiFixture {
  return (window as unknown as { api: ApiFixture }).api;
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  (window as unknown as { api?: unknown }).api = {
    cart: {
      create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-checkout' }),
      lines: {
        add: vi.fn().mockResolvedValue({
          kind: 'ok',
          line_id: 'line-1',
          display_name: 'Paracetamol 500mg Tablets',
          unit_price_minor: 1250,
          line_subtotal_minor: 1250,
          quantity: 1,
          version: 1,
          merged: false,
        }),
        update: vi.fn(),
        remove: vi.fn(),
        setNote: vi.fn(),
      },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ kind: 'ok', envelope: ENVELOPE }),
      subscribe: vi.fn(),
    },
    catalogue: {
      lookupBarcode: vi.fn().mockResolvedValue({
        kind: 'one',
        product: {
          product_id: 'p-1',
          display_name_ar: 'Paracetamol 500mg Tablets',
          price_minor: 1250,
          active: true,
          controlled_substance: false,
          prescription_required: false,
        },
      }),
      lookupSku: vi.fn(),
      search: vi.fn(),
      resolve: vi.fn(),
      refresh: vi.fn(() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
      freshness: vi.fn(() =>
        Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      ),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('legacy CartWorkspace — rollback source still works end to end', () => {
  it('scan → Add → hand off → Continue navigates to checkout with the frozen envelope', async () => {
    const user = userEvent.setup();
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    useOperatorSessionStore.getState().hydrateSignedIn(MANAGER_SESSION);

    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <Routes>
          <Route path="/app/cart" element={<CartWorkspace />} />
          <Route path="/app/checkout" element={<div data-testid="checkout-reached" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(api().cart.create).not.toHaveBeenCalled();

    const scan = await screen.findByTestId('scan-capture-field');
    await user.type(scan, '6221000000001');
    fireEvent.keyDown(scan, { key: 'Enter' });
    await user.click(await screen.findByRole('button', { name: /Add/ }));

    const handoffBtn = await screen.findByTestId('cart-handoff-button');
    await waitFor(() => expect(handoffBtn).toBeEnabled());
    await user.click(handoffBtn);

    const continueBtn = await screen.findByTestId('handoff-continue-button');
    expect(continueBtn).toBeEnabled();
    await user.click(continueBtn);

    expect(await screen.findByTestId('checkout-reached')).toBeInTheDocument();
    expect(api().cart.create).toHaveBeenCalledOnce();
    expect(api().cart.handoff).toHaveBeenCalledOnce();
    expect(usePaymentStore.getState().envelope).toEqual(ENVELOPE);
  });
});
