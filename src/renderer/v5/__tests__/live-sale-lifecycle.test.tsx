import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { CartSnapshot, CartSnapshotResponse } from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type { PaymentAttemptRendererView } from '../../../shared/payments/types';
import type { Role } from '../../../shared/operator/role';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

/**
 * V5 sale lifecycle: a paid sale reopened on V5 is recognised as completed
 * (never offered to payment again), and a successful void returns V5 to a
 * fresh sale. Both end states hand the next cart to the unchanged catalogue
 * create path; neither handler ever calls `cart.create` itself.
 */

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const PAID = 'cart-paid';

const PARA: ProductSnapshotDisplay = {
  product_id: 'p-para',
  display_name_ar: 'باراسيتامول',
  price_minor: 1250,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function envelope(cartId: string, handoffId = 'handoff-1'): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: cartId,
    operator_session_id: 'session-1',
    owning_operator_id: 'op-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    handoff_action_id: handoffId,
    created_at: '2026-09-24T09:05:00.000Z',
    subtotal_minor: 1250,
    lines: [],
    discount_placeholders: [],
  };
}

function frozenSnapshot(cartId: string = PAID): CartSnapshot {
  return {
    cart_id: cartId,
    state: CartState.frozen_handed_off,
    lines: [
      {
        line_id: 'line-a',
        display_name: 'باراسيتامول',
        quantity: 1,
        unit_price_minor: 1250,
        line_subtotal_minor: 1250,
        note: null,
        version: 3,
      },
    ],
    discount_placeholders: [],
    envelope: envelope(cartId),
  };
}

function attempt(state: PaymentAttemptRendererView['state']): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-1',
    state,
    envelope_subtotal_minor: 1250,
    started_at: '2026-09-24T09:06:00.000Z',
    ...(state === 'settled' ? { settled_at: '2026-09-24T09:07:00.000Z' } : {}),
    tender_lines: [],
  };
}

function signIn(role: Role = 'cashier'): void {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-24T09:00:00Z',
  });
}

/** The renderer state left behind when checkout settled but New sale was never pressed. */
function leftCheckoutAfterSettle(paymentCartId: string = PAID): void {
  useCartStore.setState({
    activeCart: { cart_id: PAID, state: CartState.frozen_handed_off, lastLineId: 'line-a' },
  });
  usePaymentStore.getState().mount(envelope(paymentCartId));
  usePaymentStore.getState().applyAttemptSnapshot(attempt('settled'));
}

