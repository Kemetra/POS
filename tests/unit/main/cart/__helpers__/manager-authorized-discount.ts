/**
 * Test helper (RT-614): the `cart.discount.manager_authorized` audit row
 * RT-608's add writes in its own transaction. Fixtures that seed a discount
 * placeholder straight into SQL add this row too, so the placeholder is
 * trusted at handoff and payment (`src/main/cart/discount-trust.ts`).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import type { DiscountPlaceholderRef } from '../../../../../src/main/cart/discount-trust.js';

export function seedManagerAuthorizedDiscount(
  db: SqlJsDatabase,
  ref: DiscountPlaceholderRef,
): void {
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload)
     VALUES (?, ?, ?, 'terminal-1', 'op-1', 'sess-1', NULL, 'cart.discount.manager_authorized',
       '2026-10-17T09:00:00.000Z', 'mgr-1', ?)`,
    [
      `evt-authorized-${ref.placeholder_id}`,
      ref.tenant_id,
      ref.branch_id,
      JSON.stringify({
        cart_id: ref.cart_id,
        cart_line_id: ref.line_id,
        placeholder_id: ref.placeholder_id,
      }),
    ],
  );
}
