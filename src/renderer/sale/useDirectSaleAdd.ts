import { useCallback, useRef } from 'react';
import type {
  CartBridgeAPI,
  CatalogueLookupResponse,
  PreloadBridgeAPI,
} from '../../shared/bridge-api';
import type { CartLinesAddResponse } from '../../shared/cart/bridge-types';
import type { ProductSnapshotDisplay } from '../../shared/catalogue/product-snapshot';
import type { AddedLineResult } from './useSaleCartController';
import {
  SALE_ADD_FAILED_MESSAGE,
  SALE_FROZEN_MESSAGE,
  SCAN_AMBIGUOUS_MESSAGE,
  SCAN_CATALOGUE_UNAVAILABLE_MESSAGE,
  SCAN_SALE_COMPLETE_MESSAGE,
  scanNotFoundMessage,
} from '../scan/scan-messages';

/** Why the current cart cannot take a line: a completed (paid) sale, or one handed to payment. */
export type AddBlock = 'paid' | 'frozen' | null;

export interface DirectSaleAddOptions {
  /** Creates (or returns) the active cart on the first add; `null` on failure (#466). */
  ensureCart: () => Promise<string | null>;
  /** Exact barcode lookup; `null` when the transport failed. */
  lookupScan: (code: string) => Promise<CatalogueLookupResponse | null>;
  /** Read at the moment each queued add runs, never at enqueue time. */
  addBlock: () => AddBlock;
  /**
   * A bridge-confirmed add, with the idempotency key of that add (the Undo
   * target, RT-245) and the ticket `onQueued` returned when it was queued.
   */
  onLineAdded: (
    line: AddedLineResult,
    actionId: string,
    product: ProductSnapshotDisplay,
    ticket: number,
  ) => void;
  /** A scan or pick was queued: anything offering to undo an older action must go. */
  onQueued?: () => number;
  /** A one-line, non-blocking exception notice (M-S3, M-S7, a refused add). */
  notify: (message: string) => void;
  bridge?: CartBridgeAPI;
}

function readCartBridge(): CartBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) throw new Error('Sale add: preload bridge not initialised.');
  return api.cart;
}

/** The scan outcomes that add nothing, each with its inline notice. */
function lookupNotice(code: string, res: CatalogueLookupResponse | null): string {
  if (res === null) return SALE_ADD_FAILED_MESSAGE;
  switch (res.kind) {
    case 'not_found':
      return scanNotFoundMessage(code);
    case 'ambiguous':
      return SCAN_AMBIGUOUS_MESSAGE;
    case 'catalogue_unavailable':
      return SCAN_CATALOGUE_UNAVAILABLE_MESSAGE;
    default:
      return SALE_ADD_FAILED_MESSAGE;
  }
}

/** The bridge-confirmed line, without the response discriminant. */
function addedLine(res: Extract<CartLinesAddResponse, { kind: 'ok' }>): AddedLineResult {
  return {
    line_id: res.line_id,
    display_name: res.display_name,
    unit_price_minor: res.unit_price_minor,
    line_subtotal_minor: res.line_subtotal_minor,
    quantity: res.quantity,
    version: res.version,
    merged: res.merged,
  };
}

/** One add of quantity 1; the add's idempotency key becomes the Undo target. */
async function addProduct(
  opts: DirectSaleAddOptions,
  product: ProductSnapshotDisplay,
  ticket: number,
): Promise<void> {
  const cartId = await opts.ensureCart();
  if (cartId === null || cartId === '') {
    opts.notify(SALE_ADD_FAILED_MESSAGE);
    return;
  }
  const actionId = crypto.randomUUID();
  const res = await (opts.bridge ?? readCartBridge()).lines
    .add({ cart_id: cartId, item_ref: product.product_id, quantity: 1, idempotency_key: actionId })
    .catch(() => null);
  if (res?.kind !== 'ok') {
    opts.notify(SALE_ADD_FAILED_MESSAGE);
    return;
  }
  opts.onLineAdded(addedLine(res), actionId, product, ticket);
}

/** False (with its notice) when the cart on screen cannot take a line. */
function admits(opts: DirectSaleAddOptions): boolean {
  const block = opts.addBlock();
  if (block === 'paid') opts.notify(SCAN_SALE_COMPLETE_MESSAGE);
  else if (block === 'frozen') opts.notify(SALE_FROZEN_MESSAGE);
  return block === null;
}

async function scanAndAdd(opts: DirectSaleAddOptions, code: string, ticket: number): Promise<void> {
  if (!admits(opts)) return;
  const res = await opts.lookupScan(code);
  if (res?.kind === 'one') await addProduct(opts, res.product, ticket);
  else opts.notify(lookupNotice(code, res));
}

async function pickAndAdd(
  opts: DirectSaleAddOptions,
  product: ProductSnapshotDisplay,
  ticket: number,
): Promise<void> {
  if (admits(opts)) await addProduct(opts, product, ticket);
}

/**
 * RT-242 (owner decision D-C1) — direct add for a resolved scan and a picked
 * search result: no confirm dialog. Every scan and pick joins ONE serial lane
 * (lookup, then add), so two scans in quick succession add two lines in scan
 * order and none is lost to a newer lookup. Exceptions are notices, never
 * dialogs. Each add sends quantity 1, so a merge is exactly +1 (RT-245). The
 * options are read when each job runs, never at enqueue time.
 */
export function useDirectSaleAdd(options: DirectSaleAddOptions): {
  scan: (code: string) => Promise<void>;
  pick: (product: ProductSnapshotDisplay) => Promise<void>;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const laneRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback(
    (job: (opts: DirectSaleAddOptions, ticket: number) => Promise<void>): Promise<void> => {
      const ticket = optionsRef.current.onQueued?.() ?? 0;
      const run = (): Promise<void> => job(optionsRef.current, ticket);
      const next = laneRef.current.then(run, run);
      laneRef.current = next.catch(() => undefined);
      return next;
    },
    [],
  );

  const scan = useCallback(
    (code: string): Promise<void> => enqueue((opts, ticket) => scanAndAdd(opts, code, ticket)),
    [enqueue],
  );
  const pick = useCallback(
    (product: ProductSnapshotDisplay): Promise<void> =>
      enqueue((opts, ticket) => pickAndAdd(opts, product, ticket)),
    [enqueue],
  );
  return { scan, pick };
}
