import type { CartRefusal } from './refusal.js';
import type { PaymentIntentEnvelope } from './handoff-envelope.js';
import type { CartState } from './cart-state.js';

// ── cart.create ───────────────────────────────────────────────────────────────

export interface CartCreateRequest {
  readonly idempotency_key: string;
}

export type CartCreateResponse = { readonly kind: 'ok'; readonly cart_id: string } | CartRefusal;

// ── cart.lines.add ────────────────────────────────────────────────────────────

export interface CartLinesAddRequest {
  readonly cart_id: string;
  readonly item_ref: string;
  readonly quantity: number;
  readonly idempotency_key: string;
}

export type CartLinesAddResponse =
  | {
      readonly kind: 'ok';
      readonly line_id: string;
      readonly merged: boolean;
      readonly version: number;
      /** Resolved display name snapshot (T052 — renderer line list). */
      readonly display_name: string;
      /** Unit price in integer minor units (T052). */
      readonly unit_price_minor: number;
      /** Line subtotal in integer minor units (T052). */
      readonly line_subtotal_minor: number;
      /** Bridge-confirmed quantity after add/merge. */
      readonly quantity: number;
    }
  | CartRefusal;

// ── cart.lines.update ─────────────────────────────────────────────────────────

export interface CartLinesUpdateRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly op: 'increment' | 'decrement' | 'set';
  readonly delta?: number;
  readonly absolute?: number;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesUpdateResponse =
  | { readonly kind: 'ok'; readonly version: number }
  | CartRefusal;

// ── cart.lines.remove ─────────────────────────────────────────────────────────

export interface CartLinesRemoveRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesRemoveResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.lines.setNote ────────────────────────────────────────────────────────

export interface CartLinesSetNoteRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly note: string | null;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesSetNoteResponse =
  | { readonly kind: 'ok'; readonly version: number }
  | CartRefusal;

// ── cart.discountPlaceholders.add ─────────────────────────────────────────────
//
// No approver crosses this bridge (RT-183; spec 005 contracts/bridge-api.md):
// main records the authenticated session operator as the approving
// supervisor and drops any renderer-supplied `attribution_operator_id`.

export interface CartDiscountPlaceholdersAddRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly placeholder_kind: string;
  readonly idempotency_key: string;
}

export type CartDiscountPlaceholdersAddResponse =
  | {
      readonly kind: 'ok';
      readonly placeholder_id: string;
      readonly requires_manager_attribution: boolean;
    }
  | CartRefusal;

// ── cart.discountPlaceholders.remove ──────────────────────────────────────────

export interface CartDiscountPlaceholdersRemoveRequest {
  readonly cart_id: string;
  readonly placeholder_id: string;
  readonly attribution_operator_id?: string;
  readonly idempotency_key: string;
}

export type CartDiscountPlaceholdersRemoveResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.void ─────────────────────────────────────────────────────────────────
//
// Pre-handoff void only (a frozen cart is refused; post-handoff is
// `cancelPostHandoff`). No attribution crosses this bridge (RT-184): main
// records the session operator as the acting operator and no approver.

export interface CartVoidRequest {
  readonly cart_id: string;
  readonly idempotency_key: string;
}

export type CartVoidResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.cancelPostHandoff ────────────────────────────────────────────────────
//
// Cancels a cart already in `frozen_handed_off` (spec 005 FR-033). Main is
// the authority: it gates the role (manager/admin act directly; a cashier is
// refused `manager_attribution_required`), refuses while a payment for the
// cart is started or settled, and emits the `cart.cancel.post_handoff` audit
// event atomically with the cancellation. The renderer supplies only the cart,
// the frozen envelope's `handoff_action_id`, and a fresh idempotency key — no
// attribution crosses this bridge.

export interface CartCancelPostHandoffRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
  readonly idempotency_key: string;
}

export type CartCancelPostHandoffResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.returnToSale (RT-26) ─────────────────────────────────────────────────
// Checkout Back/Esc. Main returns the SAME `frozen_handed_off` cart to `editing`
// only while the cart has no tender activity and no settled / force-failed
// payment; a zero-funds started attempt is cancelled in the same transaction,
// and the persisted envelope is cleared so it can never be paid. Lines, notes,
// versions and the cart id are untouched. The renderer supplies only the cart,
// the frozen envelope's `handoff_action_id` (binds the request to the exact
// handoff it is leaving) and an idempotency key — reused on retry so a lost
// response replays instead of being refused.

export interface CartReturnToSaleRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
  readonly idempotency_key: string;
}

