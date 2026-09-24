import { useCallback, useState } from 'react';
import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope';
import { CartState } from '../../shared/cart/cart-state';
import { useCartStore } from '../stores/cart-store';
import { usePaymentStore } from '../stores/payment-store';

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
}

function readCartBridge(): CartBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) throw new Error('Sale cart: preload bridge not initialised.');
  return api.cart;
}

export function useSaleCartController(options: SaleCartControllerOptions = {}): {
  lines: readonly CartLineItem[];
  discountPlaceholders: readonly DiscountPlaceholderSeed[];
  envelope: PaymentIntentEnvelope | null;
  handoffError: string | null;
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

  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  return {
    lines,
    discountPlaceholders,
    envelope,
    handoffError,
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
  };
}
