import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { JSX } from 'react';

import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type {
  CartHandoffRequest,
  CartLinesUpdateRequest,
  CartReturnToSaleRequest,
  CartSnapshot,
} from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { CheckoutRoute } from '../../routes/app/checkout/CheckoutRoute';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

/**
 * RT-26 — the cashier loop through the real Sale and Checkout screens:
 * Sale → hand off → Checkout → Esc → the SAME sale, editable, with its lines,
 * quantities and notes → edit → Checkout again on a NEW envelope.
 *
 * The cart bridge is a small stateful stand-in for main that applies the same
 * rules as `cart.returnToSale` (frozen + latest handoff → editing, envelope
 * cleared) so the renderer is driven only by main-shaped responses.
 */

const CART = 'cart-rt26';

interface FakeLine {
  line_id: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  note: string | null;
  version: number;
}

function fakeMain() {
  let state: CartState = CartState.editing;
  let handoffSeq = 0;
  let envelope: PaymentIntentEnvelope | null = null;
  const lines: FakeLine[] = [
    {
      line_id: 'line-a',
      display_name: 'باراسيتامول',
      quantity: 2,
      unit_price_minor: 1250,
      note: 'بعد الأكل',
      version: 3,
    },
    {
      line_id: 'line-b',
      display_name: 'فيتامين سي',
      quantity: 1,
      unit_price_minor: 2500,
      note: null,
      version: 1,
    },
  ];
  const subtotal = (): number => lines.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0);
  const snapshot = (): CartSnapshot => ({
    cart_id: CART,
    state,
    paid: false,
    lines: lines.map((l) => ({ ...l, line_subtotal_minor: l.quantity * l.unit_price_minor })),
    discount_placeholders: [],
    envelope,
  });

  const returnToSale = vi.fn((req: CartReturnToSaleRequest) => {
    if (
      state !== CartState.frozen_handed_off ||
      req.handoff_action_id !== envelope?.handoff_action_id
    ) {
      return Promise.resolve({ kind: 'refused' as const, reason: 'stale_version' as const });
    }
    state = CartState.editing;
    envelope = null;
    return Promise.resolve({ kind: 'ok' as const });
  });
  const handoff = vi.fn((req: CartHandoffRequest) => {
    if (state !== CartState.editing) {
      return Promise.resolve({ kind: 'refused' as const, reason: 'frozen' as const });
    }
    for (const v of req.per_line_versions) {
      if (lines.find((l) => l.line_id === v.line_id)?.version !== v.version) {
        return Promise.resolve({ kind: 'refused' as const, reason: 'stale_version' as const });
      }
    }
    handoffSeq += 1;
    state = CartState.frozen_handed_off;
    envelope = {
      envelope_version: 'v1',
      cart_id: CART,
      operator_session_id: 'session-1',
      owning_operator_id: 'op-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      handoff_action_id: `handoff-${String(handoffSeq)}`,
      created_at: '2026-10-04T09:05:00.000Z',
      subtotal_minor: subtotal(),
      lines: lines.map((l) => ({
        line_id: l.line_id,
        item_ref: l.line_id,
        display_name: l.display_name,
        quantity: l.quantity,
        unit_price_minor: l.unit_price_minor,
        line_subtotal_minor: l.quantity * l.unit_price_minor,
        note: l.note,
        version: l.version,
        last_action_id: `a-${l.line_id}`,
      })),
      discount_placeholders: [],
    };
    return Promise.resolve({ kind: 'ok' as const, envelope });
  });
  const update = vi.fn((req: CartLinesUpdateRequest) => {
    const line = lines.find((l) => l.line_id === req.line_id);
    if (state !== CartState.editing || line === undefined || line.version !== req.version) {
      return Promise.resolve({ kind: 'refused' as const, reason: 'frozen' as const });
    }
    line.quantity += 1;
    line.version += 1;
    return Promise.resolve({ kind: 'ok' as const, version: line.version });
  });
  const cartCreate = vi.fn();
  const cart = {
    create: cartCreate,
    snapshot: vi.fn(() => Promise.resolve({ kind: 'ok' as const, snapshot: snapshot() })),
    lines: { add: vi.fn(), update, remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    cancelPostHandoff: vi.fn(),
    handoff,
    subscribe: vi.fn(),
    returnToSale,
  } as unknown as CartBridgeAPI;
  return { cart, returnToSale, handoff, update, cartCreate, getState: () => state };
}

