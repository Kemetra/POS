import { useCallback, useRef } from 'react';
import type {
  CartBridgeAPI,
  CatalogueLookupResponse,
  PreloadBridgeAPI,
} from '../../shared/bridge-api';
import type { CartLinesAddResponse } from '../../shared/cart/bridge-types';
import type { ProductSnapshotDisplay } from '../../shared/catalogue/product-snapshot';
import type { AddedLineResult } from './useSaleCartController';
import { useAddLane, type AddLane } from './useAddLane';
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

/** What one queued scan or pick runs with. */
interface AddJob {
  readonly opts: DirectSaleAddOptions;
  readonly ticket: number;
  /** False once the sale this job was queued for has ended. */
  readonly isCurrent: () => boolean;
}

/**
 * One add of quantity 1; the add's idempotency key becomes the Undo target.
 * A job whose sale ended while it waited creates no cart and shows no line.
 */
async function addProduct(job: AddJob, product: ProductSnapshotDisplay): Promise<void> {
  const cartId = job.isCurrent() ? await job.opts.ensureCart() : null;
  if (!job.isCurrent()) return;
  if (!cartId) {
    job.opts.notify(SALE_ADD_FAILED_MESSAGE);
    return;
  }
  const actionId = crypto.randomUUID();
  const res = await sendAdd(job.opts, cartId, product, actionId);
  if (!job.isCurrent()) return;
  if (res === null) job.opts.notify(SALE_ADD_FAILED_MESSAGE);
  else job.opts.onLineAdded(addedLine(res), actionId, product, job.ticket);
}

/** `cart.lines.add` of one unit; `null` for a refusal or a failed transport. */
async function sendAdd(
  opts: DirectSaleAddOptions,
  cartId: string,
  product: ProductSnapshotDisplay,
  actionId: string,
): Promise<Extract<CartLinesAddResponse, { kind: 'ok' }> | null> {
  const res = await (opts.bridge ?? readCartBridge()).lines
    .add({ cart_id: cartId, item_ref: product.product_id, quantity: 1, idempotency_key: actionId })
    .catch(() => null);
  return res?.kind === 'ok' ? res : null;
}

/** False (with its notice) when the cart on screen cannot take a line. */
function admits(opts: DirectSaleAddOptions): boolean {
  const block = opts.addBlock();
  if (block === 'paid') opts.notify(SCAN_SALE_COMPLETE_MESSAGE);
  else if (block === 'frozen') opts.notify(SALE_FROZEN_MESSAGE);
  return block === null;
}

/** The sale is still the one the job was queued for, and its cart still takes a line. */
function stillAdmitted(job: AddJob): boolean {
  return job.isCurrent() && admits(job.opts);
}

async function scanAndAdd(job: AddJob, code: string): Promise<void> {
  if (!stillAdmitted(job)) return;
  const res = await job.opts.lookupScan(code);
  // Re-checked after the lookup: the sale may have ended or gone to payment meanwhile.
  if (res?.kind !== 'one') {
    if (job.isCurrent()) job.opts.notify(lookupNotice(code, res));
    return;
  }
  if (stillAdmitted(job)) await addProduct(job, res.product);
}

async function pickAndAdd(job: AddJob, product: ProductSnapshotDisplay): Promise<void> {
  if (stillAdmitted(job)) await addProduct(job, product);
}

/**
 * RT-242 (owner decision D-C1) — direct add for a resolved scan and a picked
 * search result: no confirm dialog. Every scan and pick joins ONE serial lane
 * (`useAddLane`: lookup, then add), so two scans in quick succession add two
 * lines in scan order and none is lost to a newer lookup. Exceptions are
 * notices, never dialogs. Each add sends quantity 1, so a merge is exactly +1
 * (RT-245). The options are read when each job runs, never at enqueue time.
 * The Sale passes its own lane so it can end pending adds with the sale and
 * hold handoff back while one is in flight.
 */
export function useDirectSaleAdd(options: DirectSaleAddOptions & { lane?: AddLane }): {
  scan: (code: string) => Promise<void>;
  pick: (product: ProductSnapshotDisplay) => Promise<void>;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownLane = useAddLane();
  const lane = options.lane ?? ownLane;

  const enqueue = useCallback(
    (run: (job: AddJob) => Promise<void>): Promise<void> => {
      const ticket = optionsRef.current.onQueued?.() ?? 0;
      return lane.enqueue((isCurrent) => run({ opts: optionsRef.current, ticket, isCurrent }));
    },
    [lane],
  );

  const scan = useCallback(
    (code: string): Promise<void> => enqueue((job) => scanAndAdd(job, code)),
    [enqueue],
  );
  const pick = useCallback(
    (product: ProductSnapshotDisplay): Promise<void> => enqueue((job) => pickAndAdd(job, product)),
    [enqueue],
  );
  return { scan, pick };
}
