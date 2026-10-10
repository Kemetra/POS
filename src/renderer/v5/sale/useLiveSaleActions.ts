import { useRef, useState } from 'react';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type {
  AddedLineResult,
  CartLineItem,
  useSaleCartController,
} from '../../sale/useSaleCartController';
import { useSaleUndo } from '../../sale/useSaleUndo';
import type { AddLane } from '../../sale/useAddLane';
import { focusScanOwner } from '../../scan/scan-anchor';
import { useCartStore } from '../../stores/cart-store';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { acknowledgeDrawerNotice } from '../../ui/receipts/drawer-notice-store';

type SaleCart = ReturnType<typeof useSaleCartController>;

export interface LastAdd {
  readonly lineId: string;
  /** Changes on every add, so a re-add of the same line still scrolls and flashes. */
  readonly nonce: number;
}

/** A confirmed decrement of a one-unit line: main recorded it as a remove, so it is undoable. */
function removedLine(line: CartLineItem, actionId: string | null): actionId is string {
  return actionId !== null && line.quantity <= 1;
}

/** Run `send` unless one for the same line is still in flight (a repeat press is not a new action). */
function onceAtATime(pending: Set<string>, lineId: string, send: () => Promise<void>): void {
  if (pending.has(lineId)) return;
  pending.add(lineId);
  void send().finally(() => pending.delete(lineId));
}

/**
 * RT-242 — the Sale's cart actions with the RT-245 Undo offer attached: a
 * direct add or a delete offers «تراجع» for exactly that action, and every
 * other mutation (stepper, note, discount, handoff, void, new sale, the next
 * scan) withdraws it first, since main would refuse it anyway.
 */
export function useLiveSaleActions(
  cart: SaleCart,
  bridge: CartBridgeAPI | undefined,
  lane: AddLane,
) {
  const [voided, setVoided] = useState(false);
  const [lastAdd, setLastAdd] = useState<LastAdd | null>(null);
  const removalsRef = useRef(new Set<string>());
  const undo = useSaleUndo({
    resync: cart.resync,
    onSettled: focusScanOwner,
    // In the add lane: ordered with adds, and dropped if its sale has ended.
    run: (job) => lane.enqueue((isCurrent) => (isCurrent() ? job() : Promise.resolve())),
    ...(bridge ? { bridge } : {}),
  });

  // A scan still in the lane belongs to the sale that just ended (Codex P1 on #621).
  const endSale = (): void => {
    lane.cancelPending();
    cart.startNewSale();
    setLastAdd(null);
    undo.clear();
    focusScanOwner();
  };

  return {
    undo,
    voided,
    lastAdd,
    acceptAddedLine: (
      line: AddedLineResult,
      actionId: string,
      product: ProductSnapshotDisplay,
      ticket: number,
    ): void => {
      setVoided(false);
      cart.acceptAddedLine(line);
      // 15 §3.1 rule 6: after an add the next scan is the next thing the cashier does.
      focusScanOwner();
      useLineFlagsStore.getState().remember(line.line_id, product);
      setLastAdd((previous) => ({ lineId: line.line_id, nonce: (previous?.nonce ?? 0) + 1 }));
      const cartId = useCartStore.getState().activeCart?.cart_id;
      if (cartId !== undefined) {
        undo.offerUndo('added', line.display_name, cartId, actionId, ticket);
      }
    },
    onAddQueued: undo.withdraw,
    onIncrement: (line: CartLineItem): void => {
      undo.dismiss();
      void cart.incrementLine(line.lineId, line.version);
    },
    // Only a noted one-unit line reaches here at quantity 1: main records that
    // decrement as a remove, so it is undoable and, like Delete, sent once at a time.
    onDecrement: (line: CartLineItem): void => {
      const send = async (): Promise<void> => {
        const ticket = undo.withdraw();
        const cartId = useCartStore.getState().activeCart?.cart_id;
        const actionId = await cart.decrementLine(line.lineId, line.version);
        if (removedLine(line, actionId) && cartId !== undefined) {
          undo.offerUndo('removed', line.displayName, cartId, actionId, ticket);
        }
      };
      if (line.quantity > 1) void send();
      else onceAtATime(removalsRef.current, line.lineId, send);
    },
    onRemove: (line: CartLineItem): void => {
      // A repeat press while the first remove is in flight changes nothing: keep its offer.
      if (cart.isRemoving(line.lineId)) return;
      const ticket = undo.withdraw();
      const cartId = useCartStore.getState().activeCart?.cart_id;
      void cart.removeLine(line.lineId, line.version).then((actionId) => {
        if (actionId !== null && cartId !== undefined) {
          undo.offerUndo('removed', line.displayName, cartId, actionId, ticket);
        }
      });
    },
    onSaveNote: (line: CartLineItem, note: string | null): Promise<boolean> => {
      undo.dismiss();
      return cart.saveNote(line.lineId, line.version, note);
    },
    onRemoveDiscount: (id: string): void => {
      undo.dismiss();
      void cart.removeDiscount(id);
    },
    // Never raced against an add: the freeze waits until every admitted add has settled.
    onHandoff: (): void => {
      if (lane.busy) return;
      undo.dismiss();
      void cart.handoff();
    },
    // Reset only after the bridge confirms the void; a refusal or rejected
    // transport keeps the existing cart. The voided cart stays cancelled in the
    // DB; only the renderer's pointer to it is dropped.
    // Adds already admitted settle first: a refused void then leaves them in
    // the sale they belong to, and a confirmed one ends any queued after it.
    onVoid: async (): Promise<boolean> => {
      undo.dismiss();
      await lane.drain();
      const ok = await cart.voidCart().catch(() => false);
      if (ok) {
        endSale();
        setVoided(true);
      }
      return ok;
    },
    onNewSale: (): void => {
      endSale();
      // RT-241 (D-B1): «بيع جديد» acknowledges the drawer notice.
      acknowledgeDrawerNotice();
    },
  };
}
