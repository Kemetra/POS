import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { CartSnapshot, CartSnapshotResponse } from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

/**
 * V5 active cart read: when the renderer already knows an active cart (for
 * example one started on legacy /app/cart), V5 reopens THAT cart from the
 * main-process snapshot instead of creating a new one or showing it empty.
 */

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const EXISTING = 'cart-existing';

const PARA: ProductSnapshotDisplay = {
  product_id: 'p-para',
  display_name_ar: 'باراسيتامول',
  price_minor: 1250,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function snapshot(overrides: Partial<CartSnapshot> = {}): CartSnapshot {
  return {
    cart_id: EXISTING,
    state: CartState.editing,
    // Contract since the §A4 review: main reports a settled cart as paid.
    paid: false,
    lines: [
      {
        line_id: 'line-a',
        display_name: 'باراسيتامول',
        quantity: 1,
        unit_price_minor: 1250,
        line_subtotal_minor: 1250,
        note: null,
        version: 4,
      },
      {
        line_id: 'line-b',
        display_name: 'أموكسيسيلين',
        quantity: 3,
        unit_price_minor: 4500,
        line_subtotal_minor: 13500,
        note: 'بعد الأكل',
        version: 2,
      },
    ],
    discount_placeholders: [],
    envelope: null,
    ...overrides,
  };
}

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: EXISTING,
  operator_session_id: 'session-1',
  owning_operator_id: 'op-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  handoff_action_id: 'handoff-1',
  created_at: '2026-09-24T09:05:00.000Z',
  subtotal_minor: 14750,
  lines: [],
  discount_placeholders: [],
};

function signIn(): void {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-24T09:00:00Z',
  });
}

function existingCart(state: CartState = CartState.editing): void {
  useCartStore.setState({ activeCart: { cart_id: EXISTING, state, lastLineId: null } });
}

