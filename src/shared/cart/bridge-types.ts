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

export interface CartDiscountPlaceholdersAddRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly placeholder_kind: string;
  readonly attribution_operator_id?: string;
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

export interface CartVoidRequest {
  readonly cart_id: string;
  readonly attribution_operator_id?: string;
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
// The projection is display-safe: no tenant/branch/terminal/operator/session
// identity, no catalogue item_ref, no attribution, no action ids.

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
   * The persisted frozen envelope for a `frozen_handed_off` cart (the same
   * object `cart.handoff` already returned to the renderer), so a reopened
   * handed-off sale can continue to payment. `null` in every other state.
   */
  readonly envelope: PaymentIntentEnvelope | null;
}

export type CartSnapshotResponse =
  | { readonly kind: 'ok'; readonly snapshot: CartSnapshot }
  | CartRefusal;
