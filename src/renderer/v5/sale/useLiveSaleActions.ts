import { useState } from 'react';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type {
  AddedLineResult,
  CartLineItem,
  useSaleCartController,
} from '../../sale/useSaleCartController';
import { useSaleUndo } from '../../sale/useSaleUndo';
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

/**
 * RT-242 — the Sale's cart actions with the RT-245 Undo offer attached: a
 * direct add or a delete offers «تراجع» for exactly that action, and every
 * other mutation (stepper, note, discount, handoff, void, new sale, the next
 * scan) withdraws it first, since main would refuse it anyway.
 */
export function useLiveSaleActions(cart: SaleCart, bridge: CartBridgeAPI | undefined) {
  const [voided, setVoided] = useState(false);
  const [lastAdd, setLastAdd] = useState<LastAdd | null>(null);
  const undo = useSaleUndo({
    resync: cart.resync,
    onSettled: focusScanOwner,
    ...(bridge ? { bridge } : {}),
  });

  const endSale = (): void => {
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
    ): void => {
      setVoided(false);
      cart.acceptAddedLine(line);
      useLineFlagsStore.getState().remember(line.line_id, product);
      setLastAdd((previous) => ({ lineId: line.line_id, nonce: (previous?.nonce ?? 0) + 1 }));
      const cartId = useCartStore.getState().activeCart?.cart_id;
      if (cartId !== undefined) undo.offerUndo('added', line.display_name, cartId, actionId);
    },
    onAddQueued: undo.dismiss,
    onIncrement: (line: CartLineItem): void => {
      undo.dismiss();
      void cart.incrementLine(line.lineId, line.version);
    },
    onDecrement: (line: CartLineItem): void => {
      undo.dismiss();
      void cart.decrementLine(line.lineId, line.version);
    },
    onRemove: (line: CartLineItem): void => {
      undo.dismiss();
      const cartId = useCartStore.getState().activeCart?.cart_id;
      void cart.removeLine(line.lineId, line.version).then((actionId) => {
        if (actionId !== null && cartId !== undefined) {
          undo.offerUndo('removed', line.displayName, cartId, actionId);
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
    onHandoff: (): void => {
      undo.dismiss();
      void cart.handoff();
    },
    // Reset only after the bridge confirms the void; a refusal or rejected
    // transport keeps the existing cart. The voided cart stays cancelled in the
    // DB; only the renderer's pointer to it is dropped.
    onVoid: async (): Promise<boolean> => {
      undo.dismiss();
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
