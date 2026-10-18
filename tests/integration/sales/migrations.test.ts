import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T027 — 008 Slice 1a migrations integration test.
 *
 * Applies the seven 008 Slice 1a migrations on top of the prior 005 / 006
 * stack, then asserts:
 *   • All five new tables exist (`sales`, `print_events`, `drawer_events`,
 *     `sale_sync_outbox`, `sale_number_sequences`) with the expected columns.
 *   • UNIQUE constraints + indices per data-model.md §"Indices (plan-pinned)".
 *   • Append-only triggers on the four append-only tables (`sales`,
 *     `print_events`, `drawer_events`, `sale_sync_outbox`) deny UPDATE + DELETE.
 *   • `sale_number_sequences` is intentionally NOT append-only — UPDATE is
 *     allowed (it's the AD-7 allocator counter; UPSERT-and-increment is
 *     the only legal mutation, but the schema layer permits all UPDATEs;
 *     the application layer enforces the increment-only discipline).
 *   • `audit_events.action_category` accepts the 10 new 008 categories. The
 *     base 004 schema declares the column as open-set TEXT (no CHECK), so
 *     the 008 extension is documentation-only (mirrors the pattern in
 *     migration 0017 for 006's 7 new categories).
 *
 * Mirrors `tests/integration/payments/migrations.test.ts` (006 Slice 3a).
 * Uses sql.js (pure-JS SQLite) so the native better-sqlite3 binding is not
 * required at test time.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

// All migrations applied before 008 — the 005 + 006 stack.
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
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
];

// 008 Slice 1a migrations (T020 → T026).
const S1A_MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  '0026_extend_audit_event_categories.sql',
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
  // Production opens DBs with foreign_keys = ON; mirror that here.
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of PREREQ_MIGRATIONS) db.exec(loadSql(name));
  for (const name of S1A_MIGRATIONS) db.exec(loadSql(name));
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

