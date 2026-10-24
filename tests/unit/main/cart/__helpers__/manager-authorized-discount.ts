/**
 * Test helper (RT-614): the `cart.discount.manager_authorized` audit row
 * RT-608's add writes in its own transaction. Fixtures that seed a discount
 * placeholder straight into SQL add this row too, so the placeholder is
 * trusted at handoff and payment (`src/main/cart/discount-trust.ts`).
 *
 * RT-854: the row also records the approved `amount_minor`, which the handoff
 * check compares with the line as it stands. Unless the caller gives it, it is
 * derived from the seeded placeholder's token and its line's gross.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import type { DiscountPlaceholderRef } from '../../../../../src/main/cart/discount-trust.js';
import { lineDiscountMinor } from '../../../../../src/shared/cart/manual-discount.js';

/** The amount the seeded placeholder gives on its seeded line, or undefined when either is absent. */
function seededAmount(db: SqlJsDatabase, ref: DiscountPlaceholderRef): number | undefined {
  const row = db.exec(
    `SELECT l.line_subtotal_minor, p.placeholder_kind
       FROM cart_line_discount_placeholders p JOIN cart_lines l ON l.line_id = p.line_id
      WHERE p.placeholder_id = ?`,
    [ref.placeholder_id],
  )[0]?.values[0];
  if (row === undefined) return undefined;
  return lineDiscountMinor(Number(row[0]), String(row[1])) ?? undefined;
}

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
        amount_minor: ref.amount_minor ?? seededAmount(db, ref),
      }),
    ],
  );
}