function bridges(snapshotImpl: () => Promise<CartSnapshotResponse>): {
  cart: CartBridgeAPI;
  catalogue: CatalogueBridgeAPI;
  fns: Record<'create' | 'snapshot' | 'add' | 'voidCart', ReturnType<typeof vi.fn>>;
} {
  const fns = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-fresh' }),
    snapshot: vi.fn(snapshotImpl),
    add: vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-new',
      merged: false,
      version: 1,
      display_name: 'باراسيتامول',
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      quantity: 1,
    }),
    voidCart: vi.fn().mockResolvedValue({ kind: 'ok' }),
  };
  const cart = {
    create: fns.create,
    snapshot: fns.snapshot,
    lines: { add: fns.add, update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: fns.voidCart,
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

function renderSale(b: ReturnType<typeof bridges>, onPaymentContinue = vi.fn()): void {
  render(
    <LiveSaleWorkspace
      cartBridge={b.cart}
      catalogueBridge={b.catalogue}
      onPaymentContinue={onPaymentContinue}
    />,
  );
}

async function scanAndAdd(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(
    screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
    '6221000000011{Enter}',
  );
  await user.click(await screen.findByRole('button', { name: 'إضافة إلى السلة' }));
}

describe('V5 reopens a sale whose payment already settled', () => {
  it('never offers Continue to payment and offers New sale instead', async () => {
    signIn();
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    const onPaymentContinue = vi.fn();
    renderSale(b, onPaymentContinue);

    expect(await screen.findByRole('button', { name: 'بيع جديد' })).toBeEnabled();
    expect(screen.getByText('تم الدفع لهذه السلة.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /المتابعة إلى الدفع/ })).not.toBeInTheDocument();
    // The same completed sale is shown, read-only.
    expect(
      within(screen.getByRole('list', { name: 'أصناف السلة' })).getByText('باراسيتامول'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /زيادة كمية/ })).not.toBeInTheDocument();
    expect(onPaymentContinue).not.toHaveBeenCalled();
    expect(b.fns.create).not.toHaveBeenCalled();
  });

  it('does not offer Void on a paid sale, even to a manager', async () => {
    signIn('manager');
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    renderSale(b);
    await screen.findByRole('button', { name: 'بيع جديد' });
    expect(screen.queryByRole('button', { name: 'إلغاء البيع' })).not.toBeInTheDocument();
  });

  it('New sale resets the cart and payment renderer state', async () => {
    signIn();
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    b.fns.create.mockReturnValue(new Promise(() => undefined));
    renderSale(b);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'بيع جديد' }));

    expect(usePaymentStore.getState().envelope).toBeNull();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(await screen.findByText('لا توجد أصناف في السلة بعد.')).toBeInTheDocument();
    expect(screen.queryByText('تم الدفع لهذه السلة.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بيع جديد' })).not.toBeInTheDocument();
    // The finished cart is never read back again.
    expect(b.fns.snapshot).toHaveBeenCalledOnce();
  });

  it('New sale clears a pending catalogue confirmation left over from the finished sale', async () => {
    signIn();
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    b.fns.create.mockReturnValue(new Promise(() => undefined));
    renderSale(b);
    const user = userEvent.setup();
    const newSale = await screen.findByRole('button', { name: 'بيع جديد' });
    act(() => {
      useCatalogueSearchStore.getState().beginSearch('6221000000011');
      useCatalogueSearchStore.getState().resolveSingleMatch(PARA);
    });

    await user.click(newSale);

    expect(useCatalogueSearchStore.getState().state).toEqual({ kind: 'idle' });
    expect(screen.queryByRole('button', { name: 'إضافة إلى السلة' })).not.toBeInTheDocument();
  });

  it('New sale discards a catalogue lookup still in flight for the finished sale', async () => {
    signIn();
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    b.fns.create.mockReturnValue(new Promise(() => undefined));
    renderSale(b);
    const user = userEvent.setup();
    const newSale = await screen.findByRole('button', { name: 'بيع جديد' });
    act(() => {
      useCatalogueSearchStore.getState().beginSearch('6221000000011');
    });

    await user.click(newSale);
    // The stale lookup answers after the reset: the guarded resolver is a no-op.
    act(() => {
      useCatalogueSearchStore.getState().resolveSingleMatch(PARA);
    });

    expect(useCatalogueSearchStore.getState().state).toEqual({ kind: 'idle' });
    expect(screen.queryByRole('button', { name: 'إضافة إلى السلة' })).not.toBeInTheDocument();
    expect(b.fns.add).not.toHaveBeenCalled();
  });

  it('after New sale, the next add lands in exactly one fresh cart', async () => {
    signIn();
    leftCheckoutAfterSettle();
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    renderSale(b);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'بيع جديد' }));
    await waitFor(() => {
      expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-fresh');
    });
    await scanAndAdd(user);

    await waitFor(() => {
      expect(b.fns.add).toHaveBeenCalledOnce();
    });
    expect(b.fns.create).toHaveBeenCalledOnce();
    expect(b.fns.add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-fresh' }));
    expect(b.fns.add).not.toHaveBeenCalledWith(expect.objectContaining({ cart_id: PAID }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'أصناف السلة' })).getAllByRole('listitem'),
      ).toHaveLength(1);
    });
  });
});

