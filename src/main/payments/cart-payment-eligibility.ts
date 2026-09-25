import type { DatabaseHandle } from '../db/client.js';
import type { RefusalReason } from '../../shared/payments/types.js';
import { bindCartPaymentStatus } from './repositories/payment-attempts.repository.js';

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

function persistedHandoff(
  json: string | null,
): { handoff_action_id: unknown; subtotal_minor: unknown } | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Record<string, unknown>;
    return { handoff_action_id: env['handoff_action_id'], subtotal_minor: env['subtotal_minor'] };
  } catch {
    return null;
  }
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
 *                          (handoff action or subtotal), or it is unreadable.
 *   - `attempt_terminal` — the cart already has a settled payment.
 *
 * Synchronous, so the handler can run it immediately before the FSM start
 * with no await in between (main is single-threaded; no interleaving).
 */
export function bindCartPaymentEligibility(db: DatabaseHandle): CheckCartForPayment {
  const cartStmt = db.prepare(
    `SELECT state, tenant_id, branch_id, handoff_envelope_json FROM carts WHERE cart_id = ?`,
  ) as PrepareGet<CartForPaymentRow>;
  const paymentStatus = bindCartPaymentStatus(db);

  return (req) => {
    const cart = cartStmt.get(req.envelope_cart_id);
    if (
      cart === undefined ||
      cart.state !== 'frozen_handed_off' ||
      cart.tenant_id !== req.tenant_id ||
      cart.branch_id !== req.branch_id
    ) {
      return { kind: 'refused', reason: 'cart_lost' };
    }
    const handoff = persistedHandoff(cart.handoff_envelope_json);
    if (
      handoff === null ||
      handoff.handoff_action_id !== req.envelope_handoff_action_id ||
      handoff.subtotal_minor !== req.envelope_subtotal_minor
    ) {
      return { kind: 'refused', reason: 'stale_handoff' };
    }
    if (paymentStatus(req.envelope_cart_id) === 'settled') {
      return { kind: 'refused', reason: 'attempt_terminal' };
    }
    return { kind: 'ok' };
  };
}
