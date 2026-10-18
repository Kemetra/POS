import { describe, expect, it, beforeAll, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditSync } from '../../../../src/main/audit/audit-sync.js';
import type {
  AuditSyncStore,
  AuditSyncClient,
  AuditSyncBatchResponse,
} from '../../../../src/main/audit/audit-sync.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';

/**
 * T043 — network-failure path + retry + dedup (S3 integration).
 *
 * Verifies:
 *   1. A network_error keeps all events in the unsynced outbox.
 *   2. After reconnection the retry flush() syncs the events.
 *   3. A backend duplicate response (event already known) marks the
 *      event synced — the outbox is not permanently polluted (P5).
 *   4. Multiple flush() calls are safe (idempotency end-to-end).
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

const BASE_EVENT: AuditEvent = {
  event_id: 'evt-sync-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  originating_terminal_id: 'terminal-001',
  acting_operator_id: 'op-xyz',
  session_id: 'sess-abc',
  shift_id: 'shift-1',
  action_category: 'shift.open',
  created_at: '2026-05-07T08:00:00.000Z',
  approving_supervisor_id: null,
  payload: { shift_id: 'shift-1' },
};

// ─── T043 tests ───────────────────────────────────────────────────────────────

describe('T043 — network-failure path, retry, and dedup', () => {
  it('network_error keeps the event in the unsynced outbox', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const client: AuditSyncClient = {
      sendBatch(): Promise<'network_error'> {
        return Promise.resolve('network_error');
      },
    };
    const sync = new AuditSync({ store, client });

    await sync.flush();

    expect(store.listUnsynced(100)).toHaveLength(1);
    db.close();
  });

  it('retry after network_error syncs the event when the backend becomes reachable', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const sendBatch = vi
      .fn<() => Promise<AuditSyncBatchResponse | 'network_error'>>()
      .mockResolvedValueOnce('network_error')
      .mockResolvedValueOnce({
        accepted: [BASE_EVENT.event_id],
        duplicates: [],
        rejected: [],
      });
    const client: AuditSyncClient = { sendBatch };
    const sync = new AuditSync({ store, client });

    await sync.flush();
    expect(store.listUnsynced(100)).toHaveLength(1);

    await sync.flush();
    expect(store.listUnsynced(100)).toHaveLength(0);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('backend duplicate response marks the event synced (P5 — silent dedup)', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const response: AuditSyncBatchResponse = {
      accepted: [],
      duplicates: [BASE_EVENT.event_id],
      rejected: [],
    };
    const client: AuditSyncClient = {
      sendBatch(): Promise<AuditSyncBatchResponse> {
        return Promise.resolve(response);
      },
    };
    const sync = new AuditSync({ store, client });

    await sync.flush();

    expect(store.listUnsynced(100)).toHaveLength(0);
    db.close();
  });

  it('rejected event stays in the outbox and is retried on the next flush', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const sendBatch = vi
      .fn<() => Promise<AuditSyncBatchResponse | 'network_error'>>()
      .mockResolvedValueOnce({
        accepted: [],
        duplicates: [],
        rejected: [{ event_id: BASE_EVENT.event_id, category: 'invalid_input' }],
      })
      .mockResolvedValueOnce({
        accepted: [BASE_EVENT.event_id],
        duplicates: [],
        rejected: [],
      });
    const client: AuditSyncClient = { sendBatch };
    const sync = new AuditSync({ store, client });

    await sync.flush();
    expect(store.listUnsynced(100)).toHaveLength(1);

    await sync.flush();
    expect(store.listUnsynced(100)).toHaveLength(0);

    db.close();
  });

  it('flush() is idempotent — calling it twice when outbox is empty is a no-op', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const sendBatch = vi.fn<() => Promise<AuditSyncBatchResponse>>().mockResolvedValue({
      accepted: [BASE_EVENT.event_id],
      duplicates: [],
      rejected: [],
    });
    const client: AuditSyncClient = { sendBatch };
    const sync = new AuditSync({ store, client });

    await sync.flush();
    await sync.flush();

    expect(sendBatch).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('multi-event batch: network_error keeps ALL events in the outbox', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    const events: AuditEvent[] = ([1, 2, 3] as const).map((n) => ({
      ...BASE_EVENT,
      event_id: `evt-sync-multi-${String(n)}`,
      created_at: `2026-05-07T08:0${String(n)}:00.000Z`,
    }));
    for (const ev of events) seedEvent(db, ev);

    const store = bindTestSyncStore(db);
    const client: AuditSyncClient = {
      sendBatch(): Promise<'network_error'> {
        return Promise.resolve('network_error');
      },
    };
    const sync = new AuditSync({ store, client });

    await sync.flush();

    expect(store.listUnsynced(100)).toHaveLength(3);
    db.close();
  });

  it('multi-event batch: partial acceptance leaves only non-accepted events in the outbox', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    const events: AuditEvent[] = ([1, 2] as const).map((n) => ({
      ...BASE_EVENT,
      event_id: `evt-sync-partial-${String(n)}`,
      created_at: `2026-05-07T08:0${String(n)}:00.000Z`,
    }));
    for (const ev of events) seedEvent(db, ev);

    const store = bindTestSyncStore(db);
    const client: AuditSyncClient = {
      sendBatch(): Promise<AuditSyncBatchResponse> {
        return Promise.resolve({
          accepted: ['evt-sync-partial-1'],
          duplicates: [],
          rejected: [{ event_id: 'evt-sync-partial-2', category: 'invalid_input' }],
        });
      },
    };
    const sync = new AuditSync({ store, client });

    await sync.flush();

    const remaining = store.listUnsynced(100);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.event_id).toBe('evt-sync-partial-2');
    db.close();
  });

  it('markSynced is idempotent via INSERT OR REPLACE — double-marking does not throw', () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seedEvent(db, BASE_EVENT);

    const store = bindTestSyncStore(db);
    const synced_at = '2026-05-07T09:00:00.000Z';

    expect(() => {
      store.markSynced(BASE_EVENT.tenant_id, BASE_EVENT.event_id, synced_at);
      store.markSynced(BASE_EVENT.tenant_id, BASE_EVENT.event_id, synced_at);
    }).not.toThrow();

    expect(store.listUnsynced(100)).toHaveLength(0);
    db.close();
  });
});
