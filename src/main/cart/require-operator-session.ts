import type { Role } from '../../shared/operator/role.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import { CartState } from '../../shared/cart/cart-state.js';
import type { CartRefusalReason } from '../../shared/cart/refusal.js';

interface CartSnapshot {
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly state: CartState;
}

export interface RequireSessionOpts {
  readonly session: OperatorSessionRecord | null;
  readonly allowedRoles?: ReadonlyArray<Role>;
  /** When true, refuses if cart is in a terminal/frozen state. */
  readonly requireMutable?: boolean;
  /** Cart to validate ownership and tenant isolation against. */
  readonly cart?: CartSnapshot | null;
}

export type RequireSessionResult =
  | { readonly kind: 'ok'; readonly session: OperatorSessionRecord }
  | { readonly kind: 'refused'; readonly reason: CartRefusalReason };

/**
 * Cart-side gate for every bridge handler.
 *
 * Returns a discriminated union — NEVER throws. Callers check
 * `result.kind === 'refused'` and propagate the refusal as-is.
 *
 * Refusal reasons are generic at the bridge surface (AD-1, FR-002,
 * NFR-003): the `reason` field is for diagnostic logging only and
 * MUST NOT be displayed to the cashier verbatim.
 */
export function requireOperatorSession(opts: RequireSessionOpts): RequireSessionResult {
  const { session, allowedRoles, requireMutable, cart } = opts;

  if (session === null) {
    return { kind: 'refused', reason: 'no_session' };
  }

  if (allowedRoles !== undefined && !allowedRoles.includes(session.role)) {
    return { kind: 'refused', reason: 'role_denied' };
  }

  if (cart !== null && cart !== undefined) {
    const reason = cartRefusalReason(session, cart, requireMutable === true);
    if (reason !== null) return { kind: 'refused', reason };
  }

  return { kind: 'ok', session };
}

/** Why `session` may not act on `cart` (isolation, ownership, mutability), else `null`. */
function cartRefusalReason(
  session: OperatorSessionRecord,
  cart: CartSnapshot,
  requireMutable: boolean,
): CartRefusalReason | null {
  if (cart.tenant_id !== session.tenant_id || cart.branch_id !== session.branch_id) {
    return 'tenant_isolation';
  }

  // Cashiers may only access their own cart; managers/admins may cross.
  if (session.role === 'cashier' && cart.operator_session_id !== session.id) {
    return 'wrong_owner';
  }

  if (!requireMutable) return null;
  if (cart.state === CartState.frozen_handed_off) return 'frozen';
  if (cart.state === CartState.cancelled) return 'closed';
  return null;
}
