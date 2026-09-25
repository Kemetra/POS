/**
 * Legacy /app/cart post-handoff cancel. A manager's "Void (post-handoff)" on a
 * frozen cart goes through `cart.cancelPostHandoff` with the frozen envelope's
 * handoff action — not through `cart.void`, which main always refuses with
 * `frozen`. A refusal keeps the cart frozen and the confirmation open.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { CartBridgeAPI } from '../../../../../src/shared/bridge-api.js';
import type { PaymentIntentEnvelope } from '../../../../../src/shared/cart/handoff-envelope.js';
import { CartPane } from '../../../../../src/renderer/ui/cart/CartPane.js';
import { useCartStore } from '../../../../../src/renderer/stores/cart-store.js';
import { usePaymentStore } from '../../../../../src/renderer/stores/payment-store.js';
import { useOperatorSessionStore } from '../../../../../src/renderer/stores/operator-session-store.js';
import { CartState } from '../../../../../src/shared/cart/cart-state.js';

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-ph',
  operator_session_id: 'sess-ph',
  owning_operator_id: 'op-ph',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 1500,
  created_at: '2026-09-25T10:00:00.000Z',
  handoff_action_id: 'handoff-action-ph',
};

function signIn(role: 'cashier' | 'manager' | 'admin'): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-ph',
        operator_id: 'op-ph',
        display_name: 'Test User',
        role,
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        started_at: new Date().toISOString(),
      },
    },
  });
  useCartStore.setState({
    activeCart: { cart_id: 'cart-ph', state: CartState.frozen_handed_off, lastLineId: null },
  });
}

function makeBridge(cancel: ReturnType<typeof vi.fn>): {
  bridge: CartBridgeAPI;
  voidFn: ReturnType<typeof vi.fn>;
} {
  const voidFn = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'frozen' });
  const bridge = {
    create: vi.fn(),
    void: voidFn,
    cancelPostHandoff: cancel,
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
  } as unknown as CartBridgeAPI;
  return { bridge, voidFn };
}

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  vi.clearAllMocks();
});

describe('CartPane — post-handoff cancel', () => {
  it.each(['manager', 'admin'] as const)(
    'a %s cancels the frozen cart through cancelPostHandoff',
    async (role) => {
      const cancel = vi.fn().mockResolvedValue({ kind: 'ok' });
      const { bridge, voidFn } = makeBridge(cancel);
      signIn(role);
      render(<CartPane _testBridge={bridge} _testInitialEnvelope={ENVELOPE} />);
      await userEvent.click(screen.getByTestId('cart-void-button'));
      await userEvent.click(screen.getByRole('button', { name: 'Void cart' }));
      await waitFor(() => {
        expect(useCartStore.getState().activeCart?.state).toBe(CartState.cancelled);
      });
      expect(cancel).toHaveBeenCalledWith(
        expect.objectContaining({ cart_id: 'cart-ph', handoff_action_id: 'handoff-action-ph' }),
      );
      expect(voidFn).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('keeps the cart frozen and the confirmation open when main refuses', async () => {
    const cancel = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'closed' });
    const { bridge, voidFn } = makeBridge(cancel);
    signIn('manager');
    render(<CartPane _testBridge={bridge} _testInitialEnvelope={ENVELOPE} />);
    await userEvent.click(screen.getByTestId('cart-void-button'));
    await userEvent.click(screen.getByRole('button', { name: 'Void cart' }));
    await waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(voidFn).not.toHaveBeenCalled();
  });

  it('keeps the cart frozen when the transport rejects', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('ipc down'));
    const { bridge } = makeBridge(cancel);
    signIn('manager');
    render(<CartPane _testBridge={bridge} _testInitialEnvelope={ENVELOPE} />);
    await userEvent.click(screen.getByTestId('cart-void-button'));
    await userEvent.click(screen.getByRole('button', { name: 'Void cart' }));
    await waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers a cashier no post-handoff cancel at all', () => {
    const { bridge } = makeBridge(vi.fn());
    signIn('cashier');
    render(<CartPane _testBridge={bridge} _testInitialEnvelope={ENVELOPE} />);
    expect(screen.queryByTestId('cart-void-button')).toBeNull();
  });
});