function bridges(snapshotImpl: () => Promise<CartSnapshotResponse>): {
  cart: CartBridgeAPI;
  catalogue: CatalogueBridgeAPI;
  fns: Record<'create' | 'snapshot' | 'update' | 'add', ReturnType<typeof vi.fn>>;
} {
  const fns = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-new' }),
    snapshot: vi.fn(snapshotImpl),
    update: vi.fn().mockResolvedValue({ kind: 'ok', version: 5 }),
    add: vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-a',
      merged: true,
      version: 5,
      display_name: 'باراسيتامول',
      unit_price_minor: 1250,
      line_subtotal_minor: 2500,
      quantity: 2,
    }),
  };
  const cart = {
    create: fns.create,
    snapshot: fns.snapshot,
    lines: { add: fns.add, update: fns.update, remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as CartBridgeAPI;
  const catalogue = {
    search: vi.fn(),
    lookupBarcode: vi.fn().mockResolvedValue({ kind: 'one', product: PARA }),
    lookupSku: vi.fn(),
    resolve: vi.fn(),
    freshness: vi.fn().mockResolvedValue({ kind: 'ok', last_success_at: null, is_empty: true }),
    refresh: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' }),
    counts: vi.fn(),
  } as unknown as CatalogueBridgeAPI;
  return { cart, catalogue, fns };
}

function renderSale(
  b: ReturnType<typeof bridges>,
  onPaymentContinue = vi.fn(),
): ReturnType<typeof render> {
  return render(
    <LiveSaleWorkspace
      cartBridge={b.cart}
      catalogueBridge={b.catalogue}
      onPaymentContinue={onPaymentContinue}
    />,
  );
}

function cartLines(): HTMLElement {
  return screen.getByRole('list', { name: 'أصناف السلة' });
}

describe('V5 hydrates an existing active cart', () => {
  it('reads that exact cart and renders its persisted lines, without creating a cart', async () => {
    signIn();
    existingCart();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    renderSale(b);

    const list = await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(b.fns.snapshot).toHaveBeenCalledOnce();
    expect(b.fns.snapshot).toHaveBeenCalledWith({ cart_id: EXISTING });
    expect(within(list).getByText('باراسيتامول')).toBeInTheDocument();
    expect(within(list).getByText('أموكسيسيلين')).toBeInTheDocument();
    expect(within(list).getByLabelText('الكمية 3')).toBeInTheDocument();
    expect(within(list).getByText('ملاحظة: بعد الأكل')).toBeInTheDocument();
    expect(screen.getAllByText('147.50 EGP').length).toBeGreaterThan(0);
    expect(b.fns.create).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.cart_id).toBe(EXISTING);
  });

  it('keeps an empty existing cart as the same cart', async () => {
    signIn();
    existingCart(CartState.empty);
    const b = bridges(() =>
      Promise.resolve({ kind: 'ok', snapshot: snapshot({ state: CartState.empty, lines: [] }) }),
    );
    renderSale(b);
    await screen.findByText('لا توجد أصناف في السلة بعد.');
    expect(b.fns.snapshot).toHaveBeenCalledWith({ cart_id: EXISTING });
    expect(b.fns.create).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart).toEqual({
      cart_id: EXISTING,
      state: CartState.empty,
      lastLineId: null,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('carries persisted versions into the next mutation on the same cart and line', async () => {
    signIn();
    existingCart();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    renderSale(b);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'أصناف السلة' });

    await user.click(screen.getByRole('button', { name: 'زيادة كمية باراسيتامول' }));
    expect(b.fns.update).toHaveBeenCalledWith(
      expect.objectContaining({
        cart_id: EXISTING,
        line_id: 'line-a',
        op: 'increment',
        version: 4,
      }),
    );
    await waitFor(() => {
      expect(within(cartLines()).getAllByLabelText('الكمية 2')).toHaveLength(1);
    });
  });

  it('merges a re-scanned product into the hydrated row instead of duplicating it', async () => {
    signIn();
    existingCart();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    renderSale(b);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'أصناف السلة' });

    await user.type(
      screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
      '6221000000011{Enter}',
    );
    await user.click(await screen.findByRole('button', { name: 'إضافة إلى السلة' }));
    expect(b.fns.add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: EXISTING }));
    await waitFor(() => {
      expect(within(cartLines()).getAllByText('باراسيتامول')).toHaveLength(1);
    });
    expect(within(cartLines()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('continues a handed-off cart to payment with its persisted envelope', async () => {
    signIn();
    existingCart(CartState.frozen_handed_off);
    const b = bridges(() =>
      Promise.resolve({
        kind: 'ok',
        snapshot: snapshot({ state: CartState.frozen_handed_off, envelope: ENVELOPE }),
      }),
    );
    const onPaymentContinue = vi.fn();
    renderSale(b, onPaymentContinue);
    const user = userEvent.setup();
    const proceed = await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    await waitFor(() => {
      expect(proceed).toBeEnabled();
    });
    await user.click(proceed);
    expect(onPaymentContinue).toHaveBeenCalledOnce();
    expect(usePaymentStore.getState().envelope).toEqual(ENVELOPE);
  });

  it('syncs the renderer cart state to the authoritative snapshot state', async () => {
    signIn();
    existingCart(CartState.empty);
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    renderSale(b);
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(useCartStore.getState().activeCart).toEqual({
      cart_id: EXISTING,
      state: CartState.editing,
      lastLineId: 'line-b',
    });
  });
});

describe('V5 active cart read failure', () => {
  it('shows a recoverable error, never creates a replacement cart, and retries the same cart', async () => {
    signIn();
    existingCart();
    let attempt = 0;
    const b = bridges(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ kind: 'refused', reason: 'wrong_owner' })
        : Promise.resolve({ kind: 'ok', snapshot: snapshot() });
    });
    renderSale(b);
    const user = userEvent.setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر تحميل السلة الحالية.');
    expect(screen.queryByText(/wrong_owner/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'حقل التقاط مسح الباركود' })).toBeNull();
    expect(b.fns.create).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.cart_id).toBe(EXISTING);

    await user.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('list', { name: 'أصناف السلة' })).toBeInTheDocument();
    expect(b.fns.snapshot).toHaveBeenCalledTimes(2);
    expect(b.fns.snapshot).toHaveBeenLastCalledWith({ cart_id: EXISTING });
    expect(b.fns.create).not.toHaveBeenCalled();
  });

  it('treats a rejected transport like a refusal', async () => {
    signIn();
    existingCart();
    const b = bridges(() => Promise.reject(new Error('ipc down')));
    renderSale(b);
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر تحميل السلة الحالية.');
    expect(b.fns.create).not.toHaveBeenCalled();
  });

  it('treats a bridge without the read as a failure, never as an empty cart', async () => {
    signIn();
    existingCart();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    delete (b.cart as { snapshot?: unknown }).snapshot;
    renderSale(b);
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر تحميل السلة الحالية.');
    expect(screen.queryByText('لا توجد أصناف في السلة بعد.')).not.toBeInTheDocument();
    expect(b.fns.create).not.toHaveBeenCalled();
  });

  it('refuses a snapshot for a different cart than the one it asked for', async () => {
    signIn();
    existingCart();
    const b = bridges(() =>
      Promise.resolve({ kind: 'ok', snapshot: snapshot({ cart_id: 'someone-else' }) }),
    );
    renderSale(b);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('أموكسيسيلين')).not.toBeInTheDocument();
  });

  it('shows a loading state while the read is in flight and ignores a late response after unmount', async () => {
    signIn();
    existingCart();
    let resolve: (value: CartSnapshotResponse) => void = () => undefined;
    const b = bridges(
      () =>
        new Promise<CartSnapshotResponse>((r) => {
          resolve = r;
        }),
    );
    const view = renderSale(b);
    expect(screen.getByRole('status')).toHaveTextContent('جارٍ تحميل السلة الحالية…');
    view.unmount();
    await act(async () => {
      resolve({ kind: 'ok', snapshot: snapshot() });
      await Promise.resolve();
    });
    expect(b.fns.create).not.toHaveBeenCalled();
  });
});

describe('V5 with no active cart', () => {
  it('keeps the create-cart path and never reads a snapshot', async () => {
    signIn();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: snapshot() }));
    renderSale(b);
    await waitFor(() => {
      expect(b.fns.create).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-new');
    });
    expect(b.fns.snapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
