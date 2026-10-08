import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import { CheckoutRoute } from '../../routes/app/checkout/CheckoutRoute';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { CartState } from '../../../shared/cart/cart-state';
import { V5Frame } from '../frame/V5Frame';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';
import { addLineByScan, makeBridges, signIn } from './__helpers__/live-sale-harness';
import { installViewport, resizeTo, settleTier } from './__helpers__/viewport-bands';

/**
 * RT-241 responsive preflight — resize safety (regression only). Dropping
 * below the 1024px floor unmounts the screen behind the M-F2 notice; coming
 * back must not lose the cashier's cart or payment authority, must not commit
 * anything, and must not claim a completion. No cart or payment contract is
 * changed by W1-A; this records what the frame does to the screens it hosts.
 */

const TOO_SMALL = /^الشاشة أصغر من 1024×768\s?\.$/;

async function walkTheBoundary(): Promise<void> {
  resizeTo(1023);
  await settleTier();
  expect(screen.getByRole('heading', { name: TOO_SMALL })).toBeInTheDocument();
  resizeTo(1024);
  await settleTier();
  resizeTo(1280);
  await settleTier();
  expect(screen.queryByRole('heading', { name: TOO_SMALL })).not.toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('resize 1280 → 1023 → 1024 → 1280 with a non-empty cart', () => {
  it('keeps the same cart and its lines; no new cart is created', async () => {
    installViewport(1280);
    signIn();
    const bridges = makeBridges();
    // Remounting the Sale re-reads its active cart from main (RT-116 hydration).
    const line = (line_id: string, display_name: string, price: number) => ({
      line_id,
      display_name,
      quantity: 1,
      unit_price_minor: price,
      line_subtotal_minor: price,
      note: null,
      version: 1,
    });
    const snapshot = vi.fn().mockResolvedValue({
      kind: 'ok',
      snapshot: {
        cart_id: 'cart-1',
        state: CartState.editing,
        lines: [line('line-1', 'بنادول', 1500), line('line-2', 'بروفين', 2500)],
        discount_placeholders: [],
        paid: false,
        envelope: null,
      },
    });
    Object.assign(bridges.cart, { snapshot });
    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <V5Frame>
          <LiveSaleWorkspace
            cartBridge={bridges.cart}
            catalogueBridge={bridges.catalogue}
            onPaymentContinue={vi.fn()}
          />
        </V5Frame>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await addLineByScan(user);
    await addLineByScan(user);
    const cartId = useCartStore.getState().activeCart?.cart_id;
    expect(cartId).toBe('cart-1');

    await walkTheBoundary();

    const lines = await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(within(lines).getByText('بنادول')).toBeInTheDocument();
    expect(within(lines).getByText('بروفين')).toBeInTheDocument();
    expect(useCartStore.getState().activeCart?.cart_id).toBe(cartId);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn spy, read only
    expect(bridges.cart.create).toHaveBeenCalledTimes(1);
    expect(bridges.voidCart).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledWith({ cart_id: 'cart-1' });
    expect(document.activeElement).not.toBe(document.body);
  });
});

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
      display_name: 'بنادول',
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
  created_at: '2026-10-08T12:00:00.000Z',
  handoff_action_id: 'handoff-001',
};

const APPLIED_ATTEMPT = {
  payment_attempt_id: 'pa-1',
  state: 'started' as const,
  envelope_subtotal_minor: 2500,
  started_at: '2026-10-08T12:00:01.000Z',
  tender_lines: [
    {
      tender_line_id: 'tl-1',
      tender_type: 'cash' as const,
      amount_applied_minor: 2500,
      state: 'applied' as const,
      apply_order: 1,
      applied_at: '2026-10-08T12:00:02.000Z',
    },
  ],
};

describe('resize 1280 → 1023 → 1024 → 1280 during a live Checkout', () => {
  it('keeps the attempt and its applied tender, commits nothing and claims no completion', async () => {
    installViewport(1280);
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true });
    useOperatorSessionStore.getState().hydrateSignedIn({
      id: 'session-1',
      operator_id: 'op-1',
      display_name: 'صيدلي',
      role: 'cashier',
      tenant_id: 'tenant-001',
      branch_id: 'branch-001',
      started_at: '2026-10-08T09:00:00Z',
    });
    usePaymentStore.getState().mount(ENVELOPE);
    const confirm = vi.fn();
    const start = vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }));
    (window as unknown as { api?: unknown }).api = {
      payments: {
        start,
        confirm,
        cancel: vi.fn(),
        subscribe: vi.fn(),
        read: vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt: APPLIED_ATTEMPT })),
      },
      tender: { apply: vi.fn(), reverse: vi.fn(), read: vi.fn() },
      sales: {
        read: vi.fn(),
        findByNumber: vi.fn(),
        subscribe: vi.fn(() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
        unsubscribe: vi.fn(),
      },
    };
    render(
      <MemoryRouter initialEntries={['/app/checkout']}>
        <V5Frame>
          <Routes>
            <Route path="/app/checkout" element={<CheckoutRoute />} />
            <Route path="/app/cart" element={<p>السلة</p>} />
          </Routes>
        </V5Frame>
      </MemoryRouter>,
    );
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_ATTEMPT);
    expect(await screen.findByTestId('payment-surface-confirm')).toBeInTheDocument();

    await walkTheBoundary();

    expect(await screen.findByTestId('payment-surface-confirm')).toBeInTheDocument();
    const slice = usePaymentStore.getState().paymentSlice;
    expect(slice?.payment_attempt_id).toBe('pa-1');
    expect(slice?.tender_lines.map((l) => l.tender_line_id)).toEqual(['tl-1']);
    expect(usePaymentStore.getState().envelope?.handoff_action_id).toBe('handoff-001');
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });
});
