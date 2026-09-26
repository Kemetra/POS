import { useCallback, useRef, useState } from 'react';
import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import type { AddedLineResult } from './useSaleCartController';
import { useCatalogueSearchStore } from '../stores/catalogueSearchStore';

export interface ConfirmSaleAddOptions {
  /** The active cart, or `''` when none exists yet. */
  cartId: string;
  /** Creates (or returns) the active cart on the first add; `null` on failure. */
  ensureCart?: () => Promise<string | null>;
  onLineAdded: (line: AddedLineResult) => void;
  onResolved?: () => void;
  bridge?: CartBridgeAPI;
  quantity?: number;
}

const GENERIC_ADD_ERROR = 'تعذّرت الإضافة — حاول مرة أخرى (could not add — try again)';

function readCartBridge(): CartBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) throw new Error('Sale add: preload bridge not initialised.');
  return api.cart;
}

export function useConfirmSaleAdd(options: ConfirmSaleAddOptions): {
  product:
    | Extract<
        ReturnType<typeof useCatalogueSearchStore.getState>['state'],
        { kind: 'confirm_pending' }
      >['product']
    | null;
  adding: boolean;
  error: string | null;
  confirm: () => Promise<void>;
  cancel: () => void;
} {
  const state = useCatalogueSearchStore((store) => store.state);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const product = state.kind === 'confirm_pending' ? state.product : null;

  const confirm = useCallback(async (): Promise<void> => {
    const pending = useCatalogueSearchStore.getState().state;
    if (inFlight.current || pending.kind !== 'confirm_pending') return;
    inFlight.current = true;
    setAdding(true);
    setError(null);
    try {
      const cartId = options.cartId !== '' ? options.cartId : await options.ensureCart?.();
      if (cartId === undefined || cartId === null || cartId === '') {
        setError(GENERIC_ADD_ERROR);
        return;
      }
      const bridge = options.bridge ?? readCartBridge();
      const response = await bridge.lines.add({
        cart_id: cartId,
        item_ref: pending.product.product_id,
        quantity: options.quantity ?? 1,
        idempotency_key: crypto.randomUUID(),
      });
      if (response.kind === 'ok') {
        options.onLineAdded({
          line_id: response.line_id,
          display_name: response.display_name,
          unit_price_minor: response.unit_price_minor,
          line_subtotal_minor: response.line_subtotal_minor,
          quantity: response.quantity,
          version: response.version,
          merged: response.merged,
        });
        useCatalogueSearchStore.getState().confirmAdd();
        options.onResolved?.();
      } else {
        setError(GENERIC_ADD_ERROR);
      }
    } catch {
      setError(GENERIC_ADD_ERROR);
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  }, [options]);

  const cancel = useCallback((): void => {
    if (inFlight.current) return;
    setError(null);
    useCatalogueSearchStore.getState().cancelConfirm();
    options.onResolved?.();
  }, [options]);

  return { product, adding, error, confirm, cancel };
}
