import { useCallback, useRef, useState } from 'react';
import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';

/** The last cart action the Sale can offer to undo: a direct add (M-S2) or a delete (M-S8). */
export type UndoableKind = 'added' | 'removed';

export interface UndoOffer {
  readonly kind: UndoableKind;
  readonly name: string;
  readonly cartId: string;
  /** The idempotency key of the add / remove that just committed (RT-245 `target_action_id`). */
  readonly targetActionId: string;
  /** Fresh key for THIS Undo; a retry after a lost response reuses it, so main replays. */
  readonly undoKey: string;
  /** Changes on every offer, so the notice restarts its lifetime. */
  readonly seq: number;
}

/** What the status line last announced about the cart. */
export type CartAnnouncement =
  | { readonly kind: UndoableKind; readonly name: string; readonly seq: number }
  | { readonly kind: 'undone' | 'unavailable'; readonly seq: number };

function readCartBridgeOrNull(): CartBridgeAPI | null {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  return api?.cart ?? null;
}

function readCartBridge(): CartBridgeAPI {
  const cart = readCartBridgeOrNull();
  if (cart === null) throw new Error('Sale undo: preload bridge not initialised.');
  return cart;
}

interface SaleUndoOptions {
  bridge?: CartBridgeAPI;
  /** Rebuild the cart from main after any Undo outcome; the renderer never composes the inverse. */
  resync: () => Promise<void>;
  /** Where focus goes once the Undo has settled (the scan owner, 15 §3.1 rule 6). */
  onSettled?: () => void;
}

/**
 * RT-242 — the renderer side of the RT-245 Undo contract. The renderer names
 * only the action it just completed; main (`cart.undoLast`) proves it is still
 * the cart's newest action and applies the exact inverse. On any answer, ok or
 * refused, the offer goes and the cart is re-read from main. A bridge without
 * `undoLast` offers nothing (fail closed).
 */
export function useSaleUndo(options: SaleUndoOptions): {
  offer: UndoOffer | null;
  announcement: CartAnnouncement | null;
  canUndo: boolean;
  offerUndo: (kind: UndoableKind, name: string, cartId: string, targetActionId: string) => void;
  /** Another cart mutation (or the end of the sale) invalidates the offer. */
  dismiss: () => void;
  /** Drop the offer and the last announcement (a new sale). */
  clear: () => void;
  undo: () => Promise<void>;
} {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [announcement, setAnnouncement] = useState<CartAnnouncement | null>(null);
  const seqRef = useRef(0);
  const busyRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const getBridge = useCallback(
    (): CartBridgeAPI => options.bridge ?? readCartBridge(),
    [options.bridge],
  );
  const canUndo = (options.bridge ?? readCartBridgeOrNull())?.undoLast !== undefined;

  const offerUndo = useCallback(
    (kind: UndoableKind, name: string, cartId: string, targetActionId: string): void => {
      seqRef.current += 1;
      const seq = seqRef.current;
      setAnnouncement({ kind, name, seq });
      setOffer({ kind, name, cartId, targetActionId, undoKey: crypto.randomUUID(), seq });
    },
    [],
  );

  const dismiss = useCallback((): void => {
    setOffer(null);
  }, []);

  const clear = useCallback((): void => {
    setOffer(null);
    setAnnouncement(null);
  }, []);

  const undo = useCallback(async (): Promise<void> => {
    const current = offer;
    const bridge = getBridge();
    if (busyRef.current || current === null || bridge.undoLast === undefined) return;
    busyRef.current = true;
    try {
      const res = await bridge
        .undoLast({
          cart_id: current.cartId,
          target_action_id: current.targetActionId,
          idempotency_key: current.undoKey,
        })
        .catch(() => null);
      // A lost response keeps the offer: pressing again replays the same key.
      if (res === null) return;
      seqRef.current += 1;
      setAnnouncement({ kind: res.kind === 'ok' ? 'undone' : 'unavailable', seq: seqRef.current });
      setOffer(null);
      await optionsRef.current.resync();
      optionsRef.current.onSettled?.();
    } finally {
      busyRef.current = false;
    }
  }, [getBridge, offer]);

  return { offer, announcement, canUndo, offerUndo, dismiss, clear, undo };
}
