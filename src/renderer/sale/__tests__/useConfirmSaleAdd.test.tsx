import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useConfirmSaleAdd } from '../useConfirmSaleAdd';

const product = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function pending(): void {
  const store = useCatalogueSearchStore.getState();
  act(() => {
    store.beginSearch('بنادول');
    store.resolveSingleMatch(product);
  });
}

afterEach(() => {
  useCatalogueSearchStore.getState().reset();
});

describe('useConfirmSaleAdd', () => {
  it('only forwards a bridge-confirmed line after explicit confirmation', async () => {
    pending();
    const add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'بنادول',
      unit_price_minor: 1500,
      line_subtotal_minor: 1500,
      quantity: 1,
      version: 1,
      merged: false,
    });
    const onLineAdded = vi.fn();
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const { result } = renderHook(() =>
      useConfirmSaleAdd({ cartId: 'cart-1', bridge, onLineAdded }),
    );
    expect(add).not.toHaveBeenCalled();
    await act(async () => result.current.confirm());
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1', item_ref: 'p-1', quantity: 1 }),
    );
    expect(onLineAdded).toHaveBeenCalledOnce();
    expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
  });

  it('keeps a refused add retryable without mutating the cart projection', async () => {
    pending();
    const add = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'wrong_owner' });
    const onLineAdded = vi.fn();
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const { result } = renderHook(() =>
      useConfirmSaleAdd({ cartId: 'cart-1', bridge, onLineAdded }),
    );
    await act(async () => result.current.confirm());
    expect(result.current.error).toMatch(/تعذّرت الإضافة/);
    expect(result.current.adding).toBe(false);
    expect(useCatalogueSearchStore.getState().state.kind).toBe('confirm_pending');
    expect(onLineAdded).not.toHaveBeenCalled();
  });

  it('with no cart yet, creates one through ensureCart and adds to it', async () => {
    pending();
    const add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'بنادول',
      unit_price_minor: 1500,
      line_subtotal_minor: 1500,
      quantity: 1,
      version: 1,
      merged: false,
    });
    const ensureCart = vi.fn().mockResolvedValue('cart-new');
    const onLineAdded = vi.fn();
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const { result } = renderHook(() =>
      useConfirmSaleAdd({ cartId: '', ensureCart, bridge, onLineAdded }),
    );
    await act(async () => result.current.confirm());
    expect(ensureCart).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-new' }));
    expect(onLineAdded).toHaveBeenCalledOnce();
  });

  it('a failed cart create shows the generic error, adds nothing, and Add retries it (#466)', async () => {
    pending();
    const add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'بنادول',
      unit_price_minor: 1500,
      line_subtotal_minor: 1500,
      quantity: 1,
      version: 1,
      merged: false,
    });
    const ensureCart = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('cart-2');
    const onLineAdded = vi.fn();
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const { result } = renderHook(() =>
      useConfirmSaleAdd({ cartId: '', ensureCart, bridge, onLineAdded }),
    );
    await act(async () => result.current.confirm());
    expect(add).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
    expect(useCatalogueSearchStore.getState().state.kind).toBe('confirm_pending');
    await act(async () => result.current.confirm());
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-2' }));
    expect(onLineAdded).toHaveBeenCalledOnce();
  });

  it('fails closed with no cart id and no way to create one', async () => {
    pending();
    const add = vi.fn();
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const { result } = renderHook(() =>
      useConfirmSaleAdd({ cartId: '', bridge, onLineAdded: vi.fn() }),
    );
    await act(async () => result.current.confirm());
    expect(add).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
  });
});
