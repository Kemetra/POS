import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T066 — 006 Slice 3a migration integration test.
 *
 * Applies the four 006 migrations on top of the 005 cart migrations and the
 * 004 audit_events migration, then asserts:
 *   • All three new tables exist with the expected columns + indexes.
 *   • CHECK constraints reject illegal rows per data-model.md.
 *   • Foreign keys are enforced (PRAGMA foreign_keys = ON, matching production).
 *   • The partial unique index `payment_attempts_one_started_per_terminal`
 *     refuses two concurrent `started` rows on the same terminal.
 *   • The append-only trigger on `payment_action_outbox` denies UPDATE + DELETE.
 *   • `audit_events.action_category` accepts all 8 new categories cleared by §A3
 *     (4 attempt-level + 4 per-line; `tender.reversal_pending` ratified by T204's
 *     additive migration `migrations/0018_audit_event_tender_reversal_pending.sql`).
 *
 * Mirrors the existing migration-test pattern in tests/integration/main/db/.
 * Uses sql.js (pure-JS SQLite) so the native better-sqlite3 binding is not
 * required at test time (R1 in src/main/db/client.ts).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

// Migrations needed to satisfy 006's FK references plus the new 006 set.
// Order matters: 0004 (audit_events) is referenced by T065's audit-category
// extension; the 006 set must apply in lexical order after the 005 tables.
const PREREQ_MIGRATIONS = [
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
];

const S3A_MIGRATIONS = [
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
];

let SQL: SqlJsStatic;
const sqlCache = new Map<string, string>();

function loadSql(name: string): string {
  let cached = sqlCache.get(name);
  if (cached === undefined) {
    cached = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    sqlCache.set(name, cached);
  }
  return cached;
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  // Production opens DBs with foreign_keys = ON (src/main/db/client.ts).
  // sql.js defaults OFF; turn it on so FK assertions are meaningful.
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of PREREQ_MIGRATIONS) db.exec(loadSql(name));
  for (const name of S3A_MIGRATIONS) db.exec(loadSql(name));
  return db;
}

function tableExists(db: SqlJsDatabase, name: string): boolean {
  const result = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return (result[0]?.values.length ?? 0) === 1;
}

function indexExists(db: SqlJsDatabase, name: string): boolean {
  const result = db.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`);
  return (result[0]?.values.length ?? 0) === 1;
}

function columns(db: SqlJsDatabase, table: string): Set<string> {
  const result = db.exec(`PRAGMA table_info(${table})`);
  const names = new Set<string>();
  for (const row of result[0]?.values ?? []) {
    names.add(String(row[1]));
  }
  return names;
}

function insertAttempt(
  db: SqlJsDatabase,
  overrides: Partial<{
    payment_attempt_id: string;
    tenant_id: string;
    branch_id: string;
    terminal_id: string;
    acting_operator_id: string;
    operator_session_id: string;
    envelope_handoff_action_id: string;
    envelope_cart_id: string;
    envelope_subtotal_minor: number;
    state: string;
    started_at: string;
    settled_at: string | null;
    cancelled_at: string | null;
    failed_at: string | null;
    force_failed_at: string | null;
    failure_reason: string | null;
    force_fail_attribution_operator_id: string | null;
    last_action_id: string;
  }> = {},
): void {
  const row = {
    payment_attempt_id: 'attempt-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    state: 'started',
    started_at: '2026-05-22T10:00:00.000Z',
    settled_at: null,
    cancelled_at: null,
    failed_at: null,
    force_failed_at: null,
    failure_reason: null,
    force_fail_attribution_operator_id: null,
    last_action_id: 'action-1',
    ...overrides,
  };
  db.run(
    `INSERT INTO payment_attempts
       (payment_attempt_id, tenant_id, branch_id, terminal_id,
        acting_operator_id, operator_session_id,
        envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
        state, started_at, settled_at, cancelled_at, failed_at, force_failed_at,
        failure_reason, force_fail_attribution_operator_id, last_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.payment_attempt_id,
      row.tenant_id,
      row.branch_id,
      row.terminal_id,
      row.acting_operator_id,
      row.operator_session_id,
      row.envelope_handoff_action_id,
      row.envelope_cart_id,
      row.envelope_subtotal_minor,
      row.state,
      row.started_at,
      row.settled_at,
      row.cancelled_at,
      row.failed_at,
      row.force_failed_at,
      row.failure_reason,
      row.force_fail_attribution_operator_id,
      row.last_action_id,
    ],
  );
}

