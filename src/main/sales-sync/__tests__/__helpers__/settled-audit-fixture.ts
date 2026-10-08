/**
 * RT-224 step 2 — seed the `payment.settled` audit row a sale was finalized from.
 *
 * Mirrors what production writes: `createPaymentAuditEmitter().emitPaymentSettled`
 * forwarded through `index.ts forwardAuditEvent` into `audit_events`
 * (acting_operator_id = attribution_operator_id, payload = the emitter payload).
 * The defaults match `seedSale`'s defaults for the same `sale_id`
 * (`handoff-<sale_id>`, `pa-1`, `op-1`, tenant-1 / branch-1 / term-1).
 */
import type { Database as SqlJsDatabase } from 'sql.js';

export interface SeedSettledInput {
  sale_id?: string;
  event_id?: string;
  tenant_id?: string;
  branch_id?: string;
  terminal_id?: string;
  handoff_action_id?: string;
  payment_attempt_id?: string;
  attribution_operator_id?: string;
  /** Omitted = a legacy / manager-session row: no `selling_user_id` key at all. */
  selling_user_id?: unknown;
  created_at?: string;
}

let seq = 0;

export function seedSettled(db: SqlJsDatabase, o: SeedSettledInput = {}): void {
  seq += 1;
  const saleId = o.sale_id ?? 'sale-1';
  const operator = o.attribution_operator_id ?? 'op-1';
  const payload: Record<string, unknown> = {
    payment_attempt_id: o.payment_attempt_id ?? 'pa-1',
    cart_id: 'cart-1',
    handoff_action_id: o.handoff_action_id ?? `handoff-${saleId}`,
    settled_at: '2026-06-07T10:00:00.000Z',
    attribution_operator_id: operator,
    selling_operator_display_name: 'Operator One',
    tender_lines: [],
  };
  if ('selling_user_id' in o) payload['selling_user_id'] = o.selling_user_id;
  db.run(
    `INSERT INTO audit_events
       (event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id, session_id,
        shift_id, action_category, created_at, approving_supervisor_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'payment.settled', ?, NULL, ?)`,
    [
      o.event_id ?? `evt-settled-${String(seq)}`,
      o.tenant_id ?? 'tenant-1',
      o.branch_id ?? 'branch-1',
      o.terminal_id ?? 'term-1',
      operator,
      'sess-1',
      o.created_at ?? '2026-06-07T10:00:00.000Z',
      JSON.stringify(payload),
    ] as never[],
  );
}