const catalogue = {
  search: vi.fn(),
  lookupBarcode: vi.fn(),
  lookupSku: vi.fn(),
  resolve: vi.fn(),
  freshness: vi.fn().mockResolvedValue({ kind: 'ok', last_success_at: null, is_empty: true }),
  refresh: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' }),
  counts: vi.fn(),
} as unknown as CatalogueBridgeAPI;

function LocationProbe(): JSX.Element {
  return <div data-testid="location-probe">{useLocation().pathname}</div>;
}

function SaleRoute(props: { cart: CartBridgeAPI }): JSX.Element {
  const navigate = useNavigate();
  return (
    <LiveSaleWorkspace
      cartBridge={props.cart}
      catalogueBridge={catalogue}
      onPaymentContinue={() => {
        void navigate('/app/checkout');
      }}
    />
  );
}

beforeEach(() => {
  useFeatureFlagsStore.setState({ cart: true, productSearch: false, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-04T09:00:00Z',
  });
  // The cashier already rang this cart; the Sale re-reads it from main.
  useCartStore.setState({
    activeCart: { cart_id: CART, state: CartState.editing, lastLineId: 'line-b' },
  });
});

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function cartLines(): HTMLElement {
  return screen.getByRole('list', { name: 'أصناف السلة' });
}

describe('RT-26 — Sale → Checkout → Esc → edit → Checkout', () => {
  it('returns to the same editable sale and re-enters Checkout on a fresh envelope', async () => {
    const main = fakeMain();
    (window as unknown as { api?: unknown }).api = {
      cart: main.cart,
      payments: {
        start: vi.fn(),
        confirm: vi.fn(),
        cancel: vi.fn(),
        subscribe: vi.fn(),
        read: vi.fn(),
      },
      tender: { apply: vi.fn(), reverse: vi.fn(), read: vi.fn() },
    };
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <Routes>
          <Route path="/app/cart" element={<SaleRoute cart={main.cart} />} />
          <Route path="/app/checkout" element={<CheckoutRoute />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );

    // Sale: hand off and continue to Checkout.
    expect(
      await within(await screen.findByRole('list', { name: 'أصناف السلة' })).findByText(
        'باراسيتامول',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /تسليم السلة للدفع/ }));
    await user.click(await screen.findByRole('button', { name: /المتابعة إلى الدفع/ }));
    expect(await screen.findByTestId('payment-surface')).toBeInTheDocument();
    expect(usePaymentStore.getState().envelope?.handoff_action_id).toBe('handoff-1');

    // Esc: main returns the cart; the Sale shows the SAME lines, editable.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/app/cart');
    });
    expect(main.returnToSale).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: CART, handoff_action_id: 'handoff-1' }),
    );
    expect(main.getState()).toBe(CartState.editing);
    const list = await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(within(list).getByText('باراسيتامول')).toBeInTheDocument();
    expect(within(list).getByText('فيتامين سي')).toBeInTheDocument();
    expect(within(list).getByText('ملاحظة: بعد الأكل')).toBeInTheDocument();
    expect(within(list).getByLabelText('الكمية 2')).toBeInTheDocument();
    expect(usePaymentStore.getState().envelope).toBeNull();
    expect(main.cartCreate).not.toHaveBeenCalled();

    // Edit the same draft, then go to Checkout again.
    await user.click(within(cartLines()).getByRole('button', { name: 'زيادة كمية باراسيتامول' }));
    expect(await within(cartLines()).findByLabelText('الكمية 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /تسليم السلة للدفع/ }));
    await user.click(await screen.findByRole('button', { name: /المتابعة إلى الدفع/ }));
    expect(await screen.findByTestId('payment-surface')).toBeInTheDocument();

    const fresh = usePaymentStore.getState().envelope;
    expect(fresh?.cart_id).toBe(CART);
    expect(fresh?.handoff_action_id).toBe('handoff-2');
    expect(fresh?.subtotal_minor).toBe(3 * 1250 + 2500);
    expect(main.handoff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cart_id: CART,
        per_line_versions: [
          { line_id: 'line-a', version: 4 },
          { line_id: 'line-b', version: 1 },
        ],
      }),
    );
  });
});
