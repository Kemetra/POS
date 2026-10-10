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
  | 'undo_not_available';

export interface CartRefusal {
  readonly kind: 'refused';
  readonly reason: CartRefusalReason;
}
