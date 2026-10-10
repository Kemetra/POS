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

  it('ensureCart does not adopt a cart whose create answers after its sale ended (RT-242)', async () => {
    const { cart, catalogue, create } = bridges();
    create.mockResolvedValue({ kind: 'ok', cart_id: 'cart-late' });
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    let current = true;
    let pending: Promise<string | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.ensureCart(() => current);
      current = false;
    });
    let id: string | null = 'unset';
    await act(async () => {
      id = await pending;
    });
    expect(id).toBeNull();
    expect(useCartStore.getState().activeCart).toBeNull();
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

  it('maps typed search through the FSM; a scan lookup returns the raw answer (D-C1)', async () => {
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
    let answer: unknown = null;
    await act(async () => {
      answer = await result.current.lookupScan('6223004355218');
    });
    expect(answer).toEqual({ kind: 'one', product });
    // A scan opens no results panel and closes the one that was open.
    expect(result.current.state.kind).toBe('idle');
    expect(search.mock.calls[0]?.[0]).toEqual({ query: 'بنادول' });
    expect(lookupBarcode.mock.calls[0]?.[0]).toEqual({ barcode: '6223004355218' });
  });

  it('a scan supersedes a typed search still in flight, so its late answer opens nothing', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const { cart, catalogue, search, lookupBarcode } = bridges();
    let answerSearch: (value: unknown) => void = () => undefined;
    search.mockReturnValueOnce(new Promise((resolve) => (answerSearch = resolve)));
    lookupBarcode.mockResolvedValue({ kind: 'one', product });
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );

    let typed: Promise<void> = Promise.resolve();
    act(() => {
      typed = result.current.runTypedSearch('بنا');
    });
    await act(async () => {
      await result.current.lookupScan('6223004355218');
    });
    await act(async () => {
      answerSearch({ kind: 'results', items: [product], truncated: false });
      await typed;
    });
    expect(result.current.state.kind).toBe('idle');
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

  // Ported from the retired legacy CatalogueSalePane suite (023 Slice H):
  // the response → FSM mapping now lives only in this hook.
  it.each([
    [{ kind: 'not_found' }, 'not_found'],
    [{ kind: 'catalogue_unavailable' }, 'catalogue_unavailable'],
    [{ kind: 'too_short' }, 'idle'],
    [{ kind: 'refused', reason: 'no_session' }, 'idle'],
  ])('maps typed search %o to %s', async (response, expected) => {
    const { cart, catalogue, search } = bridges();
    search.mockResolvedValue(response);
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    await act(async () => {
      await result.current.runTypedSearch('بنادول');
    });
    expect(result.current.state.kind).toBe(expected);
  });

  it('a rejected search returns the FSM to idle; a rejected scan lookup answers null', async () => {
    const { cart, catalogue, search, lookupBarcode } = bridges();
    search.mockRejectedValue(new Error('ipc'));
    lookupBarcode.mockRejectedValue(new Error('ipc'));
    const { result } = renderHook(() =>
      useSaleCatalogueController({ cartBridge: cart, catalogueBridge: catalogue }),
    );
    await act(async () => {
      await result.current.runTypedSearch('بنادول');
    });
    expect(result.current.state.kind).toBe('idle');
    let answer: unknown = 'unset';
    await act(async () => {
      answer = await result.current.lookupScan('6223004355218');
    });
    expect(answer).toBeNull();
    expect(result.current.state.kind).toBe('idle');
  });
});
