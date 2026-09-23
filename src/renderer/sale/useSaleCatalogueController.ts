import { useCallback, useEffect, useRef } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
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

export function useSaleCatalogueController(options: SaleCatalogueOptions): {
  state: ReturnType<typeof useCatalogueSearchStore.getState>['state'];
  effectiveCartId: string;
  runTypedSearch: (query: string) => Promise<void>;
  runScan: (barcode: string) => Promise<void>;
  selectResult: (product: ProductSnapshotDisplay) => void;
  recover: () => void;
} {
  const state = useCatalogueSearchStore((store) => store.state);
  const activeCart = useCartStore((store) => store.activeCart);
  const creatingRef = useRef(false);
  const getCart = useCallback(() => options.cartBridge ?? readBridges().cart, [options.cartBridge]);
  const getCatalogue = useCallback(
    () => options.catalogueBridge ?? readBridges().catalogue,
    [options.catalogueBridge],
  );

  useEffect(() => {
    if (options.cartId !== undefined && options.cartId !== '') return;
    if (activeCart !== null || creatingRef.current) return;
    creatingRef.current = true;
    void getCart()
      .create({ idempotency_key: crypto.randomUUID() })
      .then((res) => {
        if (res.kind === 'ok') useCartStore.getState().applyCartCreated(res.cart_id);
      })
      .catch(() => undefined)
      .finally(() => {
        creatingRef.current = false;
      });
  }, [activeCart, getCart, options.cartId]);

  const runTypedSearch = useCallback(
    async (query: string): Promise<void> => {
      useCatalogueSearchStore.getState().beginSearch(query);
      try {
        const res = await getCatalogue().search({ query });
        const store = useCatalogueSearchStore.getState();
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
      } catch {
        useCatalogueSearchStore.getState().clear();
      }
    },
    [getCatalogue],
  );

  const runScan = useCallback(
    async (barcode: string): Promise<void> => {
      useCatalogueSearchStore.getState().beginSearch(barcode);
      try {
        const res = await getCatalogue().lookupBarcode({ barcode });
        const store = useCatalogueSearchStore.getState();
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
      } catch {
        useCatalogueSearchStore.getState().clear();
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
  };
}
