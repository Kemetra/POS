import { useCallback, useEffect, useState } from 'react';
import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import type { CartSnapshot } from '../../shared/cart/bridge-types';
import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope';
import { CartState } from '../../shared/cart/cart-state';
import { useCartStore } from '../stores/cart-store';
import { usePaymentStore } from '../stores/payment-store';
import { resetSaleStores } from './reset-sale-stores';

export interface CartLineItem {
  lineId: string;
  displayName: string;
  quantity: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  note: string | null;
  version: number;
}

/** The display snapshot returned only after a successful cart.lines.add call. */
export interface AddedLineResult {
  line_id: string;
  display_name: string;
  unit_price_minor: number;
  line_subtotal_minor: number;
  quantity: number;
  version: number;
  merged: boolean;
}

export interface DiscountPlaceholderSeed {
  placeholderId: string;
  attribution_operator_id: string | null;
  lineId?: string | null;
}

interface SaleCartControllerOptions {
  readonly initialLines?: readonly CartLineItem[];
  readonly initialDiscountPlaceholders?: readonly DiscountPlaceholderSeed[];
  readonly initialEnvelope?: PaymentIntentEnvelope;
  readonly bridge?: CartBridgeAPI;
  /**
   * V5 active cart read. When true and the renderer already holds an active
   * cart AT MOUNT, the line projection is rebuilt from the authoritative
   * `cart.snapshot` of that exact cart instead of starting empty. A cart
   * created after mount is fresh and never read back.
   */
  readonly hydrateActiveCart?: boolean;
}

/** `ready` = projection usable; `loading` / `failed` = an existing cart is not yet known. */
export type CartHydration = 'ready' | 'loading' | 'failed';

function readCartBridge(): CartBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) throw new Error('Sale cart: preload bridge not initialised.');
  return api.cart;
}

function linesFromSnapshot(snapshot: CartSnapshot): CartLineItem[] {
  return snapshot.lines.map((line) => ({
    lineId: line.line_id,
    displayName: line.display_name,
    quantity: line.quantity,
    unitPriceMinor: line.unit_price_minor,
    lineSubtotalMinor: line.line_subtotal_minor,
    note: line.note,
    version: line.version,
  }));
}

/** Align the renderer cart FSM with the authoritative state; the id never changes. */
function syncCartStore(snapshot: CartSnapshot): void {
  useCartStore.setState((s) => {
    if (s.activeCart?.cart_id !== snapshot.cart_id) return s;
    const lastLine = snapshot.lines[snapshot.lines.length - 1];
    return {
      activeCart: {
        cart_id: snapshot.cart_id,
        state: snapshot.state,
        lastLineId: lastLine?.line_id ?? s.activeCart.lastLineId,
      },
    };
  });
}

