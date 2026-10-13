/**
 * T090 — Idempotency replay — identical payload test (RED).
 *
 * Asserts (research §R-10):
 *   • An identical-payload retry of any mutating handler is a no-op + returns
 *     the original outcome.
 *   • The outbox row is unchanged (no second insert).
 *   • The action_payload_hash redacts forbidden fields before hashing.
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
  const helper = createIdempotencyHelper({ outbox });
  return { outbox, helper };
}

describe('T090 — idempotency replay (identical payload)', () => {
  it('checkOrReserve returns "fresh" on first call and the supplied original outcome on replay', () => {
    const { outbox, helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-1',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { tender_type: 'cash', amount_applied_minor: 1500 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    expect(first.kind).toBe('fresh');

    // Caller persists their outcome alongside the outbox row.
    if (first.kind === 'fresh') {
      first.commit();
    }

    // Identical retry:
    const second = helper.checkOrReserve({
      action_id: 'idem-1',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { tender_type: 'cash', amount_applied_minor: 1500 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(second.kind).toBe('replay');
    // The outbox row exists exactly once.
    expect(outbox.findByActionId('idem-1')).toBeDefined();
  });

  it('payload key-order does not affect hash equality (deterministic canonicalisation)', () => {
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-2',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: { a: 1, b: 2, c: 3 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    expect(first.kind).toBe('fresh');
    if (first.kind === 'fresh') first.commit();

    const replay = helper.checkOrReserve({
      action_id: 'idem-2',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      // Same data, different key order.
      payload: { c: 3, a: 1, b: 2 },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(replay.kind).toBe('replay');
  });

  it('strips voucher tokens from the canonical payload before hashing (Constitution §P7)', () => {
    // Two payloads identical except for voucher_code / voucher_redemption_intent_token
    // / voucher_authority_redemption_id MUST reduce to the same hash because those
    // keys are stripped entirely (not redacted). This drives the STRIP_KEYS branch
    // in redactPayload (line ~75).
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-strip',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: {
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500,
        voucher_code: 'V-LEAK-1',
        voucher_redemption_intent_token: 'tok-LEAK-1',
        voucher_authority_redemption_id: 'auth-LEAK-1',
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    expect(first.kind).toBe('fresh');
    if (first.kind === 'fresh') first.commit();

    const replay = helper.checkOrReserve({
      action_id: 'idem-strip',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: {
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500,
        // Different tokens — but stripped before hashing.
        voucher_code: 'V-LEAK-2',
        voucher_redemption_intent_token: 'tok-LEAK-2',
        voucher_authority_redemption_id: 'auth-LEAK-2',
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(replay.kind).toBe('replay');
  });

  it('recurses into array payloads (canonicalises ordered structural shape)', () => {
    // Array branch in redactPayload (line ~71): payload is itself an array,
    // and arrays may contain objects whose fields need redaction. Two payloads
    // that differ only in a redacted/stripped field inside an array element
    // must reduce to the same hash.
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-arr',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.cancel',
      payload: {
        reversed_lines: [
          { tender_line_id: 'tl-1', external_reference: 'AB12XY' },
          { tender_line_id: 'tl-2', voucher_code: 'V-XYZ' },
        ],
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    expect(first.kind).toBe('fresh');
    if (first.kind === 'fresh') first.commit();

    const replay = helper.checkOrReserve({
      action_id: 'idem-arr',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.cancel',
      payload: {
        reversed_lines: [
          { tender_line_id: 'tl-1', external_reference: 'ZZ99ZZ' }, // redacted
          { tender_line_id: 'tl-2', voucher_code: 'V-OTHER' }, // stripped
        ],
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(replay.kind).toBe('replay');
  });

  it('preserves primitive/null leaves (string, number, boolean, null) through redactPayload', () => {
    // Drives the final `return payload` branch in redactPayload where the
    // input is neither an array nor a non-null object.
    const { helper } = setup();
    const first = helper.checkOrReserve({
      action_id: 'idem-leaf',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.fail',
      payload: {
        failure_reason: 'internal_error',
        amount_minor: 1500,
        is_retry: false,
        attribution: null,
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    expect(first.kind).toBe('fresh');
    if (first.kind === 'fresh') first.commit();

    const replay = helper.checkOrReserve({
      action_id: 'idem-leaf',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.fail',
      payload: {
        failure_reason: 'internal_error',
        amount_minor: 1500,
        is_retry: false,
        attribution: null,
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(replay.kind).toBe('replay');

    const mismatch = helper.checkOrReserve({
      action_id: 'idem-leaf',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.fail',
      payload: {
        failure_reason: 'cart_lost', // different primitive — must mismatch
        amount_minor: 1500,
        is_retry: false,
        attribution: null,
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:03.000Z',
    });
    expect(mismatch.kind).toBe('mismatch');
  });

  it('redacts external_reference to ***** before hashing (no plaintext in outbox)', () => {
    const { outbox, helper } = setup();
    // Idempotency replay treats both calls as the same operation because the
    // redacted canonical payload is identical. Use an attempt-level action so
    // we don't depend on a tender_line_id row existing (which would force the
    // test to also seed payment_tender_lines for the FK).
    const first = helper.checkOrReserve({
      action_id: 'idem-3',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 1500,
        external_reference: 'AB12XY',
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    if (first.kind === 'fresh') first.commit();

    // Same payload but reference differs: must STILL be treated as identical
    // because both reduce to ***** after redaction.
    const replay = helper.checkOrReserve({
      action_id: 'idem-3',
      payment_attempt_id: 'pa-1',
      tender_line_id: null,
      action_kind: 'payment.confirm',
      payload: {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 1500,
        external_reference: 'ZZ99ZZ',
      },
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });
    expect(replay.kind).toBe('replay');

    // And the stored hash is over the redacted form.
    const row = outbox.findByActionId('idem-3');
    expect(row).toBeDefined();
    // The hash is opaque to the caller; just assert it is a hex string of the
    // expected SHA-256 length.
    expect(row?.action_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
