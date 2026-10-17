/**
 * RT-608 (RT-28 O1, RT-114 §3) — the `cart.discount.manual` approval subject,
 * as the approval service resolves it at request time and the add consumes it
 * inside its own transaction: the requesting session's own mutable cart and a
 * live line on it. The version binds cart, line, `placeholder_kind`, the
 * line's version and the cart's tenant / branch; the amount is null until
 * discount math exists (owner decision O1: intent only, no invented amount).
 */
import type {
  ApprovalSubject,
  ApprovalSubjectResolver,
} from '../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import { CartState } from '../../shared/cart/cart-state.js';
import { parseDiscountApprovalSubjectRef } from '../../shared/cart/discount-approval.js';
import type { CartLineRow, CartRow, CartStore } from './cart-store.js';

/** The discount's subject for this session, or null when not approvable. */
export function manualDiscountApprovalSubject(
  cart: CartRow | undefined,
  line: CartLineRow | undefined,
  placeholderKind: string,
  session: Pick<OperatorSessionRecord, 'id' | 'tenant_id' | 'branch_id'>,
): ApprovalSubject | null {
  if (cart === undefined || line === undefined) return null;
  if (cart.operator_session_id !== session.id) return null;
  if (cart.tenant_id !== session.tenant_id || cart.branch_id !== session.branch_id) return null;
  if ((cart.state as CartState) !== CartState.editing) return null;
  if (cart.parked_at !== undefined && cart.parked_at !== null) return null;
  if (line.cart_id !== cart.cart_id || line.removed_at !== null) return null;
  return {
    version: [
      'discount',
      cart.tenant_id,
      cart.branch_id,
      cart.cart_id,
      line.line_id,
      placeholderKind,
      `v${String(line.version)}`,
    ].join('|'),
    amountMinor: null,
  };
}

export function manualDiscountApprovalResolver(
  store: Pick<CartStore, 'getCart' | 'getLine'>,
): ApprovalSubjectResolver {
  return ({ subjectRef, session }) => {
    const intent = parseDiscountApprovalSubjectRef(subjectRef);
    if (intent === null) return null;
    return manualDiscountApprovalSubject(
      store.getCart(intent.cart_id),
      store.getLine(intent.cart_id, intent.line_id),
      intent.placeholder_kind,
      session,
    );
  };
}
