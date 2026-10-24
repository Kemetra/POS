/**
 * RT-856 — seed a settled, handed-off cart with manual line discounts on a
 * fully migrated sql.js DB: the terminal assignment, the payment attempt (its
 * amount due is the net, RT-854), one cash tender, the `payment.settled` row,
 * the frozen envelope and one `cart.discount.manager_authorized` row per
 * discount, as RT-854's add writes them.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

export const TENANT = 'tenant-1';
export const BRANCH = 'branch-1';
export const TERMINAL = 'terminal-1';
export const HANDOFF = 'handoff-1';

export interface SeedLine {
  line_id: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
}

export interface SeedDiscount {
  placeholder_id: string;
  line_id: string;
  token: string;
  /** The `amount_minor` the add recorded in its audit row. */
  amount_minor: number;
  /** The audit payload, merged over the RT-854 defaults; `null` writes no audit row. */
  audit?: Record<string, unknown> | null;
  approving_supervisor_id?: string | null;
}

export interface SeedInput {
  lines: readonly SeedLine[];
  discounts?: readonly SeedDiscount[];
  /** The attempt's amount due (`envelope_subtotal_minor`, the net since RT-854). */
  amountDue: number;
}

function gross(line: SeedLine): number {
  return line.quantity * line.unit_price_minor;
}

function envelopeLine(line: SeedLine) {
  return {
    line_id: line.line_id,
    item_ref: `SKU-${line.line_id}`,
    display_name: line.display_name,
    quantity: line.quantity,
    unit_price_minor: line.unit_price_minor,
    line_subtotal_minor: gross(line),
    note: null,
    version: 1,
    last_action_id: `act-${line.line_id}`,
  };
}

function seedHeader(db: SqlJsDatabase, amountDue: number): void {
  db.run(
    `INSERT INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id)
     VALUES (1, ?, ?, ?, 'TERM-01', 1716800000, 'Maadi', '12 Road 9', 'TRN-1')`,
    [TENANT, BRANCH, TERMINAL],
  );
  db.run(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id, acting_operator_id,
       operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, settled_at, failure_reason,
       force_fail_attribution_operator_id, last_action_id
     ) VALUES ('pa-1', ?, ?, ?, 'op-cashier', 'sess-1', ?, 'cart-1', ?, 'settled',
       '2026-10-24T09:59:00.000Z', '2026-10-24T10:00:00.000Z', NULL, NULL, 'a-pa')`,
    [TENANT, BRANCH, TERMINAL, HANDOFF, amountDue],
  );
  if (amountDue > 0) {
    db.run(
      `INSERT INTO payment_tender_lines (
         tender_line_id, payment_attempt_id, tender_type, amount_applied_minor, state,
         change_due_minor, applied_at, attribution_operator_id, apply_order, last_action_id
       ) VALUES ('tl-1', 'pa-1', 'cash', ?, 'applied', 0, '2026-10-24T09:59:30.000Z',
         'op-cashier', 1, 'a-tl')`,
      [amountDue],
    );
  }
  const settled = {
    payment_attempt_id: 'pa-1',
    cart_id: 'cart-1',
    handoff_action_id: HANDOFF,
    settled_at: '2026-10-24T10:00:00.000Z',
    attribution_operator_id: 'op-cashier',
    selling_operator_display_name: 'Layla',
    tender_lines: [],
  };
  insertAudit(db, {
    eventId: 'evt-settled',
    category: 'payment.settled',
    supervisor: null,
    payload: settled,
  });
}

interface AuditSeed {
  eventId: string;
  category: string;
  supervisor: string | null;
  payload: Record<string, unknown>;
}

function insertAudit(db: SqlJsDatabase, audit: AuditSeed): void {
  const { eventId, category, supervisor, payload } = audit;
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload)
     VALUES (?, ?, ?, ?, 'op-cashier', 'sess-1', NULL, ?, '2026-10-24T09:10:00.000Z', ?, ?)`,
    [eventId, TENANT, BRANCH, TERMINAL, category, supervisor, JSON.stringify(payload)],
  );
}

/** The RT-854 audit payload of a cashier-approved add. */
function defaultAudit(discount: SeedDiscount): Record<string, unknown> {
  const [, kind, value] = /^manual_(pct|amt)_(\d+)$/.exec(discount.token) ?? [];
  return {
    cart_id: 'cart-1',
    cart_line_id: discount.line_id,
    placeholder_id: discount.placeholder_id,
    approval_id: `appr-${discount.placeholder_id}`,
    reason_code: 'promotion',
    kind: kind === 'pct' ? 'percent' : 'amount',
    value: Number(value),
    amount_minor: discount.amount_minor,
  };
}

/** Seeds everything `buildFinalizeInput` reads. */
export function seedDiscountedHandoff(db: SqlJsDatabase, input: SeedInput): void {
  seedHeader(db, input.amountDue);
  const discounts = input.discounts ?? [];
  const lines = input.lines.map(envelopeLine);
  const subtotal = lines.reduce((sum, line) => sum + line.line_subtotal_minor, 0);
  const envelope = {
    envelope_version: 'v1',
    cart_id: 'cart-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-cashier',
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    lines,
    discount_placeholders: discounts.map((d) => ({
      placeholder_id: d.placeholder_id,
      line_id: d.line_id,
      placeholder_kind: d.token,
      requires_manager_attribution: true,
      attribution_operator_id: 'mgr-1',
    })),
    subtotal_minor: subtotal,
    discount_total_minor: subtotal - input.amountDue,
    total_due_minor: input.amountDue,
    created_at: '2026-10-24T09:00:00.000Z',
    handoff_action_id: HANDOFF,
  };
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES ('cart-1', ?, ?, ?, 'op-cashier', 'sess-1', 'frozen_handed_off', ?,
       '2026-10-24T09:00:00.000Z', '2026-10-24T09:30:00.000Z', '2026-10-24T09:30:00.000Z',
       NULL, NULL, ?, 'a1')`,
    [TENANT, BRANCH, TERMINAL, subtotal, JSON.stringify(envelope)],
  );
  for (const discount of discounts) {
    if (discount.audit === null) continue;
    const payload = { ...defaultAudit(discount), ...discount.audit };
    const supervisor =
      discount.approving_supervisor_id === undefined ? 'mgr-1' : discount.approving_supervisor_id;
    insertAudit(db, {
      eventId: `evt-${discount.placeholder_id}`,
      category: 'cart.discount.manager_authorized',
      supervisor,
      payload,
    });
  }
}
