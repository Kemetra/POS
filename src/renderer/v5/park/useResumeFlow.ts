import { useRef, useState } from 'react';

import type { CartBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type {
  CartParkBridgeAPI,
  CartParkRefusalReason,
  ParkedSaleView,
  ResumePriceChange,
  ResumeUnavailableLine,
} from '../../../shared/cart/park-types';
import { useCartStore } from '../../stores/cart-store';
import { callPark, newIdempotencyKey } from './park-bridge';
import { parkRefusalView } from './park-copy';

/** The current sale as the VN-R10 conflict shows it: its line count and total. */
export interface CurrentSale {
  readonly lineCount: number;
  readonly totalMinor: number;
}

export interface ResumePreview {
  readonly changes: readonly ResumePriceChange[];
  readonly unavailable: readonly ResumeUnavailableLine[];
  readonly diffToken: string;
}

export type ResumeView =
  | { kind: 'list' }
  | {
      kind: 'review';
      sale: ParkedSaleView;
      preview: ResumePreview;
      conflict: CurrentSale | null;
      /** OD-14: the preview was re-run after `price_changes_unaccepted`. */
      pricesChanged: boolean;
      busy: boolean;
    }
  | {
      kind: 'refused';
      sale: ParkedSaleView;
      reason: 'catalogue_unavailable' | 'checkout_in_progress';
    };

export interface ResumeFlow {
  readonly view: ResumeView;
  /** The list's generic refusal line (OD-9), shown after the list is read again. */
  readonly listRefused: boolean;
  /** The sale whose resume is being prepared (its row shows busy). */
  readonly pendingCartId: string | null;
  readonly start: (sale: ParkedSaleView) => void;
  /** «قبول … واستئناف» or a conflict swap: one action. */
  readonly accept: () => void;
  /** «رجوع» / «أبقِ البيع الحالي» (OD-8): a local back, no call. */
  readonly back: () => void;
}

interface Deps {
  readonly parked: CartParkBridgeAPI;
  readonly cart: CartBridgeAPI | null;
  /** Main answered `resumed`: the Sale shows this cart. */
  readonly onResumed: (cartId: string) => void;
  /** OD-9: read the list again. */
  readonly reloadList: () => void;
}

function hasChanges(preview: ResumePreview): boolean {
  return preview.changes.length > 0 || preview.unavailable.length > 0;
}

/**
 * The non-empty editing sale this session holds, read from main (I-13). Any
 * other state, or a failed read, is no conflict here: main still refuses a
 * resume that would merge or overwrite (`current_cart_active`,
 * `checkout_in_progress`).
 */
async function readCurrentSale(cart: CartBridgeAPI | null): Promise<CurrentSale | null> {
  const active = useCartStore.getState().activeCart;
  if (active === null || cart?.snapshot === undefined) return null;
  try {
    const res = await cart.snapshot({ cart_id: active.cart_id });
    if (res.kind !== 'ok' || res.snapshot.state !== CartState.editing) return null;
    const lines = res.snapshot.lines;
    if (lines.length === 0) return null;
    return {
      lineCount: lines.length,
      totalMinor: lines.reduce((sum, line) => sum + line.line_subtotal_minor, 0),
    };
  } catch {
    return null;
  }
}

/**
 * RT-445 — resume through `cart.previewResume` (spec 024 §3.3–§3.4). Nothing
 * changes before the cashier accepts; a preview with no changes and no
 * conflict resumes at once (OD-6). The swap parks the current sale unnamed
 * in the same call (OD-7).
 */
export function useResumeFlow(deps: Deps): ResumeFlow {
  const [view, setView] = useState<ResumeView>({ kind: 'list' });
  const [listRefused, setListRefused] = useState(false);
  const [pendingCartId, setPendingCartId] = useState<string | null>(null);
  const keyRef = useRef<{ token: string; key: string } | null>(null);
  const { parked, cart, onResumed, reloadList } = deps;

  function refuseToList(): void {
    setPendingCartId(null);
    setView({ kind: 'list' });
    setListRefused(true);
    reloadList();
  }

  /** Preview, then either resume at once (OD-6) or show the review. */
  async function prepare(sale: ParkedSaleView, pricesChanged: boolean): Promise<void> {
    const answer = await callPark(() => parked.previewResume({ cart_id: sale.cart_id }));
    if (answer.kind !== 'preview') {
      settleRefusal(sale, answer.kind === 'refused' ? answer.reason : null);
      return;
    }
    const preview: ResumePreview = {
      changes: answer.changes,
      unavailable: answer.unavailable,
      diffToken: answer.diff_token,
    };
    const conflict = await readCurrentSale(cart);
    if (!hasChanges(preview) && conflict === null) {
      await send(sale, preview, null);
      return;
    }
    setPendingCartId(null);
    setView({ kind: 'review', sale, preview, conflict, pricesChanged, busy: false });
  }

  /** The one resume call; the key is reused only for the same sale and diff. */
  async function send(
    sale: ParkedSaleView,
    preview: ResumePreview,
    conflict: CurrentSale | null,
  ): Promise<void> {
    const token = `${sale.cart_id}:${preview.diffToken}`;
    if (keyRef.current?.token !== token) keyRef.current = { token, key: newIdempotencyKey() };
    const key = keyRef.current.key;
    const answer = await callPark(() =>
      parked.resume({
        cart_id: sale.cart_id,
        accept_changes: hasChanges(preview),
        diff_token: preview.diffToken,
        current_cart: conflict === null ? 'keep' : 'park',
        idempotency_key: key,
      }),
    );
    if (answer.kind === 'resumed') {
      setPendingCartId(null);
      onResumed(answer.cart_id);
      return;
    }
    const reason = answer.kind === 'refused' ? answer.reason : null;
    // OD-14: read the preview again and show the new review.
    if (reason === 'price_changes_unaccepted') await prepare(sale, true);
    else settleRefusal(sale, reason);
  }

  function settleRefusal(sale: ParkedSaleView, reason: CartParkRefusalReason | null): void {
    const shown = reason === null ? 'generic' : parkRefusalView(reason);
    setPendingCartId(null);
    if (shown === 'catalogue_unavailable' || shown === 'checkout_in_progress') {
      setView({ kind: 'refused', sale, reason: shown });
      return;
    }
    // The lock screen covers a locked session; what was on screen stays.
    if (shown === 'session_locked') {
      setView((v) => (v.kind === 'review' ? { ...v, busy: false } : v));
      return;
    }
    refuseToList();
  }

  const start = (sale: ParkedSaleView): void => {
    if (pendingCartId !== null) return;
    setListRefused(false);
    setPendingCartId(sale.cart_id);
    void prepare(sale, false);
  };

  const accept = (): void => {
    if (view.kind !== 'review' || view.busy) return;
    setView({ ...view, busy: true });
    void send(view.sale, view.preview, view.conflict);
  };

  const back = (): void => {
    setPendingCartId(null);
    setView({ kind: 'list' });
  };

  return { view, listRefused, pendingCartId, start, accept, back };
}
