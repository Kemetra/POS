/**
 * RT-440 (PK-2) — Park v1 bridge contract (spec 024 §3).
 *
 * Main-authoritative: the renderer names a cart, an optional label, its
 * choice and an idempotency key. Main derives owner, state, totals and prices
 * from its own rows. Refusals are closed categories; none of them carries an
 * owner, a label or an amount.
 */

/** Spec 024 K2: at most this many parked sales per terminal, across operators. */
export const PARK_LIMIT_PER_TERMINAL = 5;

/** Spec 024 K2: the optional label, after trimming. */
export const PARK_LABEL_MAX_LENGTH = 40;

/** Spec 024 K4: a parked sale older than this is shown `stale` (display only). */
export const PARK_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export const CART_PARK_REFUSAL_REASONS = [
  'no_session',
  'session_locked',
  'wrong_owner',
  'not_parkable',
  'park_limit_reached',
  'invalid_label',
  'not_parked',
  'catalogue_unavailable',
  'checkout_in_progress',
  'price_changes_unaccepted',
  'current_cart_active',
  'idempotency_payload_mismatch',
  // RT-113 P2: a session that lost its authority may not bring a sale back.
  'authority_conflict',
] as const;
export type CartParkRefusalReason = (typeof CART_PARK_REFUSAL_REASONS)[number];

export interface CartParkRefusal {
  readonly kind: 'refused';
  readonly reason: CartParkRefusalReason;
}

export interface CartParkRequest {
  cart_id: string;
  /** Optional, plain text, 1–40 characters after trimming. Local only. */
  label?: string;
  idempotency_key: string;
}

export type CartParkResponse = { kind: 'parked' } | CartParkRefusal;

/** One of the current operator's parked sales on this terminal (§3.2). */
export interface ParkedSaleView {
  cart_id: string;
  label: string | null;
  line_count: number;
  total_minor: number;
  parked_at: string;
  /** Older than 12 h, or parked on an earlier Cairo business day (K4). */
  stale: boolean;
}

export type CartListParkedResponse =
  | { kind: 'parked_sales'; items: ParkedSaleView[] }
  | CartParkRefusal;

export interface CartPreviewResumeRequest {
  cart_id: string;
}

/**
 * RT-610 (RT-471 OD-1) — a reviewed line as the cashier sees it: its product
 * name and quantity, read in main from the parked line itself (the name is the
 * add-time snapshot). Display only: never sent back, never part of `diff_token`.
 */
export interface ResumeLineRef {
  line_id: string;
  display_name: string;
  quantity: number;
}

export interface ResumePriceChange extends ResumeLineRef {
  old_unit_minor: number;
  new_unit_minor: number;
}

/** A line whose product is no longer in the catalogue. */
export type ResumeUnavailableLine = ResumeLineRef;

export type CartPreviewResumeResponse =
  | {
      kind: 'preview';
      changes: ResumePriceChange[];
      /** Lines whose product is no longer in the catalogue (removed on an accepted resume). */
      unavailable: ResumeUnavailableLine[];
      /** Opaque: pass it back to `cart.resume` unchanged. */
      diff_token: string;
    }
  | CartParkRefusal;

export interface CartResumeRequest {
  cart_id: string;
  accept_changes: boolean;
  diff_token: string;
  /** What happens to a non-empty current sale (I-13, VN-R10). */
  current_cart: 'park' | 'keep';
  idempotency_key: string;
}

export type CartResumeResponse = { kind: 'resumed'; cart_id: string } | CartParkRefusal;

/** The `cart.*` park namespace on the preload bridge. */
export interface CartParkBridgeAPI {
  park(req: CartParkRequest): Promise<CartParkResponse>;
  listParked(): Promise<CartListParkedResponse>;
  previewResume(req: CartPreviewResumeRequest): Promise<CartPreviewResumeResponse>;
  resume(req: CartResumeRequest): Promise<CartResumeResponse>;
}