export type CartReturnToSaleResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.returnToSaleEligibility (RT-26) ──────────────────────────────────────
// Read-only twin of `cart.returnToSale`: the same gates and the same payments
// proof, no writes. `returnable: false` covers a cart that is not frozen on this
// handoff as well as one with tender history / a settled or force-failed
// payment. Checkout keeps Back disabled until this says `true`.

export interface CartReturnToSaleEligibilityRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
}

export type CartReturnToSaleEligibilityResponse =
  | { readonly kind: 'ok'; readonly returnable: boolean }
  | CartRefusal;

// ── cart.undoLast (RT-254, contract RT-245) ───────────────────────────────────
// Immediate Undo of the cart's LAST action. The renderer names only the action
// it just completed (`target_action_id` = that call's idempotency key) and a
// FRESH idempotency key for the Undo itself; main proves the target is still
// the cart's newest action and chooses the exact inverse: a new line is
// soft-removed, a merge is decremented by exactly its persisted quantity, a
// delete is restored on the same row. The renderer never picks the inverse.
// Any target that is no longer eligible refuses `undo_not_available`.

export interface CartUndoLastRequest {
  readonly cart_id: string;
  readonly target_action_id: string;
  readonly idempotency_key: string;
}

export type CartUndoEffect = 'removed' | 'decremented' | 'restored';

export type CartUndoLastResponse =
  | {
      readonly kind: 'ok';
      readonly effect: CartUndoEffect;
      readonly line_id: string;
      /** The line's version after the Undo (the next mutation must send it). */
      readonly version: number;
    }
  | CartRefusal;

// ── cart.handoff ──────────────────────────────────────────────────────────────

export interface CartHandoffRequest {
  readonly cart_id: string;
  readonly per_line_versions: ReadonlyArray<{ readonly line_id: string; readonly version: number }>;
  readonly idempotency_key: string;
}

export type CartHandoffResponse =
  | { readonly kind: 'ok'; readonly envelope: PaymentIntentEnvelope }
  | CartRefusal;

// ── cart.subscribe ────────────────────────────────────────────────────────────

export interface CartSubscribeRequest {
  readonly cart_id: string;
}

export interface CartSubscribeUpdate {
  readonly cart_id: string;
  readonly state: string;
  readonly last_action_id: string;
}

export type CartSubscribeResponse =
  | { readonly kind: 'ok'; readonly update: CartSubscribeUpdate }
  | CartRefusal;

// ── cart.snapshot ─────────────────────────────────────────────────────────────
//
// V5 active cart read. Read-only: the renderer supplies ONLY the id of a cart
// it already holds; main resolves scope/ownership from the trusted session.
// The top-level projection (lines, placeholders) carries no
// tenant/branch/terminal/operator/session identity, no catalogue item_ref, no
// attribution and no action ids. The `envelope` is the exception: for an
// unpaid handed-off cart it is the same envelope `cart.handoff` returned
// (lines with item_ref and action ids, the handoff action, and session scope
// ids), with manager attribution removed. See the §A4 record
// `specs/023-pos-ui-clean-room/security-review/s-cart-snapshot-review.md`.

export interface CartSnapshotRequest {
  readonly cart_id: string;
}

/** One active (non-removed) line, exactly as persisted. Money in integer minor units. */
export interface CartSnapshotLine {
  readonly line_id: string;
  readonly display_name: string;
  readonly quantity: number;
  readonly unit_price_minor: number;
  readonly line_subtotal_minor: number;
  readonly note: string | null;
  /** Persisted optimistic-concurrency version; the next mutation must send it. */
  readonly version: number;
}

/** Opaque discount placeholder reference (no magnitude, no attribution). */
export interface CartSnapshotDiscountPlaceholder {
  readonly placeholder_id: string;
  readonly line_id: string;
}

export interface CartSnapshot {
  readonly cart_id: string;
  readonly state: CartState;
  readonly lines: ReadonlyArray<CartSnapshotLine>;
  readonly discount_placeholders: ReadonlyArray<CartSnapshotDiscountPlaceholder>;
  /**
   * True when main's payments record shows this handed-off cart as settled:
   * a completed sale. It then carries no envelope and must never be offered
   * to payment again. Always false for carts that are not handed off.
   */
  readonly paid: boolean;
  /**
   * The frozen envelope for an unpaid `frozen_handed_off` cart (the same
   * object `cart.handoff` returned, manager attribution removed), so a
   * reopened handed-off sale can continue to payment. `null` in every other
   * state, and for a paid cart.
   */
  readonly envelope: PaymentIntentEnvelope | null;
}

export type CartSnapshotResponse =
  | { readonly kind: 'ok'; readonly snapshot: CartSnapshot }
  | CartRefusal;
