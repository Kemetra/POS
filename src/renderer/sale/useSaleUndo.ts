import { useCallback, useRef, useState } from 'react';
import type { CartBridgeAPI, PreloadBridgeAPI } from '../../shared/bridge-api';
import type { CartUndoLastResponse } from '../../shared/cart/bridge-types';

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

/** An Undo can be sent: none in flight, an offer standing, and a bridge that can undo. */
function canSend(
  busy: boolean,
  offer: UndoOffer | null,
  bridge: CartBridgeAPI,
): offer is UndoOffer {
  return !busy && offer !== null && bridge.undoLast !== undefined;
}

/** `null` when the transport failed: main may or may not have applied the inverse. */
async function sendUndo(
  bridge: CartBridgeAPI,
  offer: UndoOffer,
): Promise<CartUndoLastResponse | null> {
  if (bridge.undoLast === undefined) return null;
  return bridge
    .undoLast({
      cart_id: offer.cartId,
      target_action_id: offer.targetActionId,
      idempotency_key: offer.undoKey,
    })
    .catch(() => null);
}

/**
 * The offer and the announcement. `seq` restarts the notice's lifetime on
 * every offer; the epoch makes an action that committed after a later change
 * started (a withdraw) announce itself without offering an Undo.
 */
function useUndoOfferState() {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [announcement, setAnnouncement] = useState<CartAnnouncement | null>(null);
  const seqRef = useRef(0);
  const epochRef = useRef(0);
  const nextSeq = useCallback((): number => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  const offerUndo = useCallback(
    (
      kind: UndoableKind,
      name: string,
      cartId: string,
      targetActionId: string,
      ticket: number,
    ): void => {
      const seq = nextSeq();
      setAnnouncement({ kind, name, seq });
      if (ticket !== epochRef.current) return;
      setOffer({ kind, name, cartId, targetActionId, undoKey: crypto.randomUUID(), seq });
    },
    [nextSeq],
  );
  const withdraw = useCallback((): number => {
    epochRef.current += 1;
    setOffer(null);
    return epochRef.current;
  }, []);
  const announceOutcome = useCallback(
    (ok: boolean): void => {
      setAnnouncement({ kind: ok ? 'undone' : 'unavailable', seq: nextSeq() });
      setOffer(null);
    },
    [nextSeq],
  );
  const clear = useCallback((): void => {
    withdraw();
    setAnnouncement(null);
  }, [withdraw]);
  return { offer, announcement, offerUndo, withdraw, announceOutcome, clear };
}

/**
 * RT-242 — the renderer side of the RT-245 Undo contract. The renderer names
 * only the action it just completed; main (`cart.undoLast`) proves it is still
 * the cart's newest action and applies the exact inverse. On any answer, ok or
 * refused, the offer goes and the cart is re-read from main. A lost response
 * keeps the offer (pressing again replays the same key) but still re-reads, as
 * main may have applied the inverse. A bridge without `undoLast` offers
 * nothing (fail closed).
 */
export function useSaleUndo(options: SaleUndoOptions): {
  offer: UndoOffer | null;
  announcement: CartAnnouncement | null;
  canUndo: boolean;
  /**
   * Announce a committed add / remove, and offer its Undo only if nothing was
   * withdrawn since `ticket` was taken: a change started while this action was
   * still in flight is newer, and main would refuse the Undo.
   */
  offerUndo: (
    kind: UndoableKind,
    name: string,
    cartId: string,
    targetActionId: string,
    ticket: number,
  ) => void;
  /**
   * Another cart mutation (or the end of the sale) invalidates the offer.
   * Returns the ticket an action started now passes back to `offerUndo`.
   */
  withdraw: () => number;
  dismiss: () => void;
  /** Drop the offer and the last announcement (a new sale). */
  clear: () => void;
  undo: () => Promise<void>;
} {
  const state = useUndoOfferState();
  const { offer, withdraw, announceOutcome } = state;
  const busyRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const undo = useCallback(async (): Promise<void> => {
    const bridge = options.bridge ?? readCartBridge();
    if (!canSend(busyRef.current, offer, bridge)) return;
    busyRef.current = true;
    try {
      const res = await sendUndo(bridge, offer);
      if (res !== null) announceOutcome(res.kind === 'ok');
      await optionsRef.current.resync();
      if (res !== null) optionsRef.current.onSettled?.();
    } finally {
      busyRef.current = false;
    }
  }, [announceOutcome, offer, options.bridge]);

  const dismiss = useCallback((): void => {
    withdraw();
  }, [withdraw]);

  return {
    offer,
    announcement: state.announcement,
    canUndo: (options.bridge ?? readCartBridgeOrNull())?.undoLast !== undefined,
    offerUndo: state.offerUndo,
    withdraw,
    dismiss,
    clear: state.clear,
    undo,
  };
}