function insertLine(
  db: SqlJsDatabase,
  overrides: Partial<{
    tender_line_id: string;
    payment_attempt_id: string;
    tender_type: string;
    amount_applied_minor: number;
    state: string;
    change_due_minor: number | null;
    external_reference: string | null;
    voucher_redemption_intent_token: string | null;
    voucher_authority_redemption_id: string | null;
    applied_at: string | null;
    refused_at: string | null;
    reversed_at: string | null;
    reversal_pending_since: string | null;
    refusal_reason: string | null;
    attribution_operator_id: string;
    apply_order: number;
    last_action_id: string;
  }> = {},
): void {
  const row = {
    tender_line_id: 'line-1',
    payment_attempt_id: 'attempt-1',
    tender_type: 'cash',
    amount_applied_minor: 1500,
    state: 'applied',
    change_due_minor: null,
    external_reference: null,
    voucher_redemption_intent_token: null,
    voucher_authority_redemption_id: null,
    applied_at: '2026-05-22T10:00:01.000Z',
    refused_at: null,
    reversed_at: null,
    reversal_pending_since: null,
    refusal_reason: null,
    attribution_operator_id: 'op-abc',
    apply_order: 1,
    last_action_id: 'action-2',
    ...overrides,
  };
  db.run(
    `INSERT INTO payment_tender_lines
       (tender_line_id, payment_attempt_id, tender_type, amount_applied_minor, state,
        change_due_minor, external_reference,
        voucher_redemption_intent_token, voucher_authority_redemption_id,
        applied_at, refused_at, reversed_at, reversal_pending_since,
        refusal_reason, attribution_operator_id, apply_order, last_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.tender_line_id,
      row.payment_attempt_id,
      row.tender_type,
      row.amount_applied_minor,
      row.state,
      row.change_due_minor,
      row.external_reference,
      row.voucher_redemption_intent_token,
      row.voucher_authority_redemption_id,
      row.applied_at,
      row.refused_at,
      row.reversed_at,
      row.reversal_pending_since,
      row.refusal_reason,
      row.attribution_operator_id,
      row.apply_order,
      row.last_action_id,
    ],
  );
}

function insertOutbox(
  db: SqlJsDatabase,
  overrides: Partial<{
    action_id: string;
    payment_attempt_id: string;
    tender_line_id: string | null;
    action_kind: string;
    action_payload_hash: string;
    acting_operator_id: string;
    created_at: string;
  }> = {},
): void {
  const row = {
    action_id: 'action-1',
    payment_attempt_id: 'attempt-1',
    tender_line_id: null,
    action_kind: 'payment.attempt.start',
    action_payload_hash: 'a'.repeat(64),
    acting_operator_id: 'op-abc',
    created_at: '2026-05-22T10:00:00.000Z',
    ...overrides,
  };
  db.run(
    `INSERT INTO payment_action_outbox
       (action_id, payment_attempt_id, tender_line_id, action_kind,
        action_payload_hash, acting_operator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.action_id,
      row.payment_attempt_id,
      row.tender_line_id,
      row.action_kind,
      row.action_payload_hash,
      row.acting_operator_id,
      row.created_at,
    ],
  );
}

