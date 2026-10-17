export type CartRefusalReason =
  | 'no_session'
  | 'role_denied'
  | 'wrong_owner'
  | 'tenant_isolation'
  | 'frozen'
  | 'closed'
  | 'stale_version'
  | 'empty_cart'
  | 'note_too_long'
  | 'note_forbidden_pattern'
  | 'manager_attribution_required'
  | 'idempotency_payload_mismatch'
  | 'not_implemented'
  /**
   * RT-113 P2 — the session lost its authority (taken over on another till,
   * account refused, device revoked) and ends at its next safe point: no NEW
   * sale may start. Generic: no cause is disclosed (10763 §3).
   */
  | 'authority_conflict'
  /**
   * RT-254 — `cart.undoLast`: the named action is no longer the cart's
   * eligible last action (a later mutation, handoff, or changed line state).
   * Generic: the renderer only dismisses its Undo affordance.
   */
  | 'undo_not_available'
  /**
   * RT-443 (MA-2) — `cart.cancelPostHandoff` by a cashier: the manager approval
   * named is unknown, used, expired, for another action or requester
   * (`approval_invalid`), or the cart changed since it was approved
   * (`approval_stale`). Nothing was cancelled; ask for a new approval.
   */
  | 'approval_invalid'
  | 'approval_stale'
  /**
   * RT-440 (spec 024 K5) — the cart is parked: it changes only through
   * `cart.resume`. Every other cart mutation refuses it.
   */
  | 'cart_parked'
  /**
   * RT-614 (RT-28, envelope step 3a) — `cart.handoff`: the cart holds a
   * manual-discount placeholder no manager authorised (no
   * `cart.discount.manager_authorized` audit row names it). Remove it, or
   * re-add it with manager authority, then hand off again.
   */
  | 'unauthorized_discount';

export interface CartRefusal {
  readonly kind: 'refused';
  readonly reason: CartRefusalReason;
}
