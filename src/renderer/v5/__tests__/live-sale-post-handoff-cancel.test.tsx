import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { CartSnapshot } from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { Role } from '../../../shared/operator/role';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

/**
 * V5 post-handoff cancel: a manager reopening a handed-off (unpaid) sale can
 * cancel it through `cart.cancelPostHandoff`, bound to the persisted
 * envelope's handoff action. V5's fresh-sale transition (renderer reset; the
 * next confirmed add creates the next cart, #466) happens only after main confirms.
 */

const FROZEN = 'cart-frozen';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

function snapshot(paid = false): CartSnapshot {
  return {
    cart_id: FROZEN,
    state: CartState.frozen_handed_off,
    paid,
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
    envelope: paid
      ? null
      : {
          envelope_version: 'v1',
          cart_id: FROZEN,
          operator_session_id: 'session-1',
          owning_operator_id: 'op-1',
          tenant_id: 'tenant-1',
          branch_id: 'branch-1',
          terminal_id: 'terminal-1',
          handoff_action_id: 'handoff-persisted',
          created_at: '2026-09-25T09:05:00.000Z',
          subtotal_minor: 1250,
          lines: [],
          discount_placeholders: [],
        },
  };
}

function setup(role: Role, cancel: ReturnType<typeof vi.fn>, paid = false) {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-25T09:00:00Z',
  });
  useCartStore.setState({
    activeCart: { cart_id: FROZEN, state: CartState.frozen_handed_off, lastLineId: 'line-a' },
  });
  const fns = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-fresh' }),
    voidCart: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'frozen' }),
    cancel,
  };
  const cart = {
    create: fns.create,
    snapshot: vi.fn().mockResolvedValue({ kind: 'ok', snapshot: snapshot(paid) }),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: fns.voidCart,
    cancelPostHandoff: fns.cancel,
    handoff: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as CartBridgeAPI;
  const catalogue = {
    search: vi.fn(),
    lookupBarcode: vi.fn(),
    lookupSku: vi.fn(),
    resolve: vi.fn(),
    freshness: vi.fn().mockResolvedValue({ kind: 'ok', last_success_at: null, is_empty: true }),
    refresh: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' }),
    counts: vi.fn(),
  } as unknown as CatalogueBridgeAPI;
  render(
    <LiveSaleWorkspace cartBridge={cart} catalogueBridge={catalogue} onPaymentContinue={vi.fn()} />,
  );
  return fns;
}

async function confirmVoid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'إلغاء البيع' }));
  await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
}

describe('V5 post-handoff cancel', () => {
  it('cancels through cancelPostHandoff, then starts the fresh sale', async () => {
    const fns = setup('manager', vi.fn().mockResolvedValue({ kind: 'ok' }));
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(fns.create).not.toHaveBeenCalled();
    await confirmVoid(user);
    expect(await screen.findByText('تم إلغاء البيع.')).toBeInTheDocument();
    expect(fns.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: FROZEN, handoff_action_id: 'handoff-persisted' }),
    );
    expect(fns.voidCart).not.toHaveBeenCalled();
    // The fresh sale starts with no cart; the next confirmed add creates it (#466).
    await waitFor(() => {
      expect(useCartStore.getState().activeCart).toBeNull();
    });
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('keeps the frozen sale and starts nothing new when main refuses', async () => {
    const fns = setup('manager', vi.fn().mockResolvedValue({ kind: 'refused', reason: 'closed' }));
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'أصناف السلة' });
    await confirmVoid(user);
    await waitFor(() => {
      expect(fns.cancel).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole('dialog', { name: 'تأكيد إلغاء البيع' })).toBeInTheDocument();
    expect(useCartStore.getState().activeCart).toEqual(
      expect.objectContaining({ cart_id: FROZEN, state: CartState.frozen_handed_off }),
    );
    expect(screen.queryByText('تم إلغاء البيع.')).not.toBeInTheDocument();
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('keeps the frozen sale when the transport rejects', async () => {
    const fns = setup('manager', vi.fn().mockRejectedValue(new Error('ipc down')));
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'أصناف السلة' });
    await confirmVoid(user);
    await waitFor(() => {
      expect(fns.cancel).toHaveBeenCalledOnce();
    });
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(fns.create).not.toHaveBeenCalled();
  });

  it('offers a cashier no post-handoff cancel', async () => {
    const fns = setup('cashier', vi.fn());
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(screen.queryByRole('button', { name: 'إلغاء البيع' })).not.toBeInTheDocument();
    expect(fns.cancel).not.toHaveBeenCalled();
  });
});

describe('V5 reopening a sale main reports as paid', () => {
  it('shows it as paid with New sale, never Continue to payment or Void', async () => {
    const fns = setup('manager', vi.fn(), true);
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(await screen.findByText('تم الدفع لهذه السلة.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'بيع جديد' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /المتابعة إلى الدفع/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إلغاء البيع' })).not.toBeInTheDocument();
    expect(fns.cancel).not.toHaveBeenCalled();
  });
});
