/**
 * RT-254 — main-owned decision logic for `cart.undoLast` (contract RT-245,
 * Confluence RETAIL 24248322).
 *
 * The renderer names only the action it just completed. This module proves
 * from persisted lineage that the action is still eligible and chooses the
 * exact inverse; `cart-store.ts` re-proves the same facts at commit time.
 *
 *   cart.line.add    (line active)   → soft-remove the same row  (`cart.line.remove`)
 *   cart.line.merge  (line active)   → subtract `quantity_added` (`cart.line.update`, op=decrement)
 *   cart.line.remove (line removed)  → restore the same row      (`cart.line.restore`)
 *
 * Lineage, not central audit: each inverse is one append-only outbox row
 * carrying `undo_of_action_id`; no `audit_events` row is written (005 FR-027).
 * An Undo row is itself never a valid target (no redo through Undo).
 *
 * Pure functions over `CartStore` reads — no writes, no clock, no logging.
 */

import type {
  CartUndoEffect,
  CartUndoLastRequest,
  CartUndoLastResponse,
} from '../../shared/cart/bridge-types.js';
import type { CartRefusalReason } from '../../shared/cart/refusal.js';
import { computeLineSubtotal, LineSubtotalError } from './line-subtotal.js';
import type { CartLineRow, CartRow, CartStore, OutboxRow, UndoInverse } from './cart-store.js';

type Refused = { kind: 'refused'; reason: CartRefusalReason };

/** The outbox kind each effect is recorded under (only `restore` is new, 0045). */
const OUTBOX_KIND_BY_EFFECT: Readonly<Record<CartUndoEffect, string>> = {
  removed: 'cart.line.remove',
  decremented: 'cart.line.update',
  restored: 'cart.line.restore',
};

/** Everything the bridge needs to commit one Undo. */
export interface UndoPlan {
  kind: 'ok';
  line: CartLineRow;
  effect: CartUndoEffect;
  inverse: UndoInverse;
  outboxKind: string;
  /** Outbox payload (ids and quantities only — no catalogue or price data). */
  payload: Record<string, unknown>;
}

function unavailable(): Refused {
  return { kind: 'refused', reason: 'undo_not_available' };
}

function mismatch(): Refused {
  return { kind: 'refused', reason: 'idempotency_payload_mismatch' };
}

/** Parses an outbox payload into a plain object; null when unreadable. */
function parsePayload(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isUndoEffect(value: unknown): value is CartUndoEffect {
  return value === 'removed' || value === 'decremented' || value === 'restored';
}

/**
 * Replay of an Undo key that already has an outbox row. Returns the ORIGINAL
 * effect and resulting version recorded with it (a lost response must not
 * read today's line version). Anything that is not an Undo of this same
 * cart and target is a payload mismatch — including a renderer that reuses
 * the target's own key.
 */
export function replayUndo(req: CartUndoLastRequest, row: OutboxRow): CartUndoLastResponse {
  const payload = parsePayload(row.payload_json);
  if (payload === null || row.cart_id !== req.cart_id || row.line_id === null) return mismatch();
  if (payload['undo_of_action_id'] !== req.target_action_id) return mismatch();
  const effect = payload['effect'];
  const version = payload['result_version'];
  if (!isUndoEffect(effect) || OUTBOX_KIND_BY_EFFECT[effect] !== row.action_kind) return mismatch();
  if (!isPositiveInteger(version)) return mismatch();
  return { kind: 'ok', effect, line_id: row.line_id, version };
}

/** The target outbox row, when it is an undoable line action of this cart. */
function eligibleTarget(
  store: CartStore,
  cart: CartRow,
  targetActionId: string,
): { row: OutboxRow; line_id: string; payload: Record<string, unknown> } | null {
  if (cart.last_action_id !== targetActionId) return null;
  const row = store.getOutboxRow(targetActionId);
  if (row?.cart_id !== cart.cart_id || row.line_id === null) return null;
  const payload = parsePayload(row.payload_json);
  // An Undo is never itself undoable.
  if (payload === null || 'undo_of_action_id' in payload) return null;
  return { row, line_id: row.line_id, payload };
}

/** Inverse of a merge: subtract exactly the persisted `quantity_added`, never down to zero. */
function planDecrement(
  line: CartLineRow,
  targetPayload: Record<string, unknown>,
): { inverse: UndoInverse; extra: Record<string, unknown> } | null {
  const added = targetPayload['quantity_added'];
  if (!isPositiveInteger(added)) return null;
  const quantity = line.quantity - added;
  if (quantity < 1) return null;
  let subtotal: number;
  try {
    subtotal = computeLineSubtotal(quantity, line.unit_price_minor);
  } catch (err) {
    if (err instanceof LineSubtotalError) return null;
    /* v8 ignore next */
    throw err;
  }
  return {
    inverse: { kind: 'decrement', quantity, line_subtotal_minor: subtotal },
    extra: { op: 'decrement', delta: added, new_quantity: quantity },
  };
}

/** Chooses the exact inverse for the target's kind, given the line's CURRENT state. */
function chooseInverse(
  store: CartStore,
  kind: string,
  line: CartLineRow,
  targetPayload: Record<string, unknown>,
): { effect: CartUndoEffect; inverse: UndoInverse; extra: Record<string, unknown> } | null {
  const active = line.removed_at === null;
  if (kind === 'cart.line.add') {
    return active ? { effect: 'removed', inverse: { kind: 'soft_remove' }, extra: {} } : null;
  }
  if (kind === 'cart.line.merge') {
    const planned = active ? planDecrement(line, targetPayload) : null;
    return planned === null ? null : { effect: 'decremented', ...planned };
  }
  if (kind === 'cart.line.remove' && !active) {
    // Q4: never restore beside another active line for the same item.
    if (store.findActiveLineByItemRef(line.cart_id, line.item_ref) !== undefined) return null;
    return { effect: 'restored', inverse: { kind: 'restore' }, extra: {} };
  }
  return null;
}

/**
 * Decides whether `req.target_action_id` can be undone right now and how.
 * `undo_not_available` for every ineligible case (stale, foreign, wrong kind
 * or line state) — the reason is deliberately not distinguished.
 */
export function planUndo(
  store: CartStore,
  cart: CartRow,
  req: CartUndoLastRequest,
): UndoPlan | Refused {
  const target = eligibleTarget(store, cart, req.target_action_id);
  if (target === null) return unavailable();
  const line = store.getLine(cart.cart_id, target.line_id);
  if (line?.last_action_id !== req.target_action_id) return unavailable();
  const chosen = chooseInverse(store, target.row.action_kind, line, target.payload);
  if (chosen === null) return unavailable();
  return {
    kind: 'ok',
    line,
    effect: chosen.effect,
    inverse: chosen.inverse,
    outboxKind: OUTBOX_KIND_BY_EFFECT[chosen.effect],
    payload: {
      ...chosen.extra,
      undo_of_action_id: req.target_action_id,
      effect: chosen.effect,
      result_version: line.version + 1,
    },
  };
}
