import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { useCartStore } from '../../stores/cart-store';
import { usePaymentStore } from '../../stores/payment-store';
import { useSaleCartController } from '../useSaleCartController';

/**
 * Post-handoff cancel routing. A frozen, handed-off cart is cancelled through
 * `cart.cancelPostHandoff` (the audited, manager-authorised main operation),
 * never through `cart.void` (which main refuses with `frozen`). The request
 * is bound to the frozen envelope's authoritative `handoff_action_id`, and
 * every precondition the renderer cannot prove fails closed without a call.
 */

const LINE = {
  lineId: 'line-1',
  displayName: 'بنادول',
  quantity: 1,
  unitPriceMinor: 1500,
  lineSubtotalMinor: 1500,
  note: null,
  version: 2,
};

function envelope(overrides: Partial<PaymentIntentEnvelope> = {}): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: 1500,
    created_at: '2026-09-25T10:00:00.000Z',
    handoff_action_id: 'handoff-action-1',
    ...overrides,
  };
}

function bridge(
  overrides: { cancel?: ReturnType<typeof vi.fn> | null; void?: ReturnType<typeof vi.fn> } = {},
): {
  api: CartBridgeAPI;
  voidFn: ReturnType<typeof vi.fn>;
  cancelFn: ReturnType<typeof vi.fn>;
} {
  const voidFn = overrides.void ?? vi.fn().mockResolvedValue({ kind: 'ok' });
  const cancelFn = overrides.cancel ?? vi.fn().mockResolvedValue({ kind: 'ok' });
  const api = {
    create: vi.fn(),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: voidFn,
    handoff: vi.fn(),
    subscribe: vi.fn(),
    ...(overrides.cancel === null ? {} : { cancelPostHandoff: cancelFn }),
  } as unknown as CartBridgeAPI;
  return { api, voidFn, cancelFn };
}

function frozenCart(cartId = 'cart-1'): void {
  useCartStore.setState({
    activeCart: { cart_id: cartId, state: CartState.frozen_handed_off, lastLineId: 'line-1' },
  });
}

function renderFrozen(api: CartBridgeAPI, env: PaymentIntentEnvelope | null = envelope()) {
  frozenCart();
  return renderHook(() =>
    useSaleCartController({
      bridge: api,
      initialLines: [LINE],
      ...(env !== null ? { initialEnvelope: env } : {}),
    }),
  );
}

async function voidNow(result: { current: ReturnType<typeof useSaleCartController> }) {
  let ok = false;
  await act(async () => {
    ok = await result.current.voidCart();
  });
  return ok;
}

afterEach(() => {
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  vi.restoreAllMocks();
});

describe('shared Sale cart controller — void routing', () => {
  it('still voids an editing cart through cart.void and never calls cancelPostHandoff', async () => {
    const b = bridge();
    useCartStore.setState({
      activeCart: { cart_id: 'cart-1', state: CartState.editing, lastLineId: 'line-1' },
    });
    const { result } = renderHook(() =>
      useSaleCartController({ bridge: b.api, initialLines: [LINE] }),
    );
    expect(await voidNow(result)).toBe(true);
    expect(b.voidFn).toHaveBeenCalledOnce();
    expect(b.cancelFn).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.cancelled);
  });

  it('cancels a frozen cart through cancelPostHandoff bound to the envelope handoff action', async () => {
    const b = bridge();
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(true);
    expect(b.voidFn).not.toHaveBeenCalled();
    expect(b.cancelFn).toHaveBeenCalledOnce();
    const req = b.cancelFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['cart_id', 'handoff_action_id', 'idempotency_key']);
    expect(req['cart_id']).toBe('cart-1');
    expect(req['handoff_action_id']).toBe('handoff-action-1');
    expect(req['idempotency_key']).toMatch(/^[0-9a-f-]{36}$/);
    // No fabricated attribution: main decides whether this role may cancel.
    expect(req).not.toHaveProperty('attribution_operator_id');
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.cancelled);
  });

  it('sends a fresh idempotency key on every attempt', async () => {
    const cancel = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'role_denied' });
    const b = bridge({ cancel });
    const { result } = renderFrozen(b.api);
    await voidNow(result);
    await voidNow(result);
    const keys = cancel.mock.calls.map(
      (c) => (c[0] as { idempotency_key: string }).idempotency_key,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps the frozen cart, its lines and envelope when main refuses', async () => {
    const b = bridge({
      cancel: vi
        .fn()
        .mockResolvedValue({ kind: 'refused', reason: 'manager_attribution_required' }),
    });
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(false);
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(result.current.lines).toEqual([LINE]);
    expect(result.current.envelope?.handoff_action_id).toBe('handoff-action-1');
  });

  it('keeps the frozen cart when the transport rejects', async () => {
    const b = bridge({ cancel: vi.fn().mockRejectedValue(new Error('ipc down')) });
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(false);
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(result.current.lines).toEqual([LINE]);
  });
});

describe('shared Sale cart controller — post-handoff cancel fails closed', () => {
  it.each([
    ['no frozen envelope', null],
    ['an envelope for another cart', envelope({ cart_id: 'cart-other' })],
    ['an empty handoff action id', envelope({ handoff_action_id: '' })],
  ] as const)('refuses without any bridge call given %s', async (_label, env) => {
    const b = bridge();
    const { result } = renderFrozen(b.api, env);
    expect(await voidNow(result)).toBe(false);
    expect(b.cancelFn).not.toHaveBeenCalled();
    expect(b.voidFn).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
  });

  it('never falls back to cart.void when the bridge lacks cancelPostHandoff', async () => {
    const b = bridge({ cancel: null });
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(false);
    expect(b.voidFn).not.toHaveBeenCalled();
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
  });

  it.each(['started', 'settled'] as const)(
    'refuses while a %s payment for this cart is known to the renderer',
    async (state) => {
      const b = bridge();
      usePaymentStore.getState().mount(envelope());
      usePaymentStore.getState().applyAttemptSnapshot({
        payment_attempt_id: 'attempt-1',
        state,
        envelope_subtotal_minor: 1500,
        started_at: '2026-09-25T10:01:00.000Z',
        tender_lines: [],
      });
      const { result } = renderFrozen(b.api);
      expect(await voidNow(result)).toBe(false);
      expect(b.cancelFn).not.toHaveBeenCalled();
      expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    },
  );
});

describe('shared Sale cart controller — a cancelled cart can no longer reach checkout', () => {
  it('drops the mounted payment envelope for this cart once main confirms the cancel', async () => {
    const b = bridge();
    usePaymentStore.getState().mount(envelope());
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(true);
    expect(usePaymentStore.getState().envelope).toBeNull();
    expect(result.current.envelope).toBeNull();
  });

  it('keeps a payment envelope that belongs to another cart', async () => {
    const b = bridge();
    usePaymentStore.getState().mount(envelope({ cart_id: 'cart-other' }));
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(true);
    expect(usePaymentStore.getState().envelope?.cart_id).toBe('cart-other');
  });

  it('keeps the mounted envelope when main refuses the cancel', async () => {
    const b = bridge({ cancel: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'closed' }) });
    usePaymentStore.getState().mount(envelope());
    const { result } = renderFrozen(b.api);
    expect(await voidNow(result)).toBe(false);
    expect(usePaymentStore.getState().envelope?.cart_id).toBe('cart-1');
  });
});
