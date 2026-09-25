/**
 * T094b — `payment.settled` → `FinalizeInput` dispatch-projection (RED).
 *
 * The AD-2 worker (T090) hands the dispatch closure a single
 * `handoff_action_id`. This module turns that into the full `FinalizeInput`
 * the atomic finalize transaction (T091) needs, by reading back the durable
 * 006 + 002 + 005 state that settlement left behind:
 *
 *   • the `payment.settled` audit_events row (payload: cart_id,
 *     payment_attempt_id, settled_at, attribution_operator_id,
 *     selling_operator_display_name, tender_lines[])
 *   • the `payment_attempts` row (subtotal, tenant/branch/terminal,
 *     operator_session_id)
 *   • the applied `payment_tender_lines` (tender summary + change due)
 *   • the `terminal_assignment` row (terminal_label, branch_name,
 *     branch_address, tenant_tax_registration_id)
 *   • the frozen cart envelope (`carts.handoff_envelope_json` → lines)
 *
 * The worker runs session-independently (boot recovery, T112), so every
 * field MUST come from durable storage — never from a live session.
 *
 * Coverage floor ≥95% L/B/F/S (vitest.config.ts per-file gate).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0027_extend_terminal_assignment.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

// ── Seed helpers ────────────────────────────────────────────────────────────

function seedTerminalAssignment(): void {
  db.run(
    `INSERT INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id,
        printer_vendor_id, printer_product_id, printer_com_port)
     VALUES (1, 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01', 1716800000,
        'Maadi Branch', '12 Road 9, Maadi', 'TRN-100-200-300',
        '04b8', '0e15', NULL)`,
  );
}

function seedAttempt(): void {
  db.run(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id,
       envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
       state, started_at, settled_at, failure_reason, force_fail_attribution_operator_id,
       last_action_id
     ) VALUES (
       'pa-1', 'tenant-1', 'branch-1', 'terminal-1',
       'op-clerk-user-abc', 'sess-1',
       'handoff-1', 'cart-1', 5500,
       'settled', '2026-05-27T09:59:00.000Z', '2026-05-27T22:30:00.000Z', NULL, NULL,
       'action-1'
     )`,
  );
}

function seedTenderLines(): void {
  db.run(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
       state, change_due_minor, applied_at, attribution_operator_id, apply_order, last_action_id
     ) VALUES
       ('tl-1', 'pa-1', 'cash', 4000, 'applied', 500, '2026-05-27T22:29:00.000Z', 'op-clerk-user-abc', 1, 'a1'),
       ('tl-2', 'pa-1', 'cash', 2000, 'applied', 0, '2026-05-27T22:29:30.000Z', 'op-clerk-user-abc', 2, 'a2')`,
  );
}

function seedFrozenCart(): void {
  const envelope = {
    envelope_version: 'v1',
    cart_id: 'cart-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-clerk-user-abc',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    lines: [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 2,
        unit_price_minor: 1500,
        line_subtotal_minor: 3000,
        note: null,
        version: 1,
        last_action_id: 'a1',
      },
      {
        line_id: 'line-2',
        item_ref: 'SKU-002',
        display_name: 'Vitamin C',
        quantity: 1,
        unit_price_minor: 2500,
        line_subtotal_minor: 2500,
        note: 'fridge',
        version: 1,
        last_action_id: 'a2',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: 5500,
    created_at: '2026-05-27T22:00:00.000Z',
    handoff_action_id: 'handoff-1',
  };
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES (
       'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-clerk-user-abc', 'sess-1',
       'frozen_handed_off', 5500, '2026-05-27T22:00:00.000Z', '2026-05-27T22:30:00.000Z',
       '2026-05-27T22:30:00.000Z', NULL, NULL, ?, 'action-1'
     )`,
    [JSON.stringify(envelope)],
  );
}

function seedSettledAudit(): void {
  const payload = {
    payment_attempt_id: 'pa-1',
    cart_id: 'cart-1',
    handoff_action_id: 'handoff-1',
    settled_at: '2026-05-27T22:30:00.000Z',
    attribution_operator_id: 'op-clerk-user-abc',
    selling_operator_display_name: 'Layla Hassan',
    tender_lines: [
      {
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        amount_applied_minor: 4000,
        change_due_minor: 500,
      },
      {
        tender_line_id: 'tl-2',
        tender_type: 'cash',
        amount_applied_minor: 2000,
        change_due_minor: 0,
      },
    ],
  };
  db.run(
    `INSERT INTO audit_events (
       event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
       session_id, shift_id, action_category, created_at, approving_supervisor_id, payload
     ) VALUES (
       'evt-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-clerk-user-abc',
       'sess-1', NULL, 'payment.settled', '2026-05-27T22:30:00.000Z', NULL, ?
     )`,
    [JSON.stringify(payload)],
  );
}

function seedAll(): void {
  seedTerminalAssignment();
  seedAttempt();
  seedTenderLines();
  seedFrozenCart();
  seedSettledAudit();
}

function build(handoff = 'handoff-1') {
  return buildFinalizeInput({ db: makeSqlJsHandle(db), handoff_action_id: handoff });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('T094b — buildFinalizeInput happy path', () => {
  it('projects the full FinalizeInput from durable storage', () => {
    seedAll();
    const result = build();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const input = result.input;
    expect(input.envelope_handoff_action_id).toBe('handoff-1');
    expect(input.payment_attempt_id).toBe('pa-1');
    expect(input.envelope_cart_id).toBe('cart-1');
    expect(input.tenant_id).toBe('tenant-1');
    expect(input.branch_id).toBe('branch-1');
    expect(input.terminal_id).toBe('terminal-1');
    expect(input.selling_operator_id).toBe('op-clerk-user-abc');
    expect(input.selling_operator_session_id).toBe('sess-1');
    expect(input.subtotal_minor).toBe(5500);
    expect(input.settled_at).toBe('2026-05-27T22:30:00.000Z');
  });

  it('hydrates the four gap fields from terminal_assignment', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.terminal_label).toBe('TERM-01');
    expect(result.input.branch_name).toBe('Maadi Branch');
    expect(result.input.branch_address).toBe('12 Road 9, Maadi');
    expect(result.input.tenant_tax_registration_id).toBe('TRN-100-200-300');
  });

  it('sources selling_operator_display_name from the audit payload', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.selling_operator_display_name).toBe('Layla Hassan');
  });

  it('hydrates the item lines from the frozen cart envelope', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.lines).toHaveLength(2);
    expect(result.input.lines[0]?.display_name).toBe('Paracetamol 500mg');
    expect(result.input.lines[0]?.line_subtotal_minor).toBe(3000);
    expect(result.input.lines[1]?.note).toBe('fridge');
  });

  it('computes total_change_due_minor as the sum of cash-line change due', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.total_change_due_minor).toBe(500);
  });

  it('builds tender_lines_summary from the applied tender lines', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.tender_lines_summary).toHaveLength(2);
    expect(result.input.tender_lines_summary[0]?.tender_type).toBe('cash');
    expect(result.input.tender_lines_summary[0]?.amount_applied_minor).toBe(4000);
    expect(result.input.tender_lines_summary[0]?.change_due_minor).toBe(500);
  });

  it('carries external_reference and voucher_authority_redemption_id when present', () => {
    seedTerminalAssignment();
    seedAttempt();
    seedFrozenCart();
    seedSettledAudit();
    // Replace the cash-only lines with a card + voucher mix to exercise the
    // optional-field projection arms.
    db.run(
      `INSERT INTO payment_tender_lines (
         tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
         state, external_reference, voucher_authority_redemption_id,
         applied_at, attribution_operator_id, apply_order, last_action_id
       ) VALUES
         ('tl-card', 'pa-1', 'external_card_terminal', 3000, 'applied', 'AB12XY', NULL,
          '2026-05-27T22:29:00.000Z', 'op-clerk-user-abc', 1, 'a1'),
         ('tl-vch', 'pa-1', 'internal_voucher', 2500, 'applied', NULL, 'VAR-redeem-99',
          '2026-05-27T22:29:30.000Z', 'op-clerk-user-abc', 2, 'a2')`,
    );
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    const card = result.input.tender_lines_summary.find(
      (l) => l.tender_type === 'external_card_terminal',
    );
    const voucher = result.input.tender_lines_summary.find(
      (l) => l.tender_type === 'internal_voucher',
    );
    expect(card?.external_reference).toBe('AB12XY');
    expect(voucher?.voucher_authority_redemption_id).toBe('VAR-redeem-99');
    // No cash line → change due is 0.
    expect(result.input.total_change_due_minor).toBe(0);
  });

  it('hardcodes total_tax_minor to 0 (008 v1)', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.total_tax_minor).toBe(0);
  });

  it('derives local_calendar_day from the settled_at date (UTC default)', () => {
    seedAll();
    const result = build();
    if (result.kind !== 'ok') throw new Error('expected ok');
    // settled_at 2026-05-27T22:30Z → calendar day 2026-05-27 (UTC).
    expect(result.input.local_calendar_day).toBe('2026-05-27');
  });
});

describe('T094b — missing-row refusals', () => {
  it('refuses when no payment.settled audit row exists for the handoff', () => {
    seedAll();
    const result = build('handoff-UNKNOWN');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('settled_event_not_found');
  });

  it('refuses when the payment_attempts row is missing', () => {
    seedTerminalAssignment();
    seedFrozenCart();
    seedSettledAudit();
    // no seedAttempt()
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('attempt_not_found');
  });

  it('refuses when the terminal_assignment row is missing', () => {
    seedAttempt();
    seedTenderLines();
    seedFrozenCart();
    seedSettledAudit();
    // no seedTerminalAssignment()
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('terminal_assignment_not_found');
  });

  it('refuses when the frozen cart envelope is missing', () => {
    seedTerminalAssignment();
    seedAttempt();
    seedTenderLines();
    seedSettledAudit();
    // no seedFrozenCart()
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('cart_envelope_not_found');
  });

  it('refuses when terminal_assignment exists but its gap fields are NULL', () => {
    // A terminal paired before migration 0027/T094a has a row with NULL
    // branch/tax fields. We cannot finalize a fiscal receipt without them.
    db.run(
      `INSERT INTO terminal_assignment (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
       VALUES (1, 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01', 1716800000)`,
    );
    seedAttempt();
    seedTenderLines();
    seedFrozenCart();
    seedSettledAudit();
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('terminal_assignment_not_found');
  });

  it('refuses when the settled payload is missing required string fields', () => {
    seedTerminalAssignment();
    seedAttempt();
    db.run(
      `INSERT INTO audit_events (
         event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
         session_id, shift_id, action_category, created_at, approving_supervisor_id, payload
       ) VALUES (
         'evt-partial', 'tenant-1', 'branch-1', 'terminal-1', 'op-clerk-user-abc',
         'sess-1', NULL, 'payment.settled', '2026-05-27T22:30:00.000Z', NULL, ?
       )`,
      [JSON.stringify({ handoff_action_id: 'handoff-partial', cart_id: 'cart-1' })],
    );
    const result = build('handoff-partial');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('malformed_settled_payload');
  });

  it('refuses when the frozen cart envelope JSON is structurally invalid', () => {
    seedTerminalAssignment();
    seedAttempt();
    seedTenderLines();
    seedSettledAudit();
    // A cart row whose handoff_envelope_json has no `lines` array.
    db.run(
      `INSERT INTO carts (
         cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
         state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
         cancellation_reason, handoff_envelope_json, last_action_id
       ) VALUES (
         'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'op-clerk-user-abc', 'sess-1',
         'frozen_handed_off', 5500, '2026-05-27T22:00:00.000Z', '2026-05-27T22:30:00.000Z',
         '2026-05-27T22:30:00.000Z', NULL, NULL, '{"envelope_version":"v1"}', 'action-1'
       )`,
    );
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('cart_envelope_not_found');
  });

  it('accepts an injected localCalendarDayFor seam (terminal-TZ shift)', () => {
    seedAll();
    const result = buildFinalizeInput({
      db: makeSqlJsHandle(db),
      handoff_action_id: 'handoff-1',
      localCalendarDayFor: (settled) => `TZ:${settled.slice(0, 10)}`,
    });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.input.local_calendar_day).toBe('TZ:2026-05-27');
  });
});

describe('§A4 review — a cancelled cart is never finalized', () => {
  it('refuses cart_envelope_not_found when the cart was cancelled after handoff', () => {
    seedTerminalAssignment();
    seedAttempt();
    seedTenderLines();
    seedSettledAudit();
    seedFrozenCart();
    db.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = 'cart-1'`);
    const result = build();
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('cart_envelope_not_found');
  });
});
