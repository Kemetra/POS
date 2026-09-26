import { useCallback, useRef } from 'react';
import type {
  CartBridgeAPI,
  CatalogueBridgeAPI,
  CatalogueLookupResponse,
  CatalogueSearchResponse,
  PreloadBridgeAPI,
} from '../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../shared/catalogue/product-snapshot';
import { useCartStore } from '../stores/cart-store';
import { useCatalogueSearchStore } from '../stores/catalogueSearchStore';

interface SaleCatalogueOptions {
  readonly cartId?: string;
  readonly cartBridge?: CartBridgeAPI;
  readonly catalogueBridge?: CatalogueBridgeAPI;
}

function readBridges(): { cart: CartBridgeAPI; catalogue: CatalogueBridgeAPI } {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api || !api.catalogue) throw new Error('Sale catalogue: preload bridge not initialised.');
  return { cart: api.cart, catalogue: api.catalogue };
}

type SearchStore = ReturnType<typeof useCatalogueSearchStore.getState>;

/** Map a typed-search response onto the FSM; `too_short` / `refused` return to idle. */
function applySearchResponse(store: SearchStore, res: CatalogueSearchResponse): void {
  switch (res.kind) {
    case 'results':
      store.resolveResults(res.items, res.truncated);
      break;
    case 'not_found':
      store.resolveNotFound();
      break;
    case 'catalogue_unavailable':
      store.resolveCatalogueUnavailable();
      break;
    case 'too_short':
    case 'refused':
      store.clear();
      break;
  }
}

/** Map a barcode lookup onto the FSM; a refusal returns to idle without a reason. */
function applyScanResponse(store: SearchStore, res: CatalogueLookupResponse): void {
  switch (res.kind) {
    case 'one':
      store.resolveSingleMatch(res.product);
      break;
    case 'not_found':
      store.resolveNotFound();
      break;
    case 'ambiguous':
      store.resolveAmbiguous();
      break;
    case 'catalogue_unavailable':
      store.resolveCatalogueUnavailable();
      break;
    case 'refused':
      store.clear();
      break;
  }
}

export function useSaleCatalogueController(options: SaleCatalogueOptions): {
  state: ReturnType<typeof useCatalogueSearchStore.getState>['state'];
  effectiveCartId: string;
  runTypedSearch: (query: string) => Promise<void>;
  runScan: (barcode: string) => Promise<void>;
  selectResult: (product: ProductSnapshotDisplay) => void;
  recover: () => void;
  ensureCart: () => Promise<string | null>;
} {
  const state = useCatalogueSearchStore((store) => store.state);
  const activeCart = useCartStore((store) => store.activeCart);
  // Single-flight cart create. The cart is created lazily by the first
  // confirmed add (#466), never eagerly on mount or reset: every add attempt
  // is then a natural retry, and a permanent refusal surfaces as the add's
  // generic error instead of a silent, never-retried effect.
  const creatingRef = useRef<Promise<string | null> | null>(null);
  // Latest-lookup generation: the FSM guards only on `searching`, so without
  // this an older lookup answering after a newer one began (or after a New
  // sale reset and a fresh search) would resolve against the newer request.
  const lookupGenRef = useRef(0);
  const getCart = useCallback(() => options.cartBridge ?? readBridges().cart, [options.cartBridge]);
  const getCatalogue = useCallback(
    () => options.catalogueBridge ?? readBridges().catalogue,
    [options.catalogueBridge],
  );

  const ensureCart = useCallback((): Promise<string | null> => {
    if (options.cartId !== undefined && options.cartId !== '') {
      return Promise.resolve(options.cartId);
    }
    const existing = useCartStore.getState().activeCart;
    if (existing !== null) return Promise.resolve(existing.cart_id);
    if (creatingRef.current !== null) return creatingRef.current;
    const pending = getCart()
      .create({ idempotency_key: crypto.randomUUID() })
      .then((res) => {
        if (res.kind !== 'ok') return null;
        useCartStore.getState().applyCartCreated(res.cart_id);
        return res.cart_id;
      })
      .catch(() => null)
      .finally(() => {
        creatingRef.current = null;
      });
    creatingRef.current = pending;
    return pending;
  }, [getCart, options.cartId]);

  const runTypedSearch = useCallback(
    async (query: string): Promise<void> => {
      const gen = ++lookupGenRef.current;
      useCatalogueSearchStore.getState().beginSearch(query);
      try {
        const res = await getCatalogue().search({ query });
        if (gen !== lookupGenRef.current) return;
        applySearchResponse(useCatalogueSearchStore.getState(), res);
      } catch {
        if (gen === lookupGenRef.current) useCatalogueSearchStore.getState().clear();
      }
    },
    [getCatalogue],
  );

  const runScan = useCallback(
    async (barcode: string): Promise<void> => {
      const gen = ++lookupGenRef.current;
      useCatalogueSearchStore.getState().beginSearch(barcode);
      try {
        const res = await getCatalogue().lookupBarcode({ barcode });
        if (gen !== lookupGenRef.current) return;
        applyScanResponse(useCatalogueSearchStore.getState(), res);
      } catch {
        if (gen === lookupGenRef.current) useCatalogueSearchStore.getState().clear();
      }
    },
    [getCatalogue],
  );

  const selectResult = useCallback((product: ProductSnapshotDisplay): void => {
    useCatalogueSearchStore.getState().selectResult(product);
  }, []);
  const recover = useCallback((): void => {
    useCatalogueSearchStore.getState().clear();
  }, []);

  return {
    state,
    effectiveCartId: options.cartId ?? activeCart?.cart_id ?? '',
    runTypedSearch,
    runScan,
    selectResult,
    recover,
    ensureCart,
  };
}