describe('V5 frozen cart that is not known to be paid', () => {
  it('keeps Continue to payment when no payment attempt is known', async () => {
    signIn();
    useCartStore.setState({
      activeCart: { cart_id: PAID, state: CartState.frozen_handed_off, lastLineId: null },
    });
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    renderSale(b);
    const proceed = await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    await waitFor(() => {
      expect(proceed).toBeEnabled();
    });
    expect(screen.queryByRole('button', { name: 'بيع جديد' })).not.toBeInTheDocument();
    expect(useCartStore.getState().activeCart?.cart_id).toBe(PAID);
    expect(b.fns.create).not.toHaveBeenCalled();
  });

  it('does not treat a started (unsettled) attempt as paid', async () => {
    signIn();
    useCartStore.setState({
      activeCart: { cart_id: PAID, state: CartState.frozen_handed_off, lastLineId: null },
    });
    usePaymentStore.getState().mount(envelope(PAID));
    usePaymentStore.getState().applyAttemptSnapshot(attempt('started'));
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    renderSale(b);
    expect(await screen.findByRole('button', { name: /المتابعة إلى الدفع/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بيع جديد' })).not.toBeInTheDocument();
  });

  it('does not treat a settled payment for a different cart as this cart being paid', async () => {
    signIn();
    leftCheckoutAfterSettle('some-other-cart');
    const b = bridges(() => Promise.resolve({ kind: 'ok', snapshot: frozenSnapshot() }));
    renderSale(b);
    const proceed = await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    await waitFor(() => {
      expect(proceed).toBeEnabled();
    });
    expect(screen.queryByRole('button', { name: 'بيع جديد' })).not.toBeInTheDocument();
    expect(useCartStore.getState().activeCart?.cart_id).toBe(PAID);
  });
});

describe('V5 void returns to a fresh sale', () => {
  async function ringOneLine(
    b: ReturnType<typeof bridges>,
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await waitFor(() => {
      expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-first');
    });
    await scanAndAdd(user);
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(b.fns.add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-first' }));
  }

  async function confirmVoid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
  }

  it('clears the renderer pointer to the voided cart and the next add creates one fresh cart', async () => {
    signIn();
    const b = bridges(() => Promise.reject(new Error('no snapshot expected')));
    b.fns.create
      .mockResolvedValueOnce({ kind: 'ok', cart_id: 'cart-first' })
      .mockResolvedValueOnce({ kind: 'ok', cart_id: 'cart-second' });
    renderSale(b);
    const user = userEvent.setup();
    await ringOneLine(b, user);
    expect(b.fns.create).toHaveBeenCalledOnce();

    await confirmVoid(user);

    expect(await screen.findByText('تم إلغاء البيع.')).toBeInTheDocument();
    expect(b.fns.voidCart).toHaveBeenCalledOnce();
    expect(b.fns.voidCart).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-first' }));
    await waitFor(() => {
      expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-second');
    });
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.empty);
    expect(screen.getByText('لا توجد أصناف في السلة بعد.')).toBeInTheDocument();

    await scanAndAdd(user);
    await waitFor(() => {
      expect(b.fns.add).toHaveBeenCalledTimes(2);
    });
    expect(b.fns.add).toHaveBeenLastCalledWith(expect.objectContaining({ cart_id: 'cart-second' }));
    expect(b.fns.create).toHaveBeenCalledTimes(2);
    expect(b.fns.snapshot).not.toHaveBeenCalled();
    // The acknowledgement belongs to the voided sale, not the new one.
    await waitFor(() => {
      expect(screen.queryByText('تم إلغاء البيع.')).not.toBeInTheDocument();
    });
  });

  it('creates no replacement cart before the void succeeds', async () => {
    signIn();
    const b = bridges(() => Promise.reject(new Error('no snapshot expected')));
    b.fns.create.mockResolvedValue({ kind: 'ok', cart_id: 'cart-first' });
    let resolveVoid: (value: { kind: 'ok' }) => void = () => undefined;
    b.fns.voidCart.mockReturnValue(
      new Promise((r) => {
        resolveVoid = r;
      }),
    );
    renderSale(b);
    const user = userEvent.setup();
    await ringOneLine(b, user);

    await confirmVoid(user);
    expect(b.fns.voidCart).toHaveBeenCalledOnce();
    expect(b.fns.create).toHaveBeenCalledOnce();
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-first');

    resolveVoid({ kind: 'ok' });
    await waitFor(() => {
      expect(b.fns.create).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the existing cart intact when the void is refused', async () => {
    signIn();
    const b = bridges(() => Promise.reject(new Error('no snapshot expected')));
    b.fns.create.mockResolvedValue({ kind: 'ok', cart_id: 'cart-first' });
    b.fns.voidCart.mockResolvedValue({ kind: 'refused', reason: 'role_denied' });
    renderSale(b);
    const user = userEvent.setup();
    await ringOneLine(b, user);

    await confirmVoid(user);
    await waitFor(() => {
      expect(b.fns.voidCart).toHaveBeenCalledOnce();
    });
    expect(useCartStore.getState().activeCart).toEqual(
      expect.objectContaining({ cart_id: 'cart-first', state: CartState.editing }),
    );
    expect(
      within(screen.getByRole('list', { name: 'أصناف السلة' })).getByText('باراسيتامول'),
    ).toBeInTheDocument();
    expect(b.fns.create).toHaveBeenCalledOnce();
    expect(screen.queryByText('تم إلغاء البيع.')).not.toBeInTheDocument();
  });

  it('keeps the existing cart intact when the void transport rejects', async () => {
    signIn();
    const b = bridges(() => Promise.reject(new Error('no snapshot expected')));
    b.fns.create.mockResolvedValue({ kind: 'ok', cart_id: 'cart-first' });
    b.fns.voidCart.mockRejectedValue(new Error('ipc down'));
    renderSale(b);
    const user = userEvent.setup();
    await ringOneLine(b, user);

    await confirmVoid(user);
    await waitFor(() => {
      expect(b.fns.voidCart).toHaveBeenCalledOnce();
    });
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-first');
    expect(b.fns.create).toHaveBeenCalledOnce();
    expect(screen.queryByText('تم إلغاء البيع.')).not.toBeInTheDocument();
  });
});
