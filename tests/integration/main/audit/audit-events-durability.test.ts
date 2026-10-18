import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditSync } from '../../../../src/main/audit/audit-sync.js';
import type { AuditSyncStore, AuditSyncClient } from '../../../../src/main/audit/audit-sync.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';

/**
 * T042 — crash/restart durability (S3 integration).
 *
 * Verifies: an audit event written to `audit_events` before a simulated
 * crash is still present in the unsynced outbox after "restart" (new
 * sql.js Database hydrated from the serialised bytes), and is successfully
 * synced on the next flush().
 *
 * No filesystem I/O required: sql.js `db.export()` models the WAL being
 * flushed to disk; `new SQL.Database(bytes)` models a fresh process opening
 * the same file.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0004_audit_events.sql'),
  'utf8',
);

// ─── Module-level sql.js engine ──────────────────────────────────────────────

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

// ─── Test-local SQL-backed AuditSyncStore ────────────────────────────────────

function bindTestSyncStore(db: SqlJsDatabase): AuditSyncStore {
  return {
    listUnsynced(limit: number): AuditEvent[] {
      const stmt = db.prepare(`
        SELECT ae.*
        FROM audit_events ae
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events_sync_state ss
          WHERE ss.tenant_id = ae.tenant_id
            AND ss.event_id  = ae.event_id
        )
        ORDER BY ae.created_at
        LIMIT ?
      `);
      const rows: AuditEvent[] = [];
      stmt.bind([limit]);
      while (stmt.step()) {
        const r = stmt.getAsObject() as Record<string, unknown>;
        rows.push({
          event_id: r['event_id'] as string,
          tenant_id: r['tenant_id'] as string,
          branch_id: r['branch_id'] as string,
          originating_terminal_id: r['originating_terminal_id'] as string,
          acting_operator_id: r['acting_operator_id'] as string,
          session_id: (r['session_id'] as string | null | undefined) ?? null,
          shift_id: (r['shift_id'] as string | null | undefined) ?? null,
          action_category: r['action_category'] as string,
          created_at: r['created_at'] as string,
          approving_supervisor_id:
            (r['approving_supervisor_id'] as string | null | undefined) ?? null,
          payload:
            typeof r['payload'] === 'string'
              ? (JSON.parse(r['payload']) as Record<string, unknown>)
              : {},
        });
      }
      stmt.free();
      return rows;
    },

    markSynced(tenant_id: string, event_id: string, synced_at: string): void {
      db.run(
        `INSERT OR REPLACE INTO audit_events_sync_state
           (tenant_id, event_id, synced_at)
         VALUES (?, ?, ?)`,
        [tenant_id, event_id, synced_at],
      );
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedEvent(db: SqlJsDatabase, event: AuditEvent): void {
  db.run(
    `INSERT INTO audit_events
       (event_id, tenant_id, branch_id, originating_terminal_id,
        acting_operator_id, session_id, shift_id, action_category,
        created_at, approving_supervisor_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.event_id,
      event.tenant_id,
      event.branch_id,
      event.originating_terminal_id,
      event.acting_operator_id,
      event.session_id,
      event.shift_id,
      event.action_category,
      event.created_at,
      event.approving_supervisor_id,
      JSON.stringify(event.payload),
    ],
  );
}

const SAMPLE_EVENT: AuditEvent = {
  event_id: 'evt-durability-1',
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

function makeAcceptingClient(eventIds: string[]): AuditSyncClient {
  return {
    sendBatch(): Promise<{ accepted: string[]; duplicates: string[]; rejected: [] }> {
      return Promise.resolve({ accepted: eventIds, duplicates: [], rejected: [] });
    },
  };
}

// ─── T042 tests ───────────────────────────────────────────────────────────────

describe('T042 — crash/restart durability', () => {
  it('event written pre-crash survives serialisation and remains unsynced after restart', () => {
    const preCrashDb = new SQL.Database();
    preCrashDb.run(MIGRATION_SQL);
    seedEvent(preCrashDb, SAMPLE_EVENT);

    const bytes = preCrashDb.export();
    preCrashDb.close();

    const postRestartDb = new SQL.Database(bytes);
    const store = bindTestSyncStore(postRestartDb);

    const unsynced = store.listUnsynced(100);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0]?.event_id).toBe('evt-durability-1');

    postRestartDb.close();
  });

  it('event is successfully synced on the flush() call after restart', async () => {
    const preCrashDb = new SQL.Database();
    preCrashDb.run(MIGRATION_SQL);
    seedEvent(preCrashDb, SAMPLE_EVENT);
    const bytes = preCrashDb.export();
    preCrashDb.close();

    const postRestartDb = new SQL.Database(bytes);
    const store = bindTestSyncStore(postRestartDb);
    const client = makeAcceptingClient([SAMPLE_EVENT.event_id]);
    const sync = new AuditSync({ store, client });

    await sync.flush();

    expect(store.listUnsynced(100)).toHaveLength(0);
    postRestartDb.close();
  });

  it('multiple events written pre-crash all survive restart', () => {
    const events: AuditEvent[] = ([1, 2, 3] as const).map((n) => ({
      ...SAMPLE_EVENT,
      event_id: `evt-durability-${String(n)}`,
      created_at: `2026-05-07T08:0${String(n)}:00.000Z`,
    }));

    const preCrashDb = new SQL.Database();
    preCrashDb.run(MIGRATION_SQL);
    for (const ev of events) seedEvent(preCrashDb, ev);

    const bytes = preCrashDb.export();
    preCrashDb.close();

    const postRestartDb = new SQL.Database(bytes);
    const store = bindTestSyncStore(postRestartDb);
    expect(store.listUnsynced(100)).toHaveLength(3);

    postRestartDb.close();
  });

  it('event already synced pre-crash does not re-appear after restart', () => {
    const preCrashDb = new SQL.Database();
    preCrashDb.run(MIGRATION_SQL);
    seedEvent(preCrashDb, SAMPLE_EVENT);
    preCrashDb.run(
      `INSERT INTO audit_events_sync_state (tenant_id, event_id, synced_at)
       VALUES (?, ?, ?)`,
      [SAMPLE_EVENT.tenant_id, SAMPLE_EVENT.event_id, '2026-05-07T08:01:00.000Z'],
    );

    const bytes = preCrashDb.export();
    preCrashDb.close();

    const postRestartDb = new SQL.Database(bytes);
    const store = bindTestSyncStore(postRestartDb);
    expect(store.listUnsynced(100)).toHaveLength(0);

    postRestartDb.close();
  });

  it('payload is faithfully round-tripped through serialisation', () => {
    const richPayload = {
      shift_id: 'shift-1',
      items: [{ sku: 'ABC', qty: 2 }],
      notes: 'special handling',
    };
    const event: AuditEvent = { ...SAMPLE_EVENT, payload: richPayload };

    const preCrashDb = new SQL.Database();
    preCrashDb.run(MIGRATION_SQL);
    seedEvent(preCrashDb, event);
    const bytes = preCrashDb.export();
    preCrashDb.close();

    const postRestartDb = new SQL.Database(bytes);
    const store = bindTestSyncStore(postRestartDb);
    const [retrieved] = store.listUnsynced(1);
    expect(retrieved?.payload).toEqual(richPayload);

    postRestartDb.close();
  });
});
