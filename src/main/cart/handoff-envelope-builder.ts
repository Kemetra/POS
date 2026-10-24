/**
 * 005-sales-cart T087 — PaymentIntentEnvelope builder.
 *
 * Collects non-removed lines and all discount placeholders from the cart store,
 * computes subtotal_minor as the integer sum of non-removed line_subtotal_minor
 * values, and returns a frozen PaymentIntentEnvelope v1.
 *
 * RT-854 (doc 28 §3.3): also `discount_total_minor` (Σ manual line discounts,
 * from the shared pure function) and `total_due_minor`, as v1 extension
 * fields. A discount that cannot be honoured fails the build.
 *
 * SECURITY:
 * - No session credentials, PINs, or sensitive payload fragments are written
 *   into the envelope.
 * - subtotal_minor is guarded by Number.isSafeInteger before construction.
 */

import type { CartStore, CartLineRow, DiscountPlaceholderRow } from './cart-store.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import {
  freezeEnvelope,
  type PaymentIntentEnvelope,
  type LineSnapshot,
  type DiscountPlaceholderSnapshot,
} from '../../shared/cart/handoff-envelope.js';
import { envelopeDiscountTotals } from '../../shared/cart/manual-discount.js';

export interface BuildEnvelopeParams {
  cart_id: string;
  handoff_action_id: string;
  session: OperatorSessionRecord;
  /** Branch/terminal identifier (sourced from cart row, not session). */
  terminal_id: string;
  tenant_id: string;
  branch_id: string;
  created_at: string;
  store: CartStore;
}

export interface BuildEnvelopeResult {
  readonly kind: 'ok';
  readonly envelope: Readonly<PaymentIntentEnvelope>;
  readonly line_count: number;
}

export type BuildEnvelopeFailure =
  | { readonly kind: 'empty_cart' }
  | { readonly kind: 'subtotal_unsafe' }
  | { readonly kind: 'discount_invalid' };

function lineSnapshot(line: CartLineRow): LineSnapshot {
  return {
    line_id: line.line_id,
    item_ref: line.item_ref,
    display_name: line.display_name,
    quantity: line.quantity,
    unit_price_minor: line.unit_price_minor,
    line_subtotal_minor: line.line_subtotal_minor,
    note: line.note,
    version: line.version,
    last_action_id: line.last_action_id,
  };
}

function placeholderSnapshot(ph: DiscountPlaceholderRow): DiscountPlaceholderSnapshot {
  return {
    placeholder_id: ph.placeholder_id,
    line_id: ph.line_id,
    placeholder_kind: ph.placeholder_kind,
    requires_manager_attribution: ph.requires_manager_attribution !== 0,
    attribution_operator_id: ph.attribution_operator_id,
  };
}

/**
 * Builds and freezes a PaymentIntentEnvelope v1 from the current cart state.
 *
 * Returns a failure discriminant if:
 * - No non-removed lines exist (empty_cart)
 * - subtotal_minor overflows Number.isSafeInteger (subtotal_unsafe)
 * - a manual discount cannot be honoured (discount_invalid): a non-canonical
 *   token, a second discount on a line, or an amount above its line's gross
 *
 * The caller is responsible for providing only non-removed lines (via store
 * query); this function re-filters to be defensive.
 */
export function buildPaymentIntentEnvelope(
  params: BuildEnvelopeParams,
): BuildEnvelopeResult | BuildEnvelopeFailure {
  const {
    cart_id,
    handoff_action_id,
    session,
    terminal_id,
    tenant_id,
    branch_id,
    created_at,
    store,
  } = params;

  // Collect all non-removed lines for this cart.
  const allLines = store.getActiveLines(cart_id);
  if (allLines.length === 0) {
    return { kind: 'empty_cart' };
  }

  // Compute subtotal_minor as integer sum.
  let subtotal = 0;
  for (const line of allLines) {
    subtotal += line.line_subtotal_minor;
  }
  if (!Number.isSafeInteger(subtotal)) {
    return { kind: 'subtotal_unsafe' };
  }

  const lines = allLines.map(lineSnapshot);
  const discount_placeholders = store
    .getDiscountPlaceholdersForCart(cart_id)
    .map(placeholderSnapshot);

  const totals = envelopeDiscountTotals(lines, discount_placeholders);
  if (totals === null) {
    return { kind: 'discount_invalid' };
  }

  const envelope: PaymentIntentEnvelope = {
    envelope_version: 'v1',
    cart_id,
    operator_session_id: session.id,
    owning_operator_id: session.operator_id,
    tenant_id,
    branch_id,
    terminal_id,
    lines,
    discount_placeholders,
    subtotal_minor: subtotal,
    discount_total_minor: totals.discount_total_minor,
    total_due_minor: totals.total_due_minor,
    created_at,
    handoff_action_id,
  };

  return {
    kind: 'ok',
    envelope: freezeEnvelope(envelope),
    line_count: allLines.length,
  };
}
