import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useSaleCatalogueController } from '../useSaleCatalogueController';

const product = {
  product_id: 'product-1',
  display_name_ar: 'بنادول',
  price_minor: 1850,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function bridges() {
  const create = vi.fn();
  const search = vi.fn();
  const lookupBarcode = vi.fn();
  const cart: CartBridgeAPI = {
    create,
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
  };
  const catalogue: CatalogueBridgeAPI = {
    search,
    lookupBarcode,
    lookupSku: vi.fn(),
    resolve: vi.fn(),
    refresh: vi.fn(),
    freshness: vi.fn(),
    counts: vi.fn(),
  };
  return { cart, catalogue, create, search, lookupBarcode };
}

afterEach(() => {
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
});

describe('useSaleCatalogueController', () => {
  it('does not create a cart on mount — the first confirmed add creates it (#466)', async () => {
    const { cart, catalogue, create } = bridges();
    create.mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' });
    const { result, rerender } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    rerender();
    await act(async () => Promise.resolve());
    expect(create).not.toHaveBeenCalled();
    expect(result.current.effectiveCartId).toBe('');
  });

  it('ensureCart creates one cart, publishes it, and shares one in-flight create', async () => {
    const { cart, catalogue, create } = bridges();
    let answer: (value: unknown) => void = () => undefined;
    create.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    let first: Promise<string | null> = Promise.resolve(null);
    let second: Promise<string | null> = Promise.resolve(null);
    act(() => {
      first = result.current.ensureCart();
      second = result.current.ensureCart();
    });
    await act(async () => {
      answer({ kind: 'ok', cart_id: 'cart-1' });
      await first;
    });
    await expect(first).resolves.toBe('cart-1');
    await expect(second).resolves.toBe('cart-1');
    expect(create).toHaveBeenCalledOnce();
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-1');
    expect(result.current.effectiveCartId).toBe('cart-1');
    await expect(result.current.ensureCart()).resolves.toBe('cart-1');
    expect(create).toHaveBeenCalledOnce();
  });

  it('a refused or failed create returns null and the next ensureCart retries (#466)', async () => {
    const { cart, catalogue, create } = bridges();
    create
      .mockResolvedValueOnce({ kind: 'refused', reason: 'no_session' })
      .mockRejectedValueOnce(new Error('transport'))
      .mockResolvedValueOnce({ kind: 'ok', cart_id: 'cart-2' });
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    await act(async () => {
      await expect(result.current.ensureCart()).resolves.toBeNull();
    });
    expect(useCartStore.getState().activeCart).toBeNull();
    await act(async () => {
      await expect(result.current.ensureCart()).resolves.toBeNull();
    });
    await act(async () => {
      await expect(result.current.ensureCart()).resolves.toBe('cart-2');
    });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('ensureCart reuses an explicit or already-active cart without creating', async () => {
    const { cart, catalogue, create } = bridges();
    const explicit = renderHook(() =>
      useSaleCatalogueController({ cartId: 'given', cartBridge: cart, catalogueBridge: catalogue }),
    );
    await expect(explicit.result.current.ensureCart()).resolves.toBe('given');
    useCartStore.getState().applyCartCreated('cart-9');
    const active = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    await expect(active.result.current.ensureCart()).resolves.toBe('cart-9');
    expect(create).not.toHaveBeenCalled();
  });

  it('maps search and exact scan responses through the existing FSM', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { cart, catalogue, search, lookupBarcode } = bridges();
    search.mockResolvedValue({ kind: 'results', items: [product], truncated: false });
    lookupBarcode.mockResolvedValue({ kind: 'one', product });
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );

    await act(async () => {
      await result.current.runTypedSearch('بنادول');
    });
    expect(result.current.state.kind).toBe('results');
    act(() => {
      result.current.selectResult(product);
    });
    expect(result.current.state.kind).toBe('confirm_pending');
    act(() => {
      result.current.recover();
    });
    await act(async () => {
      await result.current.runScan('6223004355218');
    });
    expect(result.current.state.kind).toBe('confirm_pending');
    expect(search.mock.calls[0]?.[0]).toEqual({ query: 'بنادول' });
    expect(lookupBarcode.mock.calls[0]?.[0]).toEqual({ barcode: '6223004355218' });
  });

  it('ignores a superseded lookup that answers after a newer one began', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { cart, catalogue, lookupBarcode } = bridges();
    const newer = { ...product, product_id: 'product-2', display_name_ar: 'كونجستال' };
    let answerOld: (value: unknown) => void = () => undefined;
    let answerNew: (value: unknown) => void = () => undefined;
    lookupBarcode
      .mockReturnValueOnce(new Promise((resolve) => (answerOld = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerNew = resolve)));
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );

    let oldScan: Promise<void> = Promise.resolve();
    let newScan: Promise<void> = Promise.resolve();
    act(() => {
      oldScan = result.current.runScan('6220000000001');
      newScan = result.current.runScan('6220000000002');
    });
    await act(async () => {
      answerOld({ kind: 'one', product });
      await oldScan;
    });
    expect(result.current.state).toEqual({ kind: 'searching', query: '6220000000002' });

    await act(async () => {
      answerNew({ kind: 'one', product: newer });
      await newScan;
    });
    expect(result.current.state).toEqual({ kind: 'confirm_pending', product: newer });
  });

  it('a superseded lookup that fails does not clear the newer one', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { cart, catalogue, search } = bridges();
    let failOld: (reason: unknown) => void = () => undefined;
    search
      .mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );

    let oldSearch: Promise<void> = Promise.resolve();
    act(() => {
      oldSearch = result.current.runTypedSearch('بنا');
      void result.current.runTypedSearch('بنادول');
    });
    await act(async () => {
      failOld(new Error('ipc down'));
      await oldSearch;
    });
    expect(result.current.state).toEqual({ kind: 'searching', query: 'بنادول' });
  });
});