export function useSaleCartController(options: SaleCartControllerOptions = {}): {
  lines: readonly CartLineItem[];
  discountPlaceholders: readonly DiscountPlaceholderSeed[];
  envelope: PaymentIntentEnvelope | null;
  handoffError: string | null;
  hydration: CartHydration;
  retryHydration: () => void;
  subtotalMinor: number;
  itemCount: number;
  acceptAddedLine: (result: AddedLineResult) => void;
  incrementLine: (lineId: string, version: number) => Promise<void>;
  decrementLine: (lineId: string, version: number) => Promise<void>;
  removeLine: (lineId: string, version: number) => Promise<void>;
  saveNote: (lineId: string, version: number, note: string | null) => Promise<boolean>;
  handoff: () => Promise<void>;
  voidCart: () => Promise<boolean>;
  removeDiscount: (placeholderId: string) => Promise<void>;
  continueToPayment: (onContinue?: () => void) => void;
  startNewSale: () => void;
} {
  const [lines, setLines] = useState<CartLineItem[]>(() => [...(options.initialLines ?? [])]);
  const [discountPlaceholders, setDiscountPlaceholders] = useState<DiscountPlaceholderSeed[]>(
    () => [...(options.initialDiscountPlaceholders ?? [])],
  );
  const [envelope, setEnvelope] = useState<PaymentIntentEnvelope | null>(
    options.initialEnvelope ?? null,
  );
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const getBridge = useCallback(() => options.bridge ?? readCartBridge(), [options.bridge]);

  // Captured once: only a cart that already existed when this controller
  // mounted is read back; the catalogue's eager create is left alone.
  const [hydrateCartId, setHydrateCartId] = useState<string | null>(() =>
    options.hydrateActiveCart === true
      ? (useCartStore.getState().activeCart?.cart_id ?? null)
      : null,
  );
  const [hydration, setHydration] = useState<CartHydration>(() =>
    hydrateCartId === null ? 'ready' : 'loading',
  );
  const [hydrationAttempt, setHydrationAttempt] = useState(0);

  useEffect(() => {
    if (hydrateCartId === null) return;
    let cancelled = false;
    const fail = (): void => {
      if (!cancelled) setHydration('failed');
    };
    const bridge = getBridge();
    // A bridge without the read is a generic failure, never an empty cart.
    const pending =
      bridge.snapshot !== undefined
        ? bridge.snapshot({ cart_id: hydrateCartId })
        : Promise.reject(new Error('cart snapshot unavailable'));
    pending.then((res) => {
      if (cancelled) return;
      // Generic failure: a refusal (any reason) or a mismatched cart never
      // renders as an empty cart and never triggers a replacement cart.
      if (res.kind !== 'ok' || res.snapshot.cart_id !== hydrateCartId) {
        fail();
        return;
      }
      setLines(linesFromSnapshot(res.snapshot));
      setDiscountPlaceholders(
        res.snapshot.discount_placeholders.map((dp) => ({
          placeholderId: dp.placeholder_id,
          lineId: dp.line_id,
          // Attribution is deliberately not projected to the renderer.
          attribution_operator_id: null,
        })),
      );
      setEnvelope(res.snapshot.envelope);
      syncCartStore(res.snapshot);
      setHydration('ready');
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [getBridge, hydrateCartId, hydrationAttempt]);

  const retryHydration = useCallback((): void => {
    setHydration('loading');
    setHydrationAttempt((n) => n + 1);
  }, []);

  const acceptAddedLine = useCallback((res: AddedLineResult): void => {
    useCartStore.getState().applyLineAdded(res.line_id);
    setLines((prev) => {
      if (res.merged) {
        return prev.map((line) =>
          line.lineId === res.line_id
            ? {
                ...line,
                quantity: res.quantity,
                lineSubtotalMinor: res.line_subtotal_minor,
                version: res.version,
              }
            : line,
        );
      }
      return [
        ...prev,
        {
          lineId: res.line_id,
          displayName: res.display_name,
          quantity: res.quantity,
          unitPriceMinor: res.unit_price_minor,
          lineSubtotalMinor: res.line_subtotal_minor,
          note: null,
          version: res.version,
        },
      ];
    });
  }, []);

  const incrementLine = useCallback(
    async (lineId: string, version: number): Promise<void> => {
      const cart = useCartStore.getState().activeCart;
      if (!cart) return;
      const res = await getBridge().lines.update({
        cart_id: cart.cart_id,
        line_id: lineId,
        op: 'increment',
        version,
        idempotency_key: crypto.randomUUID(),
      });
      if (res.kind !== 'ok') return;
      setLines((prev) =>
        prev.map((line) => {
          if (line.lineId !== lineId) return line;
          const quantity = line.quantity + 1;
          return {
            ...line,
            quantity,
            lineSubtotalMinor: quantity * line.unitPriceMinor,
            version: res.version,
          };
        }),
      );
    },
    [getBridge],
  );

  const decrementLine = useCallback(
    async (lineId: string, version: number): Promise<void> => {
      const cart = useCartStore.getState().activeCart;
      if (!cart) return;
      const res = await getBridge().lines.update({
        cart_id: cart.cart_id,
        line_id: lineId,
        op: 'decrement',
        version,
        idempotency_key: crypto.randomUUID(),
      });
      if (res.kind !== 'ok') return;
      setLines((prev) => {
        const line = prev.find((item) => item.lineId === lineId);
        if (!line) return prev;
        if (line.quantity <= 1) return prev.filter((item) => item.lineId !== lineId);
        const quantity = line.quantity - 1;
        return prev.map((item) =>
          item.lineId === lineId
            ? {
                ...item,
                quantity,
                lineSubtotalMinor: quantity * item.unitPriceMinor,
                version: res.version,
              }
            : item,
        );
      });
    },
    [getBridge],
  );

  const removeLine = useCallback(
    async (lineId: string, version: number): Promise<void> => {
      const cart = useCartStore.getState().activeCart;
      if (!cart) return;
      const res = await getBridge().lines.remove({
        cart_id: cart.cart_id,
        line_id: lineId,
        version,
        idempotency_key: crypto.randomUUID(),
      });
      if (res.kind === 'ok') setLines((prev) => prev.filter((line) => line.lineId !== lineId));
    },
    [getBridge],
  );

  const saveNote = useCallback(
    async (lineId: string, version: number, note: string | null): Promise<boolean> => {
      const cart = useCartStore.getState().activeCart;
      if (!cart) return false;
      const res = await getBridge().lines.setNote({
        cart_id: cart.cart_id,
        line_id: lineId,
        note,
        version,
        idempotency_key: crypto.randomUUID(),
      });
      if (res.kind !== 'ok') return false;
      setLines((prev) =>
        prev.map((line) =>
          line.lineId === lineId ? { ...line, note, version: res.version } : line,
        ),
      );
      return true;
    },
    [getBridge],
  );

  const handoff = useCallback(async (): Promise<void> => {
    const cart = useCartStore.getState().activeCart;
    if (!cart) return;
    const cartId = cart.cart_id;
    const lastLineId = cart.lastLineId;
    setHandoffError(null);
    useCartStore.getState().applyHandoffStarted();
    const res = await getBridge().handoff({
      cart_id: cartId,
      per_line_versions: lines.map((line) => ({ line_id: line.lineId, version: line.version })),
      idempotency_key: crypto.randomUUID(),
    });
    if (res.kind === 'ok') {
      useCartStore.getState().applyFrozen();
      setEnvelope(res.envelope);
    } else {
      useCartStore.setState({
        activeCart: { cart_id: cartId, state: CartState.editing, lastLineId },
      });
      setHandoffError('Could not hand off. Please try again.');
    }
  }, [getBridge, lines]);

  const voidCart = useCallback(async (): Promise<boolean> => {
    const cart = useCartStore.getState().activeCart;
    if (!cart) return false;
    const res = await getBridge().void({
      cart_id: cart.cart_id,
      idempotency_key: crypto.randomUUID(),
    });
    if (res.kind !== 'ok') return false;
    useCartStore.getState().applyCancelled();
    return true;
  }, [getBridge]);

  const removeDiscount = useCallback(
    async (placeholderId: string): Promise<void> => {
      const cart = useCartStore.getState().activeCart;
      if (!cart) return;
      const res = await getBridge().discountPlaceholders.remove({
        cart_id: cart.cart_id,
        placeholder_id: placeholderId,
        idempotency_key: crypto.randomUUID(),
      });
      if (res.kind === 'ok') {
        setDiscountPlaceholders((prev) =>
          prev.filter((item) => item.placeholderId !== placeholderId),
        );
      }
    },
    [getBridge],
  );

  const continueToPayment = useCallback(
    (onContinue?: () => void): void => {
      if (!envelope) return;
      usePaymentStore.getState().mount(envelope);
      onContinue?.();
    },
    [envelope],
  );

  /**
   * Opt-in "New sale": drop the finished cart from the renderer (stores and
   * this controller's projection). Never calls cart.create and never touches
   * the persisted cart; the next cart comes from the normal create path.
   */
  const startNewSale = useCallback((): void => {
    resetSaleStores();
    setHydrateCartId(null);
    setHydration('ready');
    setLines([]);
    setDiscountPlaceholders([]);
    setEnvelope(null);
    setHandoffError(null);
  }, []);

  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  return {
    lines,
    discountPlaceholders,
    envelope,
    handoffError,
    hydration,
    retryHydration,
    subtotalMinor,
    itemCount,
    acceptAddedLine,
    incrementLine,
    decrementLine,
    removeLine,
    saveNote,
    handoff,
    voidCart,
    removeDiscount,
    continueToPayment,
    startNewSale,
  };
}