describe('T066 — 006 Slice 3a migrations', () => {
  describe('schema presence', () => {
    it.each(['payment_attempts', 'payment_tender_lines', 'payment_action_outbox'])(
      'creates %s table',
      (table) => {
        const db = freshDb();
        expect(tableExists(db, table)).toBe(true);
        db.close();
      },
    );

    it('payment_attempts has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'payment_attempts');
      for (const expected of [
        'payment_attempt_id',
        'tenant_id',
        'branch_id',
        'terminal_id',
        'acting_operator_id',
        'operator_session_id',
        'envelope_handoff_action_id',
        'envelope_cart_id',
        'envelope_subtotal_minor',
        'state',
        'started_at',
        'settled_at',
        'cancelled_at',
        'failed_at',
        'force_failed_at',
        'failure_reason',
        'force_fail_attribution_operator_id',
        'last_action_id',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('payment_tender_lines has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'payment_tender_lines');
      for (const expected of [
        'tender_line_id',
        'payment_attempt_id',
        'tender_type',
        'amount_applied_minor',
        'state',
        'change_due_minor',
        'external_reference',
        'voucher_redemption_intent_token',
        'voucher_authority_redemption_id',
        'applied_at',
        'refused_at',
        'reversed_at',
        'reversal_pending_since',
        'refusal_reason',
        'attribution_operator_id',
        'apply_order',
        'last_action_id',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('payment_action_outbox has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'payment_action_outbox');
      for (const expected of [
        'action_id',
        'payment_attempt_id',
        'tender_line_id',
        'action_kind',
        'action_payload_hash',
        'acting_operator_id',
        'created_at',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('declared indexes exist', () => {
      const db = freshDb();
      expect(indexExists(db, 'idx_payment_attempts_envelope_handoff_action_id')).toBe(true);
      expect(indexExists(db, 'idx_payment_attempts_state_branch')).toBe(true);
      expect(indexExists(db, 'payment_attempts_one_started_per_terminal')).toBe(true);
      expect(indexExists(db, 'idx_payment_tender_lines_attempt_apply_order')).toBe(true);
      expect(indexExists(db, 'idx_payment_tender_lines_attempt_state')).toBe(true);
      expect(indexExists(db, 'idx_payment_tender_lines_reversal_pending')).toBe(true);
      expect(indexExists(db, 'idx_payment_action_outbox_attempt_created')).toBe(true);
      expect(indexExists(db, 'idx_payment_action_outbox_line_created')).toBe(true);
      db.close();
    });
  });

  describe('payment_attempts — happy path + CHECK constraints', () => {
    it('inserts a started attempt', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db);
      }).not.toThrow();
      db.close();
    });

    it('rejects an unknown state value', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, { state: 'in_flight' });
      }).toThrow();
      db.close();
    });

    it('rejects a negative envelope_subtotal_minor', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, { envelope_subtotal_minor: -1 });
      }).toThrow();
      db.close();
    });

    it('rejects an unknown failure_reason', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, {
          state: 'failed',
          failed_at: '2026-05-22T10:05:00.000Z',
          failure_reason: 'mystery',
        });
      }).toThrow();
      db.close();
    });

    it('accepts every closed failure_reason value', () => {
      const db = freshDb();
      const reasons = [
        'cart_lost',
        'operator_session_terminated',
        'dependency_unavailable',
        'internal_error',
        'stale_handoff',
        'tender_underpaid',
        'non_cash_overpayment_refused',
        'voucher_not_found',
        'voucher_expired',
        'voucher_cancelled',
        'voucher_already_redeemed',
        'voucher_tenant_mismatch',
        'voucher_branch_mismatch',
        'split_tender_rollback',
        // Wave 5e — migration 0019 extends the CHECK enum with the
        // manager-force-fail reason (FR-006). Without 0019 this entry
        // would raise the CHECK violation that produced finding
        // F-W5D-001.
        'manager_force_failed',
      ];
      for (let i = 0; i < reasons.length; i += 1) {
        const idx = String(i);
        expect(() => {
          insertAttempt(db, {
            payment_attempt_id: `attempt-${idx}`,
            terminal_id: `terminal-${idx}`,
            state: 'failed',
            failed_at: '2026-05-22T10:05:00.000Z',
            failure_reason: reasons[i],
          });
        }).not.toThrow();
      }
      db.close();
    });

    it('rejects a started attempt that carries a failure_reason (state-coupling CHECK)', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, { state: 'started', failure_reason: 'tender_underpaid' });
      }).toThrow();
      db.close();
    });

    it('rejects a failed attempt without a failure_reason (state-coupling CHECK)', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, {
          state: 'failed',
          failed_at: '2026-05-22T10:05:00.000Z',
          failure_reason: null,
        });
      }).toThrow();
      db.close();
    });

    it('rejects a force_failed attempt without manager attribution (state-coupling CHECK)', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, {
          state: 'force_failed',
          force_failed_at: '2026-05-22T10:06:00.000Z',
          failure_reason: 'internal_error',
          force_fail_attribution_operator_id: null,
        });
      }).toThrow();
      db.close();
    });

    it('rejects a non-force_failed attempt that carries a force_fail_attribution_operator_id', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, { force_fail_attribution_operator_id: 'mgr-x' });
      }).toThrow();
      db.close();
    });

    it('accepts a force_failed attempt with reason + manager attribution', () => {
      const db = freshDb();
      expect(() => {
        insertAttempt(db, {
          state: 'force_failed',
          force_failed_at: '2026-05-22T10:06:00.000Z',
          failure_reason: 'internal_error',
          force_fail_attribution_operator_id: 'mgr-xyz',
        });
      }).not.toThrow();
      db.close();
    });
  });

  describe('partial unique index — one started per terminal (R-6)', () => {
    it('refuses two started attempts on the same terminal', () => {
      const db = freshDb();
      insertAttempt(db, { payment_attempt_id: 'a-1' });
      expect(() => {
        insertAttempt(db, { payment_attempt_id: 'a-2' });
      }).toThrow();
      db.close();
    });

    it('allows a second started attempt on a different terminal', () => {
      const db = freshDb();
      insertAttempt(db, { payment_attempt_id: 'a-1', terminal_id: 'terminal-A' });
      expect(() => {
        insertAttempt(db, { payment_attempt_id: 'a-2', terminal_id: 'terminal-B' });
      }).not.toThrow();
      db.close();
    });

    it('allows a new started attempt on a terminal whose prior attempt is settled', () => {
      const db = freshDb();
      insertAttempt(db, { payment_attempt_id: 'a-1' });
      db.run(
        `UPDATE payment_attempts
            SET state='settled', settled_at='2026-05-22T10:03:00.000Z'
          WHERE payment_attempt_id='a-1'`,
      );
      expect(() => {
        insertAttempt(db, { payment_attempt_id: 'a-2' });
      }).not.toThrow();
      db.close();
    });
  });

  describe('payment_tender_lines — FK + CHECK constraints', () => {
    it('inserts a cash line that exactly settles the attempt', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db);
      }).not.toThrow();
      db.close();
    });

    it('rejects a line whose payment_attempt_id does not exist (FK)', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, { payment_attempt_id: 'nope' });
      }).toThrow();
      db.close();
    });

    it('rejects a non-cash line with a non-null change_due_minor', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'external_card_terminal',
          change_due_minor: 100,
        });
      }).toThrow();
      db.close();
    });

    it('rejects external_reference on a non-external_card_terminal line', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'cash',
          external_reference: 'ABC123',
        });
      }).toThrow();
      db.close();
    });

    it('rejects external_reference values that fail the regex CHECK', () => {
      const db = freshDb();
      insertAttempt(db);
      // Lowercase, > 6 chars: each independently invalid.
      expect(() => {
        insertLine(db, {
          tender_type: 'external_card_terminal',
          external_reference: 'abc',
        });
      }).toThrow();
      expect(() => {
        insertLine(db, {
          tender_line_id: 'line-2',
          tender_type: 'external_card_terminal',
          external_reference: 'ABCDEFG',
        });
      }).toThrow();
      db.close();
    });

    it('accepts a valid external_card_terminal line with a 6-char reference', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'external_card_terminal',
          external_reference: 'AB12XY',
        });
      }).not.toThrow();
      db.close();
    });

    // Each value is between 1 and 6 chars (within the length BETWEEN leg) and
    // contains at least one character outside [A-Z0-9]. The test therefore
    // exercises the char-class clause unambiguously; the length leg is
    // satisfied for every input. Includes lowercase ('abc12X'), embedded space
    // ('AB CD'), tab ('AB\tCD'), control char (DEL=0x7F), punctuation, and
    // common shell chars to cover the breadth of the negative-glob.
    it.each(['AB!2', 'A___', 'A-1', 'A 1', 'A.B', 'abc12X', 'AB\tCD', 'ABCD'])(
      'rejects external_reference %j (non A-Z/0-9 char anywhere in the string)',
      (value) => {
        const db = freshDb();
        insertAttempt(db);
        expect(() => {
          insertLine(db, {
            tender_type: 'external_card_terminal',
            external_reference: value,
          });
        }).toThrow();
        db.close();
      },
    );

    it('rejects change_due_minor that exceeds amount_applied_minor', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'cash',
          amount_applied_minor: 1000,
          change_due_minor: 1001,
        });
      }).toThrow();
      db.close();
    });

    it('accepts change_due_minor equal to amount_applied_minor (zero net contribution)', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'cash',
          amount_applied_minor: 1500,
          change_due_minor: 1500,
        });
      }).not.toThrow();
      db.close();
    });

    it('rejects voucher fields on a non-voucher line', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, {
          tender_type: 'cash',
          voucher_redemption_intent_token: 'tok-x',
        });
      }).toThrow();
      expect(() => {
        insertLine(db, {
          tender_line_id: 'line-2',
          tender_type: 'cash',
          voucher_authority_redemption_id: 'red-x',
        });
      }).toThrow();
      db.close();
    });

    it('rejects an unknown tender_type', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, { tender_type: 'crypto' });
      }).toThrow();
      db.close();
    });

    it('rejects an unknown line state', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, { state: 'pending' });
      }).toThrow();
      db.close();
    });

    it('rejects negative amount_applied_minor', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertLine(db, { amount_applied_minor: -1 });
      }).toThrow();
      db.close();
    });
  });

  describe('payment_action_outbox — FKs + append-only trigger', () => {
    it('inserts an outbox row tied to an attempt', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertOutbox(db);
      }).not.toThrow();
      db.close();
    });

    it('inserts an outbox row tied to a tender line', () => {
      const db = freshDb();
      insertAttempt(db);
      insertLine(db);
      expect(() => {
        insertOutbox(db, {
          action_id: 'action-2',
          tender_line_id: 'line-1',
          action_kind: 'tender.apply',
        });
      }).not.toThrow();
      db.close();
    });

    it('rejects an outbox row whose payment_attempt_id does not exist (FK)', () => {
      const db = freshDb();
      expect(() => {
        insertOutbox(db);
      }).toThrow();
      db.close();
    });

    it('rejects an unknown action_kind', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertOutbox(db, { action_kind: 'mystery' });
      }).toThrow();
      db.close();
    });

    it('rejects a duplicate action_id', () => {
      const db = freshDb();
      insertAttempt(db);
      insertOutbox(db);
      expect(() => {
        insertOutbox(db, { action_kind: 'payment.confirm' });
      }).toThrow();
      db.close();
    });

    it('denies UPDATE on outbox rows (append-only)', () => {
      const db = freshDb();
      insertAttempt(db);
      insertOutbox(db);
      expect(() =>
        db.run(
          `UPDATE payment_action_outbox SET action_kind='payment.confirm' WHERE action_id='action-1'`,
        ),
      ).toThrow();
      db.close();
    });

    it('denies DELETE on outbox rows (append-only)', () => {
      const db = freshDb();
      insertAttempt(db);
      insertOutbox(db);
      expect(() =>
        db.run(`DELETE FROM payment_action_outbox WHERE action_id='action-1'`),
      ).toThrow();
      db.close();
    });

    it.each(['tender.apply', 'tender.reverse'])(
      'rejects %s outbox row when tender_line_id is NULL (biconditional CHECK)',
      (kind) => {
        const db = freshDb();
        insertAttempt(db);
        insertLine(db);
        expect(() => {
          insertOutbox(db, { action_kind: kind, tender_line_id: null });
        }).toThrow();
        db.close();
      },
    );

    it.each([
      'payment.attempt.start',
      'payment.confirm',
      'payment.cancel',
      'payment.fail',
      'payment.force_fail',
      'payment.discarded_on_session_end',
    ])(
      'rejects attempt-level %s outbox row when tender_line_id is non-NULL (biconditional CHECK)',
      (kind) => {
        const db = freshDb();
        insertAttempt(db);
        insertLine(db);
        expect(() => {
          insertOutbox(db, { action_kind: kind, tender_line_id: 'line-1' });
        }).toThrow();
        db.close();
      },
    );

    it('rejects action_payload_hash containing non-hex characters', () => {
      const db = freshDb();
      insertAttempt(db);
      // Same length (64), with a truly out-of-hex char ('g' — first letter
      // past 'f') so the test exercises the char-class clause unambiguously
      // rather than relying on the lowercase-only design choice.
      const nonHex = 'g'.padEnd(64, 'a');
      expect(() => {
        insertOutbox(db, { action_payload_hash: nonHex });
      }).toThrow();
      db.close();
    });

    it('rejects action_payload_hash containing uppercase hex (lowercase-only by design)', () => {
      // Distinct from the previous test: this asserts the deliberate
      // lowercase-only design choice (matches createHash().digest('hex')
      // output exactly). 'A' is a hex digit semantically, but our CHECK
      // accepts only [0-9a-f].
      const db = freshDb();
      insertAttempt(db);
      const uppercaseHex = 'A'.padEnd(64, 'b');
      expect(() => {
        insertOutbox(db, { action_payload_hash: uppercaseHex });
      }).toThrow();
      db.close();
    });

    it('rejects action_payload_hash whose length is not exactly 64', () => {
      const db = freshDb();
      insertAttempt(db);
      expect(() => {
        insertOutbox(db, { action_payload_hash: 'a'.repeat(63) });
      }).toThrow();
      db.close();
    });
  });

  describe('audit_events — new action_category values', () => {
    const newCategories = [
      'payment.settled',
      'payment.cancelled',
      'payment.failed',
      'payment.force_failed',
      'tender.applied',
      'tender.refused',
      'tender.reversed',
      // T204 — ratified by migrations/0018_audit_event_tender_reversal_pending.sql.
      'tender.reversal_pending',
    ];

    it.each(newCategories)('accepts an audit_event with action_category=%s', (category) => {
      const db = freshDb();
      expect(() =>
        db.run(
          `INSERT INTO audit_events
               (event_id, tenant_id, branch_id, originating_terminal_id,
                acting_operator_id, action_category, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `evt-${category}`,
            'tenant-1',
            'branch-1',
            'terminal-1',
            'op-abc',
            category,
            '2026-05-22T10:00:00.000Z',
          ],
        ),
      ).not.toThrow();
      db.close();
    });
  });

  // ── T299 — Wave 5e migration 0019 against a POPULATED database ──────────
  //
  // Regression for the CR-1 bug Wave 5e's first push shipped: the table-
  // rebuild migration MUST work when `payment_attempts` already has rows
  // AND the child tables (`payment_tender_lines`, `payment_action_outbox`)
  // have rows referencing them, AND `PRAGMA foreign_keys = ON`. That is
  // the production scenario — every install after Slice 3 has data.
  //
  // The first push asserted safety on a chain of reasoning that turned
  // out to be empirically wrong (DROP TABLE raises FOREIGN KEY violation
  // even when INSERT…SELECT has copied every parent row first). Caught
  // by CodeRabbit; tests added below pin the corrected migration so the
  // regression cannot recur.
  describe('migration 0019 — table rebuild against populated payment_attempts', () => {
    // freshDb() applies all migrations through 0019 in sequence; but it
    // does so against an empty database, so the first push passed against
    // it. To pin CR-1 we need to (a) apply migrations 0001-0018, (b)
    // INSERT real rows into payment_attempts + child tables, then (c)
    // apply 0019 last and observe the result. SQLite's runtime migration
    // ordering precludes that interleave at the file level, so we simulate
    // by reading 0019 alone and re-applying it against a snapshot built
    // with prior migrations + seeded data.

    function dbWithSeededData(): SqlJsDatabase {
      const db = new SQL.Database();
      db.exec('PRAGMA foreign_keys = ON;');
      // Apply every migration EXCEPT 0019, so the parent table still has
      // the original (14-value) CHECK enum.
      for (const name of PREREQ_MIGRATIONS) db.exec(loadSql(name));
      for (const name of S3A_MIGRATIONS) {
        if (name === '0019_extend_payment_failure_reason_enum.sql') continue;
        db.exec(loadSql(name));
      }
      // Seed: one started attempt + one applied cash tender line + one
      // outbox row. Mirrors the minimal production shape after a fresh
      // payments.start + tender.apply.
      insertAttempt(db, {
        payment_attempt_id: 'pa-seed',
        terminal_id: 'terminal-seed',
        state: 'started',
        envelope_subtotal_minor: 1500,
      });
      insertLine(db, {
        tender_line_id: 'tl-seed',
        payment_attempt_id: 'pa-seed',
        tender_type: 'cash',
        amount_applied_minor: 1500,
        state: 'applied',
      });
      insertOutbox(db, {
        action_id: 'start-pa-seed',
        payment_attempt_id: 'pa-seed',
        action_kind: 'payment.attempt.start',
      });
      return db;
    }

    it('applies cleanly against a payment_attempts table with rows + child FK references', () => {
      const db = dbWithSeededData();
      expect(() => {
        db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      }).not.toThrow();
      db.close();
    });

    it('preserves every payment_attempts row across the rebuild', () => {
      const db = dbWithSeededData();
      db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      const result = db.exec(
        "SELECT payment_attempt_id, state, envelope_subtotal_minor FROM payment_attempts WHERE payment_attempt_id = 'pa-seed'",
      );
      expect(result[0]?.values).toHaveLength(1);
      expect(result[0]?.values[0]?.[0]).toBe('pa-seed');
      expect(result[0]?.values[0]?.[1]).toBe('started');
      expect(result[0]?.values[0]?.[2]).toBe(1500);
      db.close();
    });

    it('preserves child FK linkage — payment_tender_lines row still resolves its parent', () => {
      const db = dbWithSeededData();
      db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      const joined = db.exec(
        `SELECT a.payment_attempt_id, l.tender_line_id, l.state
         FROM payment_tender_lines l
         JOIN payment_attempts a ON a.payment_attempt_id = l.payment_attempt_id
         WHERE l.tender_line_id = 'tl-seed'`,
      );
      expect(joined[0]?.values).toHaveLength(1);
      expect(joined[0]?.values[0]?.[0]).toBe('pa-seed');
      expect(joined[0]?.values[0]?.[1]).toBe('tl-seed');
      expect(joined[0]?.values[0]?.[2]).toBe('applied');
      db.close();
    });

    it('preserves child FK linkage — payment_action_outbox row still resolves its parent', () => {
      const db = dbWithSeededData();
      db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      const joined = db.exec(
        `SELECT a.payment_attempt_id, o.action_id, o.action_kind
         FROM payment_action_outbox o
         JOIN payment_attempts a ON a.payment_attempt_id = o.payment_attempt_id
         WHERE o.action_id = 'start-pa-seed'`,
      );
      expect(joined[0]?.values).toHaveLength(1);
      db.close();
    });

    it('restores PRAGMA foreign_keys = ON after the rebuild completes', () => {
      // CR-1 root cause was that the rebuild needs FK=OFF mid-flight, but
      // FK enforcement MUST be re-enabled before the migration returns;
      // otherwise the FK-protected operations of any subsequent migration
      // (or the running app) silently lose their guard.
      const db = dbWithSeededData();
      db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      const pragma = db.exec('PRAGMA foreign_keys');
      expect(pragma[0]?.values[0]?.[0]).toBe(1);
      db.close();
    });

    it('the rebuilt table accepts the new manager_force_failed value', () => {
      const db = dbWithSeededData();
      db.exec(loadSql('0019_extend_payment_failure_reason_enum.sql'));
      // Insert directly via SQL to bypass the helper's state-coupling check
      // path; use state='force_failed' to satisfy the row-level invariants.
      expect(() => {
        db.run(
          `INSERT INTO payment_attempts
             (payment_attempt_id, tenant_id, branch_id, terminal_id,
              acting_operator_id, operator_session_id,
              envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
              state, started_at, force_failed_at,
              failure_reason, force_fail_attribution_operator_id, last_action_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'pa-mff',
            'tenant-1',
            'branch-1',
            'terminal-mff',
            'op-cashier',
            'sess-cashier',
            'handoff-mff',
            'cart-mff',
            1000,
            'force_failed',
            '2026-05-25T11:00:00.000Z',
            '2026-05-25T11:45:30.000Z',
            'manager_force_failed',
            'op-manager',
            'ff-pa-mff',
          ],
        );
      }).not.toThrow();
      db.close();
    });
  });
});
