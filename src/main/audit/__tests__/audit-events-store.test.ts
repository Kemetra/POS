import { describe, expect, it, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindAuditEventsStoreDb } from '../audit-events-store.js';
import type { AuditEventsStore } from '../audit-emitter.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';

/**
 * T048 — bindAuditEventsStoreDb unit tests.
 *
 * Uses sql.js (pure-JS WASM SQLite) so we test the real SQL contract
 * without needing the better-sqlite3 native binding (which requires
 * Electron-rebuilt binaries, not loadable in Vitest's Node env).
 *
 * Verifies:
 *   - insertIgnore inserts a row into audit_events.
 *   - Duplicate (event_id, tenant_id) is silently dropped (P5 idempotency).
 *   - payload is serialised to JSON.
 *   - Nullable fields (session_id, shift_id, approving_supervisor_id) persist correctly.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0004_audit_events.sql'),
  'utf8',
);

function makeSqlJsHandle(db: SqlJsDatabase): DatabaseHandle {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]) {
          // sql.js BindParams does not accept undefined; map to null.
          const bound = params.map((p) => (p === undefined ? null : p)) as (
            | string
            | number
            | null
          )[];
          stmt.run(bound);
          // Do NOT free() — the adapter caches and re-uses the statement.
        },
      };
    },
    transaction(fn: () => unknown) {
      return () => fn();
    },
    close() {
      db.close();
    },
  } as unknown as DatabaseHandle;
}

function readAllEvents(db: SqlJsDatabase): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM audit_events');
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

const SAMPLE_EVENT: AuditEvent = {
  event_id: 'evt-001',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  originating_terminal_id: 'terminal-001',
  acting_operator_id: 'op-xyz',
  session_id: 'sess-abc',
  shift_id: 'shift-1',
  action_category: 'shift.open',
  created_at: '2026-05-07T08:00:00.000Z',
  approving_supervisor_id: null,
  payload: { shift_id: 'shift-1', opened_at: '2026-05-07T08:00:00.000Z' },
};

let db: SqlJsDatabase;
let store: AuditEventsStore;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(MIGRATION_SQL);
  const handle = makeSqlJsHandle(db);
  store = bindAuditEventsStoreDb(handle);
});

describe('bindAuditEventsStoreDb — insertIgnore', () => {
  it('inserts an event into audit_events', () => {
    store.insertIgnore(SAMPLE_EVENT);
    const rows = readAllEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['event_id']).toBe('evt-001');
    expect(rows[0]?.['tenant_id']).toBe('tenant-1');
    expect(rows[0]?.['acting_operator_id']).toBe('op-xyz');
    expect(rows[0]?.['action_category']).toBe('shift.open');
  });

  it('serialises payload as JSON string', () => {
    store.insertIgnore(SAMPLE_EVENT);
    const rows = readAllEvents(db);
    expect(rows[0]?.['payload']).toBe(JSON.stringify(SAMPLE_EVENT.payload));
  });

  it('persists nullable fields (session_id, shift_id, approving_supervisor_id)', () => {
    const eventWithNulls: AuditEvent = {
      ...SAMPLE_EVENT,
      event_id: 'evt-002',
      session_id: null,
      shift_id: null,
      approving_supervisor_id: null,
    };
    store.insertIgnore(eventWithNulls);
    const rows = readAllEvents(db);
    const row = rows[0];
    expect(row?.['session_id']).toBeNull();
    expect(row?.['shift_id']).toBeNull();
    expect(row?.['approving_supervisor_id']).toBeNull();
  });

  it('silently ignores duplicate (event_id, tenant_id) — idempotent (P5)', () => {
    store.insertIgnore(SAMPLE_EVENT);
    store.insertIgnore(SAMPLE_EVENT);
    const rows = readAllEvents(db);
    expect(rows).toHaveLength(1);
  });

  it('allows different event_id with same tenant_id', () => {
    store.insertIgnore(SAMPLE_EVENT);
    store.insertIgnore({ ...SAMPLE_EVENT, event_id: 'evt-003' });
    const rows = readAllEvents(db);
    expect(rows).toHaveLength(2);
  });

  it('allows same event_id with different tenant_id', () => {
    store.insertIgnore(SAMPLE_EVENT);
    store.insertIgnore({ ...SAMPLE_EVENT, tenant_id: 'tenant-2' });
    const rows = readAllEvents(db);
    expect(rows).toHaveLength(2);
  });
});
