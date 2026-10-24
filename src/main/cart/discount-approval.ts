/**
 * RT-608 (RT-28 O1, RT-114 §3) — the `cart.discount.manual` approval subject,
 * as the approval service resolves it at request time and the add consumes it
 * inside its own transaction: the requesting session's own mutable cart and a
 * live line on it. The version binds cart, line, `placeholder_kind`, the
 * line's version and the cart's tenant / branch.
 *
 * RT-854 (doc 28 §3.1): the amount is the discount the canonical token gives
 * on the line gross (`lineDiscountMinor`), and the version carries it too.
 * This retires O1's interim "intent only" (`amountMinor = null`), as O1
 * anticipated. A non-canonical token, or an amount the line cannot take, is
 * not approvable.
 */
import type {
  ApprovalSubject,
  ApprovalSubjectResolver,
} from '../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import { CartState } from '../../shared/cart/cart-state.js';
import { parseDiscountApprovalSubjectRef } from '../../shared/cart/discount-approval.js';
import { lineDiscountMinor } from '../../shared/cart/manual-discount.js';
import type { CartLineRow, CartRow, CartStore } from './cart-store.js';

/** The session's own cart, in its scope, still editable (not frozen, not parked). */
function isApprovableCart(
  cart: CartRow,
  session: Pick<OperatorSessionRecord, 'id' | 'tenant_id' | 'branch_id'>,
): boolean {
  return [
    cart.operator_session_id === session.id,
    cart.tenant_id === session.tenant_id,
    cart.branch_id === session.branch_id,
    (cart.state as CartState) === CartState.editing,
    cart.parked_at === undefined || cart.parked_at === null,
  ].every(Boolean);
}

/** A line of this cart that has not been removed. */
function isLiveLineOf(line: CartLineRow, cart: CartRow): boolean {
  return line.cart_id === cart.cart_id && line.removed_at === null;
}

/** The discount's subject for this session, or null when not approvable. */
export function manualDiscountApprovalSubject(
  cart: CartRow | undefined,
  line: CartLineRow | undefined,
  placeholderKind: string,
  session: Pick<OperatorSessionRecord, 'id' | 'tenant_id' | 'branch_id'>,
): ApprovalSubject | null {
  if (cart === undefined || line === undefined) return null;
  if (!isApprovableCart(cart, session) || !isLiveLineOf(line, cart)) return null;
  const amountMinor = lineDiscountMinor(line.line_subtotal_minor, placeholderKind);
  if (amountMinor === null) return null;
  return {
    version: [
      'discount',
      cart.tenant_id,
      cart.branch_id,
      cart.cart_id,
      line.line_id,
      placeholderKind,
      `v${String(line.version)}`,
      `a${String(amountMinor)}`,
    ].join('|'),
    amountMinor,
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
