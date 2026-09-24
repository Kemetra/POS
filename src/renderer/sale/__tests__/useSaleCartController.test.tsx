import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import { useCartStore } from '../../stores/cart-store';
import { usePaymentStore } from '../../stores/payment-store';
import { useSaleCartController } from '../useSaleCartController';

const initialLine = {
  lineId: 'line-1',
  displayName: 'بنادول',
  quantity: 1,
  unitPriceMinor: 1850,
  lineSubtotalMinor: 1850,
  note: null,
  version: 1,
};

function cartBridge(): {
  bridge: CartBridgeAPI;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  setNote: ReturnType<typeof vi.fn>;
  handoff: ReturnType<typeof vi.fn>;
  voidCart: ReturnType<typeof vi.fn>;
  removeDiscount: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const remove = vi.fn();
  const setNote = vi.fn();
  const handoff = vi.fn();
  const voidCart = vi.fn();
  const removeDiscount = vi.fn();
  const bridge: CartBridgeAPI = {
    create: vi.fn(),
    lines: {
      add: vi.fn(),
      update,
      remove,
      setNote,
    },
    discountPlaceholders: { add: vi.fn(), remove: removeDiscount },
    void: voidCart,
    handoff,
    subscribe: vi.fn(),
  };
  return { bridge, update, remove, setNote, handoff, voidCart, removeDiscount };
}

afterEach(() => {
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
});

describe('useSaleCartController', () => {
  it('projects bridge-confirmed adds and merges into one versioned line list', () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { result } = renderHook(() => useSaleCartController());

    act(() => {
      result.current.acceptAddedLine({
        line_id: 'line-1',
        display_name: 'بنادول',
        unit_price_minor: 1850,
        line_subtotal_minor: 1850,
        quantity: 1,
        version: 1,
        merged: false,
      });
    });
    expect(result.current.lines).toEqual([
      {
        lineId: 'line-1',
        displayName: 'بنادول',
        quantity: 1,
        unitPriceMinor: 1850,
        lineSubtotalMinor: 1850,
        note: null,
        version: 1,
      },
    ]);
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.editing);

    act(() => {
      result.current.acceptAddedLine({
        line_id: 'line-1',
        display_name: 'بنادول',
        unit_price_minor: 1850,
        line_subtotal_minor: 3700,
        quantity: 2,
        version: 2,
        merged: true,
      });
    });
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0]).toMatchObject({
      quantity: 2,
      lineSubtotalMinor: 3700,
      version: 2,
    });
    expect(useCartStore.getState().activeCart?.lastLineId).toBe('line-1');
  });

  it('changes quantity and version only after the cart bridge confirms an increment', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { bridge, update } = cartBridge();
    update.mockResolvedValueOnce({ kind: 'refused', reason: 'stale_version' });
    update.mockResolvedValueOnce({ kind: 'ok', version: 2 });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => result.current.incrementLine('line-1', 1));
    expect(result.current.lines[0]).toMatchObject({
      quantity: 1,
      lineSubtotalMinor: 1850,
      version: 1,
    });

    await act(async () => result.current.incrementLine('line-1', 1));
    expect(result.current.lines[0]).toMatchObject({
      quantity: 2,
      lineSubtotalMinor: 3700,
      version: 2,
    });
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      cart_id: 'cart-1',
      line_id: 'line-1',
      op: 'increment',
      version: 1,
    });
  });

  it('removes a quantity-one line only after the decrement response succeeds', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { bridge, update } = cartBridge();
    update.mockResolvedValue({ kind: 'ok', version: 2 });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => result.current.decrementLine('line-1', 1));
    expect(result.current.lines).toEqual([]);
  });

  it('keeps a line on refused removal and clears it after confirmed removal', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { bridge, remove } = cartBridge();
    remove.mockResolvedValueOnce({ kind: 'refused', reason: 'stale_version' });
    remove.mockResolvedValueOnce({ kind: 'ok' });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => result.current.removeLine('line-1', 1));
    expect(result.current.lines).toHaveLength(1);
    await act(async () => result.current.removeLine('line-1', 1));
    expect(result.current.lines).toEqual([]);
  });

  it('saves a note with the confirmed version and returns refusal without changing it', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { bridge, setNote } = cartBridge();
    setNote.mockResolvedValueOnce({ kind: 'refused', reason: 'stale_version' });
    setNote.mockResolvedValueOnce({ kind: 'ok', version: 2 });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => {
      expect(await result.current.saveNote('line-1', 1, 'بعد الطعام')).toBe(false);
    });
    expect(result.current.lines[0]?.note).toBeNull();
    await act(async () => {
      expect(await result.current.saveNote('line-1', 1, 'بعد الطعام')).toBe(true);
    });
    expect(result.current.lines[0]).toMatchObject({ note: 'بعد الطعام', version: 2 });
  });

  it('freezes a confirmed handoff before mounting its envelope for checkout', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    useCartStore.getState().applyLineAdded('line-1');
    const { bridge, handoff } = cartBridge();
    const envelope = {
      envelope_version: 'v1' as const,
      cart_id: 'cart-1',
      operator_session_id: 'session-1',
      owning_operator_id: 'operator-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      lines: [
        {
          line_id: 'line-1',
          item_ref: 'product-1',
          display_name: 'بنادول',
          quantity: 1,
          unit_price_minor: 1850,
          line_subtotal_minor: 1850,
          note: null,
          version: 1,
          last_action_id: 'add-1',
        },
      ],
      discount_placeholders: [],
      subtotal_minor: 1850,
      created_at: '2026-09-23T20:00:00.000Z',
      handoff_action_id: 'handoff-1',
    };
    handoff.mockResolvedValue({ kind: 'ok', envelope });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => result.current.handoff());
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.frozen_handed_off);
    expect(result.current.envelope).toEqual(envelope);
    expect(handoff.mock.calls[0]?.[0]).toMatchObject({
      cart_id: 'cart-1',
      per_line_versions: [{ line_id: 'line-1', version: 1 }],
    });

    const navigate = vi.fn();
    act(() => {
      result.current.continueToPayment(navigate);
    });
    expect(usePaymentStore.getState().envelope).toEqual(envelope);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('rolls handoff refusal back to editing without creating an envelope', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    useCartStore.getState().applyLineAdded('line-1');
    const { bridge, handoff } = cartBridge();
    handoff.mockResolvedValue({ kind: 'refused', reason: 'stale_version' });
    const { result } = renderHook(() =>
      useSaleCartController({ initialLines: [initialLine], bridge }),
    );

    await act(async () => result.current.handoff());
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.editing);
    expect(result.current.envelope).toBeNull();
    expect(result.current.handoffError).toBe('Could not hand off. Please try again.');
  });

  it('applies void and discount removal only after bridge confirmation', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    useCartStore.getState().applyLineAdded('line-1');
    const { bridge, voidCart, removeDiscount } = cartBridge();
    voidCart.mockResolvedValue({ kind: 'ok' });
    removeDiscount.mockResolvedValue({ kind: 'ok' });
    const { result } = renderHook(() =>
      useSaleCartController({
        initialLines: [initialLine],
        initialDiscountPlaceholders: [
          { placeholderId: 'discount-1', attribution_operator_id: null, lineId: 'line-1' },
        ],
        bridge,
      }),
    );

    await act(async () => result.current.removeDiscount('discount-1'));
    expect(result.current.discountPlaceholders).toEqual([]);
    await act(async () => result.current.voidCart());
    expect(useCartStore.getState().activeCart?.state).toBe(CartState.cancelled);
  });
});
