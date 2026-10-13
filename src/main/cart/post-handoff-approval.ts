/**
 * RT-443 (MA-2) — the `cart.cancel_post_handoff` approval subject, as the
 * approval service resolves it at request time: the requesting session's own
 * cart (the cancel itself refuses anyone else's), frozen on a readable
 * handoff envelope. Version = that handoff, amount = the cart subtotal
 * (`postHandoffApprovalSubject`, shared with the consumption in the cancel).
 */
import type { ApprovalSubjectResolver } from '../operator/manager-approval-service.js';
import type { CartStore } from './cart-store.js';
import { postHandoffApprovalSubject } from './cart-bridge.js';

export function postHandoffCancelApprovalResolver(
  store: Pick<CartStore, 'getCart'>,
): ApprovalSubjectResolver {
  return ({ subjectRef, session }) => {
    const cart = store.getCart(subjectRef);
    if (cart === undefined || cart.operator_session_id !== session.id) return null;
    return postHandoffApprovalSubject(cart, session);
  };
}