// Minimal Sale row for INSERT testing. Mirrors data-model.md §"Entity: Sale".
function insertSale(
  db: SqlJsDatabase,
  overrides: Partial<{
    sale_id: string;
    sale_number: string;
    receipt_number: string;
    envelope_handoff_action_id: string;
    payment_attempt_id: string;
    envelope_cart_id: string;
    tenant_id: string;
    branch_id: string;
    terminal_id: string;
    terminal_label: string;
    selling_operator_id: string;
    selling_operator_display_name: string;
    selling_operator_session_id: string;
    subtotal_minor: number;
    total_tax_minor: number;
    total_change_due_minor: number;
    tender_lines_summary_json: string;
    settled_at: string;
    finalized_at: string;
    tenant_tax_registration_id: string;
    branch_name: string;
    branch_address: string;
    local_calendar_day: string;
  }> = {},
): void {
  const row = {
    sale_id: 'sale-1',
    sale_number: 'TERM-01-2026-05-27-000001',
    receipt_number: 'TERM-01-2026-05-27-000001',
    envelope_handoff_action_id: 'handoff-1',
    payment_attempt_id: 'attempt-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'TERM-01',
    selling_operator_id: 'op-abc',
    selling_operator_display_name: 'Mohamed Ahmed',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 19925,
    total_tax_minor: 2450,
    total_change_due_minor: 75,
    tender_lines_summary_json: '[]',
    settled_at: '2026-05-27T08:42:18.000Z',
    finalized_at: '2026-05-27T08:42:18.500Z',
    tenant_tax_registration_id: '100123456789012',
    branch_name: 'Al-Rahma Pharmacy',
    branch_address: '10th of Ramadan branch',
    local_calendar_day: '2026-05-27',
    ...overrides,
  };
  db.run(
    `INSERT INTO sales
       (sale_id, sale_number, receipt_number, envelope_handoff_action_id,
        payment_attempt_id, envelope_cart_id, tenant_id, branch_id,
        terminal_id, terminal_label, selling_operator_id,
        selling_operator_display_name, selling_operator_session_id,
        subtotal_minor, total_tax_minor, total_change_due_minor,
        tender_lines_summary_json, settled_at, finalized_at,
        tenant_tax_registration_id, branch_name, branch_address,
        local_calendar_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.sale_id,
      row.sale_number,
      row.receipt_number,
      row.envelope_handoff_action_id,
      row.payment_attempt_id,
      row.envelope_cart_id,
      row.tenant_id,
      row.branch_id,
      row.terminal_id,
      row.terminal_label,
      row.selling_operator_id,
      row.selling_operator_display_name,
      row.selling_operator_session_id,
      row.subtotal_minor,
      row.total_tax_minor,
      row.total_change_due_minor,
      row.tender_lines_summary_json,
      row.settled_at,
      row.finalized_at,
      row.tenant_tax_registration_id,
      row.branch_name,
      row.branch_address,
      row.local_calendar_day,
    ],
  );
}

describe('T027 — 008 Slice 1a migrations', () => {
  describe('schema presence', () => {
    it.each([
      'sales',
      'print_events',
      'drawer_events',
      'sale_sync_outbox',
      'sale_number_sequences',
    ])('creates %s table', (table) => {
      const db = freshDb();
      expect(tableExists(db, table)).toBe(true);
      db.close();
    });

    it('sales has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'sales');
      for (const expected of [
        'sale_id',
        'sale_number',
        'receipt_number',
        'envelope_handoff_action_id',
        'payment_attempt_id',
        'envelope_cart_id',
        'tenant_id',
        'branch_id',
        'terminal_id',
        'terminal_label',
        'selling_operator_id',
        'selling_operator_display_name',
        'selling_operator_session_id',
        'subtotal_minor',
        'total_tax_minor',
        'total_change_due_minor',
        'tender_lines_summary_json',
        'settled_at',
        'finalized_at',
        'tenant_tax_registration_id',
        'branch_name',
        'branch_address',
        'local_calendar_day',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('print_events has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'print_events');
      for (const expected of [
        'print_event_id',
        'sale_id',
        'outcome',
        'purpose',
        'render_path',
        'acting_operator_id',
        'acting_operator_session_id',
        'duplicate_copy_sequence_number',
        'failure_reason',
        'previous_failed_print_event_ids',
        'printed_at',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('drawer_events has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'drawer_events');
      for (const expected of [
        'drawer_event_id',
        'sale_id',
        'outcome',
        'suppression_reason',
        'failure_reason',
        'last_successful_open_at_for_terminal',
        'triggering_print_event_id',
        'terminal_id',
        'attempted_at',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('sale_sync_outbox has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'sale_sync_outbox');
      for (const expected of [
        'outbox_row_id',
        'sale_id',
        'envelope_handoff_action_id',
        'tenant_id',
        'branch_id',
        'terminal_id',
        'state',
        'enqueued_at',
      ]) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('sale_number_sequences has the expected columns', () => {
      const db = freshDb();
      const cols = columns(db, 'sale_number_sequences');
      for (const expected of ['terminal_id', 'calendar_day_local', 'next_sequence', 'updated_at']) {
        expect(cols.has(expected)).toBe(true);
      }
      db.close();
    });

    it('declared indices exist', () => {
      const db = freshDb();
      // sales
      expect(indexExists(db, 'idx_sales_envelope_handoff_action_id')).toBe(true);
      expect(indexExists(db, 'idx_sales_terminal_sale_number')).toBe(true);
      expect(indexExists(db, 'idx_sales_tenant_branch_terminal')).toBe(true);
      expect(indexExists(db, 'idx_sales_terminal_local_calendar_day')).toBe(true);
      // print_events
      expect(indexExists(db, 'idx_print_events_sale_id')).toBe(true);
      expect(indexExists(db, 'idx_print_events_sale_purpose_outcome_printed_at')).toBe(true);
      // drawer_events
      expect(indexExists(db, 'idx_drawer_events_sale_id')).toBe(true);
      expect(indexExists(db, 'idx_drawer_events_terminal_attempted_at')).toBe(true);
      // sale_sync_outbox
      expect(indexExists(db, 'idx_sale_sync_outbox_sale_id')).toBe(true);
      expect(indexExists(db, 'idx_sale_sync_outbox_tenant_branch_terminal_state_enqueued')).toBe(
        true,
      );
      db.close();
    });
  });

  describe('sales — happy path + UNIQUE constraints', () => {
    it('inserts a sales row', () => {
      const db = freshDb();
      expect(() => {
        insertSale(db);
      }).not.toThrow();
      db.close();
    });

    it('refuses duplicate envelope_handoff_action_id (AD-2 idempotency)', () => {
      const db = freshDb();
      insertSale(db, { sale_id: 's-1', envelope_handoff_action_id: 'h-dup' });
      expect(() => {
        insertSale(db, { sale_id: 's-2', envelope_handoff_action_id: 'h-dup' });
      }).toThrow();
      db.close();
    });

    it('refuses duplicate (terminal_id, sale_number) pair', () => {
      const db = freshDb();
      insertSale(db, {
        sale_id: 's-1',
        envelope_handoff_action_id: 'h-1',
        terminal_id: 't-1',
        sale_number: 'SN-A',
      });
      expect(() => {
        insertSale(db, {
          sale_id: 's-2',
          envelope_handoff_action_id: 'h-2',
          terminal_id: 't-1',
          sale_number: 'SN-A',
        });
      }).toThrow();
      db.close();
    });

    it('allows the same sale_number on a different terminal', () => {
      const db = freshDb();
      insertSale(db, {
        sale_id: 's-1',
        envelope_handoff_action_id: 'h-1',
        terminal_id: 't-A',
        sale_number: 'SN-X',
      });
      expect(() => {
        insertSale(db, {
          sale_id: 's-2',
          envelope_handoff_action_id: 'h-2',
          terminal_id: 't-B',
          sale_number: 'SN-X',
        });
      }).not.toThrow();
      db.close();
    });
  });

  describe('sales — append-only trigger (AD-3)', () => {
    it('denies UPDATE on sales rows', () => {
      const db = freshDb();
      insertSale(db);
      expect(() => {
        db.run("UPDATE sales SET branch_name='renamed' WHERE sale_id='sale-1'");
      }).toThrow();
      db.close();
    });

    it('denies DELETE on sales rows', () => {
      const db = freshDb();
      insertSale(db);
      expect(() => {
        db.run("DELETE FROM sales WHERE sale_id='sale-1'");
      }).toThrow();
      db.close();
    });
  });

  describe('print_events — append-only trigger + FK', () => {
    it('denies UPDATE on print_events rows', () => {
      const db = freshDb();
      insertSale(db);
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      expect(() => {
        // Use a trigger-neutral column so the assertion isolates the
        // append-only trigger behavior — `outcome='failure'` would violate
        // the failure ↔ failure_reason biconditional CHECK and pass the
        // toThrow() expectation even if the trigger were missing.
        db.run("UPDATE print_events SET acting_operator_id='op-def' WHERE print_event_id='pe-1'");
      }).toThrow();
      db.close();
    });

    it('denies DELETE on print_events rows', () => {
      const db = freshDb();
      insertSale(db);
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      expect(() => {
        db.run("DELETE FROM print_events WHERE print_event_id='pe-1'");
      }).toThrow();
      db.close();
    });

    it('refuses print_events INSERT with non-existent sale_id (FK)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO print_events
             (print_event_id, sale_id, outcome, purpose, render_path,
              acting_operator_id, acting_operator_session_id, printed_at)
           VALUES ('pe-1', 'nope', 'success', 'first_print', 'escpos_direct',
                   'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
        );
      }).toThrow();
      db.close();
    });
  });

  describe('drawer_events — append-only trigger + UNIQUE(sale_id) + FK', () => {
    it('denies UPDATE on drawer_events rows', () => {
      const db = freshDb();
      insertSale(db);
      // drawer_events.triggering_print_event_id is NOT NULL; insert the
      // anchoring print_event first.
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      db.run(
        `INSERT INTO drawer_events
           (drawer_event_id, sale_id, outcome, triggering_print_event_id,
            terminal_id, attempted_at)
         VALUES ('de-1', 'sale-1', 'opened', 'pe-1', 'terminal-1', '2026-05-27T08:42:20.000Z')`,
      );
      expect(() => {
        // Trigger-neutral column — `outcome='failed'` would violate the
        // failed ↔ failure_reason biconditional CHECK.
        db.run("UPDATE drawer_events SET terminal_id='terminal-9' WHERE drawer_event_id='de-1'");
      }).toThrow();
      db.close();
    });

    it('denies DELETE on drawer_events rows', () => {
      const db = freshDb();
      insertSale(db);
      // drawer_events.triggering_print_event_id is NOT NULL; insert the
      // anchoring print_event first.
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      db.run(
        `INSERT INTO drawer_events
           (drawer_event_id, sale_id, outcome, triggering_print_event_id,
            terminal_id, attempted_at)
         VALUES ('de-1', 'sale-1', 'opened', 'pe-1', 'terminal-1', '2026-05-27T08:42:20.000Z')`,
      );
      expect(() => {
        db.run("DELETE FROM drawer_events WHERE drawer_event_id='de-1'");
      }).toThrow();
      db.close();
    });

    it('refuses two DrawerEvents on the same sale (FR-053 double-kick suppression)', () => {
      const db = freshDb();
      insertSale(db);
      // drawer_events.triggering_print_event_id is NOT NULL; insert the
      // anchoring print_event first.
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      db.run(
        `INSERT INTO drawer_events
           (drawer_event_id, sale_id, outcome, triggering_print_event_id,
            terminal_id, attempted_at)
         VALUES ('de-1', 'sale-1', 'opened', 'pe-1', 'terminal-1', '2026-05-27T08:42:20.000Z')`,
      );
      expect(() => {
        db.run(
          `INSERT INTO drawer_events
             (drawer_event_id, sale_id, outcome, triggering_print_event_id,
              terminal_id, attempted_at)
           VALUES ('de-2', 'sale-1', 'opened', 'pe-1', 'terminal-1', '2026-05-27T08:42:25.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('refuses drawer_events INSERT with non-existent sale_id (FK)', () => {
      const db = freshDb();
      insertSale(db);
      // Insert an anchoring print_event so the NOT-NULL constraint on
      // triggering_print_event_id is satisfied; the test must fail on the
      // sale_id FK, not on a missing-PrintEvent.
      db.run(
        `INSERT INTO print_events
           (print_event_id, sale_id, outcome, purpose, render_path,
            acting_operator_id, acting_operator_session_id, printed_at)
         VALUES ('pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
                 'op-abc', 'sess-1', '2026-05-27T08:42:19.000Z')`,
      );
      expect(() => {
        db.run(
          `INSERT INTO drawer_events
             (drawer_event_id, sale_id, outcome, triggering_print_event_id,
              terminal_id, attempted_at)
           VALUES ('de-1', 'nope', 'opened', 'pe-1', 'terminal-1', '2026-05-27T08:42:20.000Z')`,
        );
      }).toThrow();
      db.close();
    });
  });

  describe('sale_sync_outbox — append-only trigger + UNIQUE(sale_id) + FK', () => {
    it('denies UPDATE on sale_sync_outbox rows', () => {
      const db = freshDb();
      insertSale(db);
      db.run(
        `INSERT INTO sale_sync_outbox
           (outbox_row_id, sale_id, envelope_handoff_action_id,
            tenant_id, branch_id, terminal_id, state, enqueued_at)
         VALUES ('ob-1', 'sale-1', 'handoff-1', 'tenant-1', 'branch-1',
                 'terminal-1', 'pending', '2026-05-27T08:42:18.500Z')`,
      );
      expect(() => {
        // Trigger-neutral column — `state='sent'` would violate the
        // state='pending' CHECK.
        db.run(
          "UPDATE sale_sync_outbox SET enqueued_at='2026-05-27T08:42:19.000Z' WHERE outbox_row_id='ob-1'",
        );
      }).toThrow();
      db.close();
    });

    it('denies DELETE on sale_sync_outbox rows', () => {
      const db = freshDb();
      insertSale(db);
      db.run(
        `INSERT INTO sale_sync_outbox
           (outbox_row_id, sale_id, envelope_handoff_action_id,
            tenant_id, branch_id, terminal_id, state, enqueued_at)
         VALUES ('ob-1', 'sale-1', 'handoff-1', 'tenant-1', 'branch-1',
                 'terminal-1', 'pending', '2026-05-27T08:42:18.500Z')`,
      );
      expect(() => {
        db.run("DELETE FROM sale_sync_outbox WHERE outbox_row_id='ob-1'");
      }).toThrow();
      db.close();
    });

    it('refuses two outbox rows for the same sale (FR-060)', () => {
      const db = freshDb();
      insertSale(db);
      db.run(
        `INSERT INTO sale_sync_outbox
           (outbox_row_id, sale_id, envelope_handoff_action_id,
            tenant_id, branch_id, terminal_id, state, enqueued_at)
         VALUES ('ob-1', 'sale-1', 'handoff-1', 'tenant-1', 'branch-1',
                 'terminal-1', 'pending', '2026-05-27T08:42:18.500Z')`,
      );
      expect(() => {
        db.run(
          `INSERT INTO sale_sync_outbox
             (outbox_row_id, sale_id, envelope_handoff_action_id,
              tenant_id, branch_id, terminal_id, state, enqueued_at)
           VALUES ('ob-2', 'sale-1', 'handoff-1', 'tenant-1', 'branch-1',
                   'terminal-1', 'pending', '2026-05-27T08:42:19.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('refuses sale_sync_outbox INSERT with non-existent sale_id (FK)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO sale_sync_outbox
             (outbox_row_id, sale_id, envelope_handoff_action_id,
              tenant_id, branch_id, terminal_id, state, enqueued_at)
           VALUES ('ob-1', 'nope', 'handoff-x', 'tenant-1', 'branch-1',
                   'terminal-1', 'pending', '2026-05-27T08:42:18.500Z')`,
        );
      }).toThrow();
      db.close();
    });
  });

  describe('sale_number_sequences — intentionally MUTABLE (the only mutable 008 table)', () => {
    it('allows INSERT', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO sale_number_sequences
             (terminal_id, calendar_day_local, next_sequence, updated_at)
           VALUES ('terminal-1', '2026-05-27', 1, '2026-05-27T08:42:18.000Z')`,
        );
      }).not.toThrow();
      db.close();
    });

    it('allows UPDATE (UPSERT-and-increment is the AD-7 contract)', () => {
      const db = freshDb();
      db.run(
        `INSERT INTO sale_number_sequences
           (terminal_id, calendar_day_local, next_sequence, updated_at)
         VALUES ('terminal-1', '2026-05-27', 1, '2026-05-27T08:42:18.000Z')`,
      );
      expect(() => {
        db.run(
          `UPDATE sale_number_sequences
              SET next_sequence = next_sequence + 1,
                  updated_at = '2026-05-27T08:42:19.000Z'
            WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-27'`,
        );
      }).not.toThrow();
      db.close();
    });

    it('enforces composite primary key (terminal_id, calendar_day_local)', () => {
      const db = freshDb();
      db.run(
        `INSERT INTO sale_number_sequences
           (terminal_id, calendar_day_local, next_sequence, updated_at)
         VALUES ('terminal-1', '2026-05-27', 1, '2026-05-27T08:42:18.000Z')`,
      );
      expect(() => {
        db.run(
          `INSERT INTO sale_number_sequences
             (terminal_id, calendar_day_local, next_sequence, updated_at)
           VALUES ('terminal-1', '2026-05-27', 5, '2026-05-27T08:42:19.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('allows the same calendar_day on a different terminal', () => {
      const db = freshDb();
      db.run(
        `INSERT INTO sale_number_sequences
           (terminal_id, calendar_day_local, next_sequence, updated_at)
         VALUES ('terminal-A', '2026-05-27', 1, '2026-05-27T08:42:18.000Z')`,
      );
      expect(() => {
        db.run(
          `INSERT INTO sale_number_sequences
             (terminal_id, calendar_day_local, next_sequence, updated_at)
           VALUES ('terminal-B', '2026-05-27', 1, '2026-05-27T08:42:18.000Z')`,
        );
      }).not.toThrow();
      db.close();
    });
  });

  describe('audit_events — accepts the 10 new 008 action_category values', () => {
    const newCategories = [
      'sale.finalized',
      'sale.finalization_refused',
      'sale.receipt.printed',
      'sale.receipt.reprinted',
      'sale.receipt.print_failed',
      'sale.receipt.print_retried_success',
      'sale.receipt.manual_override',
      'sale.drawer.opened',
      'sale.drawer.suppressed',
      'sale.drawer.failed',
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
            '2026-05-27T08:42:18.000Z',
          ],
        ),
      ).not.toThrow();
      db.close();
    });
  });
});
