import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { CatalogueSalePane } from '../CatalogueSalePane.js';
import { useCatalogueSearchStore } from '../../../stores/catalogueSearchStore.js';
import { useCartStore } from '../../../stores/cart-store.js';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../../shared/bridge-api.js';
import type { ProductSnapshotDisplay } from '../../../../shared/catalogue/product-snapshot.js';

const PRODUCT: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول إكسترا',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function catalogueBridge(over: Partial<CatalogueBridgeAPI> = {}): CatalogueBridgeAPI {
  return {
    lookupBarcode: vi.fn(),
    lookupSku: vi.fn(),
    search: vi.fn(),
    resolve: vi.fn(),
    refresh: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const }),
    ),
    freshness: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, last_success_at: null, is_empty: true }),
    ),
    counts: vi.fn(() => Promise.resolve({ kind: 'ok' as const, products: 0, barcodes: 0 })),
    ...over,
  };
}

function cartBridge(): CartBridgeAPI {
  return {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' }),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
  };
}

beforeEach(() => {
  useCatalogueSearchStore.getState().reset();
  // Reset the cart store suite-wide too — `activeCart` would otherwise leak
  // across tests and make later cases order-sensitive (CodeRabbit #327).
  useCartStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CatalogueSalePane — typed search → FSM (T049a wiring a)', () => {
  it('a typed search calls catalogue.search and drives the FSM to results', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ kind: 'results', items: [PRODUCT], truncated: false });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith({ query: 'بنادول' });
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('results');
    });
  });

  it('maps catalogue_unavailable search response to the FSM', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'catalogue_unavailable' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('catalogue_unavailable');
    });
  });

  it('maps not_found search response to the FSM', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('not_found');
    });
  });
});

describe('CatalogueSalePane — scan → exact lookup → FSM (T049a wiring a)', () => {
  it('a scan calls catalogue.lookupBarcode and a single match → confirm_pending', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'one', product: PRODUCT });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '6221000000001' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(lookupBarcode).toHaveBeenCalledWith({ barcode: '6221000000001' });
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('confirm_pending');
    });
  });

  it('an ambiguous scan → ambiguous state (FR-7)', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'ambiguous' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '111' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('ambiguous');
    });
  });

  it('a result-row click → selectResult → confirm_pending', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ kind: 'results', items: [PRODUCT], truncated: false });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('option')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('confirm_pending');
    });
  });
});

describe('CatalogueSalePane — lazy cart lifecycle (T049a wiring b, #466)', () => {
  beforeEach(() => {
    useCartStore.getState().reset();
  });

  it('creates no cart on mount; the first confirmed add creates one and records it (#466)', async () => {
    const create = vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-new' });
    const add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'Panadol',
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      quantity: 1,
      version: 1,
      merged: false,
    });
    const cb = {
      create,
      lines: { add, update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as CartBridgeAPI;

    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'one', product: PRODUCT });
    render(
      <CatalogueSalePane
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cb}
      />,
    );
    await act(async () => Promise.resolve());
    expect(create).not.toHaveBeenCalled();

    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '6221000000001' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));

    await waitFor(() => {
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-new' }));
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-new');
  });

  it('does NOT create a cart when one already exists', async () => {
    useCartStore.getState().applyCartCreated('cart-existing');
    const create = vi.fn();
    const cb = {
      create,
      lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as CartBridgeAPI;

    render(
      <CatalogueSalePane
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge()}
        cartBridge={cb}
      />,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(create).not.toHaveBeenCalled();
  });
});

describe('CatalogueSalePane — remaining response mappings (T049a coverage)', () => {
  it('typed search too_short clears the FSM back to idle', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'too_short' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('typed search refused clears the FSM back to idle (generic, NFR-6a)', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('a scan with no match → not_found', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '000' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('not_found');
    });
  });

  it('a scan against an unavailable catalogue → catalogue_unavailable', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'catalogue_unavailable' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '222' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('catalogue_unavailable');
    });
  });

  it('a refused scan clears the FSM back to idle (generic, NFR-6a)', async () => {
    const lookupBarcode = vi
      .fn()
      .mockResolvedValue({ kind: 'refused', reason: 'tenant_isolation' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '333' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(lookupBarcode).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });
});

describe('CatalogueSalePane — error-state surfaces are mounted live (T050 F1)', () => {
  it('renders the not-found surface when a search misses (Surface 5 / FR-6)', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-not-found')).toBeInTheDocument();
    });
  });

  it('the not-found surface echoes the searched value (Surface 5 — "shows the scanned/typed value")', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: '6221000000000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-not-found')).toHaveTextContent('6221000000000');
    });
  });

  it('renders the ambiguous-barcode surface when a scan is ambiguous (Surface 7 / FR-7)', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'ambiguous' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '111' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-ambiguous')).toBeInTheDocument();
    });
  });

  it('renders the catalogue-unavailable surface when the read model is unavailable (Surface 6 / FR-24)', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'catalogue_unavailable' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-unavailable')).toBeInTheDocument();
    });
  });

  it('the not-found Edit control clears the FSM back to idle (FR-6 recovery)', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-not-found')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /تعديل/ }));
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('returns focus to the search input after not-found Edit (S0 keyboard recovery)', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-not-found')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /تعديل/ }));
    await waitFor(() => {
      expect(screen.getByRole('searchbox')).toHaveFocus();
    });
  });

  it('the ambiguous Edit control clears the FSM back to idle (FR-7 recovery)', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'ambiguous' });
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '111' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-ambiguous')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /تعديل/ }));
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('exposes a busy indicator while a search is in flight (Surface 2 / aria-busy)', async () => {
    // A search that never resolves keeps the FSM in `searching` so the busy
    // surface is observable (F2).
    const search = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-searching')).toHaveAttribute('aria-busy', 'true');
    });
  });
});

describe('CatalogueSalePane — bridge rejection degrades to idle (T049a resilience)', () => {
  it('a rejected catalogue.search resets the FSM to idle (no stuck searching)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('ipc transport error'));
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('a rejected catalogue.lookupBarcode resets the FSM to idle', async () => {
    const lookupBarcode = vi.fn().mockRejectedValue(new Error('ipc transport error'));
    render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '444' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(lookupBarcode).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(useCatalogueSearchStore.getState().state.kind).toBe('idle');
    });
  });

  it('a rejected cart.create on Add leaves activeCart null, adds nothing, and the next Add retries (#466)', async () => {
    useCartStore.getState().reset();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc transport error'))
      .mockResolvedValueOnce({ kind: 'ok', cart_id: 'cart-retry' });
    const add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'Panadol',
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      quantity: 1,
      version: 1,
      merged: false,
    });
    const cb = {
      create,
      lines: { add, update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as CartBridgeAPI;
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'one', product: PRODUCT });
    render(
      <CatalogueSalePane
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cb}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '6221000000001' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The rejection is swallowed; no cart recorded, no line added, no throw.
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(add).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => {
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ cart_id: 'cart-retry' }));
    });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
