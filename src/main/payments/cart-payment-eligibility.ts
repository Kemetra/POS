import type { DatabaseHandle } from '../db/client.js';
import type { RefusalReason } from '../../shared/payments/types.js';
import { envelopeAmountDue } from '../../shared/cart/handoff-envelope.js';
import { parseManualDiscountToken } from '../../shared/cart/manual-discount.js';
import {
  bindDiscountPlaceholderTrust,
  type IsDiscountPlaceholderTrusted,
} from '../cart/discount-trust.js';
import {
  bindCartHasForceFailedLiveTender,
  bindCartPaymentStatus,
} from './repositories/payment-attempts.repository.js';

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface CartForPaymentRow {
  state: string;
  tenant_id: string;
  branch_id: string;
  handoff_envelope_json: string | null;
}

/** What `payments.start` asks main before opening an attempt. */
export interface CartPaymentEligibilityRequest {
  readonly envelope_cart_id: string;
  readonly envelope_handoff_action_id: string;
  readonly envelope_subtotal_minor: number;
  /** From the trusted operator session, never from the request. */
  readonly tenant_id: string;
  readonly branch_id: string;
}

export type CartPaymentEligibility =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

export type CheckCartForPayment = (req: CartPaymentEligibilityRequest) => CartPaymentEligibility;

interface PersistedHandoff {
  handoff_action_id: unknown;
  /** RT-854: `total_due_minor`, or `subtotal_minor` on a pre-RT-854 envelope. */
  amount_due_minor: number | null;
  discount_placeholders: unknown;
}

function persistedHandoff(json: string | null): PersistedHandoff | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Record<string, unknown>;
    return {
      handoff_action_id: env['handoff_action_id'],
      amount_due_minor: envelopeAmountDue(env),
      discount_placeholders: env['discount_placeholders'],
    };
  } catch {
    return null;
  }
}

/** The cart exists, is handed off, and belongs to the session's tenant and branch. */
function isHandedOffInScope(
  cart: CartForPaymentRow | undefined,
  req: CartPaymentEligibilityRequest,
): cart is CartForPaymentRow {
  return (
    cart?.state === 'frozen_handed_off' &&
    cart.tenant_id === req.tenant_id &&
    cart.branch_id === req.branch_id
  );
}

/**
 * The request names exactly the persisted handoff: its action, and the amount
 * due. RT-854 (doc 28 §3.3): the request's `envelope_subtotal_minor` is the
 * amount the payment covers, the envelope's net `total_due_minor`; with no
 * discount (or on a pre-RT-854 envelope) that is `subtotal_minor`.
 */
function matchesPersistedHandoff(
  handoff: PersistedHandoff | null,
  req: CartPaymentEligibilityRequest,
): handoff is PersistedHandoff {
  return (
    handoff?.handoff_action_id === req.envelope_handoff_action_id &&
    handoff.amount_due_minor !== null &&
    handoff.amount_due_minor === req.envelope_subtotal_minor
  );
}

/** A string-valued field of an untrusted parsed object, or null. */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

/**
 * RT-614 (envelope step 3b) — every discount placeholder in the persisted
 * envelope is manager-authorised. An envelope without the field carries none;
 * a malformed field or entry is untrusted (fail closed).
 */
function envelopeDiscountsTrusted(
  placeholders: unknown,
  cart: CartForPaymentRow,
  cartId: string,
  isTrusted: IsDiscountPlaceholderTrusted,
): boolean {
  if (placeholders === undefined) return true;
  if (!Array.isArray(placeholders)) return false;
  return placeholders.every((placeholder: unknown) => {
    const placeholderId = stringField(placeholder, 'placeholder_id');
    const lineId = stringField(placeholder, 'line_id');
    if (placeholderId === null || lineId === null) return false;
    // RT-854 (doc 28 §3.1): a kind that is not a canonical token has no value.
    const kind = stringField(placeholder, 'placeholder_kind');
    if (kind === null || parseManualDiscountToken(kind) === null) return false;
    return isTrusted({
      tenant_id: cart.tenant_id,
      branch_id: cart.branch_id,
      cart_id: cartId,
      line_id: lineId,
      placeholder_id: placeholderId,
    });
  });
}

/**
 * Main-side authority for "may this cart be paid now?" (§A4 review,
 * 2026-09-25). `payments.start` receives the envelope fields from the
 * renderer; without this check main would open an attempt for a cancelled
 * cart, for a cart in another tenant/branch, for a forged envelope, or for a
 * sale that is already paid. Refusals reuse the closed payments enum:
 *
 *   - `cart_lost`        — unknown cart, not `frozen_handed_off` (cancelled,
 *                          editing, …), or outside the session's tenant/branch.
 *   - `stale_handoff`    — the request does not match the persisted envelope
 *                          (handoff action or amount due — RT-854: the net
 *                          `total_due_minor`), or it is unreadable.
 *   - `unauthorized_discount` — RT-614 (RT-28 step 3b): the persisted envelope
 *                          holds a manual-discount placeholder no
 *                          `cart.discount.manager_authorized` audit row names
 *                          (e.g. frozen before the upgrade), or (RT-854) one
 *                          whose kind is not a canonical token. Recovery is the
 *                          manager post-handoff cancel (005 FR-033).
 *   - `attempt_terminal` — the cart already has a settled payment, or a
 *                          force-failed attempt that still holds live tender
 *                          (force-fail does not reverse tender, so paying again
 *                          could charge the customer twice).
 *
 * Synchronous, so the handler can run it immediately before the FSM start
 * with no await in between (main is single-threaded; no interleaving).
 */
export function bindCartPaymentEligibility(db: DatabaseHandle): CheckCartForPayment {
  const cartStmt = db.prepare(
    `SELECT state, tenant_id, branch_id, handoff_envelope_json FROM carts WHERE cart_id = ?`,
  ) as PrepareGet<CartForPaymentRow>;
  const paymentStatus = bindCartPaymentStatus(db);
  const forceFailedWithLiveTender = bindCartHasForceFailedLiveTender(db);
  const isDiscountTrusted = bindDiscountPlaceholderTrust(db);

  return (req) => {
    const cart = cartStmt.get(req.envelope_cart_id);
    if (!isHandedOffInScope(cart, req)) return { kind: 'refused', reason: 'cart_lost' };
    const handoff = persistedHandoff(cart.handoff_envelope_json);
    if (!matchesPersistedHandoff(handoff, req)) {
      return { kind: 'refused', reason: 'stale_handoff' };
    }
    if (
      !envelopeDiscountsTrusted(
        handoff.discount_placeholders,
        cart,
        req.envelope_cart_id,
        isDiscountTrusted,
      )
    ) {
      return { kind: 'refused', reason: 'unauthorized_discount' };
    }
    if (paymentStatus(req.envelope_cart_id) === 'settled') {
      return { kind: 'refused', reason: 'attempt_terminal' };
    }
    if (forceFailedWithLiveTender(req.envelope_cart_id)) {
      return { kind: 'refused', reason: 'attempt_terminal' };
    }
    return { kind: 'ok' };
  };
}
