/**
 * T091 — Idempotency replay — payload mismatch test (RED).
 *
 * Asserts (research §R-10):
 *   • Retrying the same `action_id` with a different payload refuses with
 *     reason `idempotency_payload_mismatch`.
 *   • The outbox row from the first call is NOT replaced; the mismatch
 *     is detected and logged main-side.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0001_init.sql',
  '0002_secrets.sql',
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0005_operator_sessions.sql',
  '0006_cashier_pin_records.sql',
  '0007_shifts.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
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

function setup() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  attempts.insert({
    payment_attempt_id: 'pa-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    started_at: '2026-05-22T10:00:00.000Z',
    last_action_id: 'start-pa-1',
  });
  return { outbox, helper: createIdempotencyHelper({ outbox }) };
}

describe('T091 — idempotency replay (payload mismatch)', () => {
  it('returns mismatch when payload differs', () => {
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-1',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { tender_type: 'cash', amount_applied_minor: 1500 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    if (first.kind === 'fresh') first.commit();

    const result = helper.checkOrReserve({
      action_id: 'idem-1',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { tender_type: 'cash', amount_applied_minor: 2000 }, // amount differs.
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(result.kind).toBe('mismatch');
  });

  it('does not replace the original outbox row on mismatch', () => {
    const { outbox, helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-2',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { foo: 1 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    if (first.kind === 'fresh') first.commit();
    const originalHash = outbox.findByActionId('idem-2')?.action_payload_hash;

    helper.checkOrReserve({
      action_id: 'idem-2',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { foo: 2 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });

    expect(outbox.findByActionId('idem-2')?.action_payload_hash).toBe(originalHash);
  });

  it('treats different action_kind as a mismatch', () => {
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-3',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { foo: 1 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    if (first.kind === 'fresh') first.commit();

    const result = helper.checkOrReserve({
      action_id: 'idem-3',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.cancel',
      payload: { foo: 1 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(result.kind).toBe('mismatch');
  });
});
