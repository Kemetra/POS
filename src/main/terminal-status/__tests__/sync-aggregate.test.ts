/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.3, §3.1 `sync`, §5.1 "Sync aggregate") — the
 * sales-only (D-6-4) sync aggregate, read against a seeded SQLite.
 *
 *  - `oldestPendingAt` is the minimum OUTBOX enqueue time over the current
 *    terminal's unsent set (a fresh sale has no `sale_sync_state` row yet).
 *  - `paused` is the drain's live closed-set reason; dead-letter counts include
 *    payload divergences.
 *  - It is a read: every statement it prepares is a SELECT and none is run.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedOutbox,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { SaleSyncPausedReason } from '../../sales-sync/sale-sync-engine.js';
import { createTerminalSyncAggregateReader } from '../sync-aggregate.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
type SqlDb = ReturnType<typeof freshSalesSyncDb>;

function enqueue(
  db: SqlDb,
  saleId: string,
  enqueuedAt: string,
  extra: { terminal_id?: string; tenant_id?: string } = {},
): void {
  seedSale(db, { sale_id: saleId, ...extra });
  seedOutbox(db, { sale_id: saleId, enqueued_at: enqueuedAt, ...extra });
}

function readerFor(
  handle: DatabaseHandle,
  opts: { terminalId?: string | null; paused?: SaleSyncPausedReason | null } = {},
) {
  return createTerminalSyncAggregateReader({
    stateRepo: createSaleSyncStateRepo(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => (opts.terminalId === undefined ? SCOPE.terminalId : opts.terminalId),
    pausedReason: () => opts.paused ?? null,
  });
}

/** A handle that records every prepared SQL and every `run`. */
function recordingHandle(db: SqlDb) {
  const inner = handleFor(db);
  const prepared: string[] = [];
  let runs = 0;
  const handle: DatabaseHandle = {
    ...inner,
    prepare(sql: string): unknown {
      prepared.push(sql);
      const stmt = inner.prepare(sql) as Record<string, (...a: unknown[]) => unknown>;
      return {
        ...stmt,
        run: (...a: unknown[]) => {
          runs += 1;
          return stmt.run?.(...a);
        },
      };
    },
  };
  return { handle, prepared, runs: () => runs };
}

describe('RT-601 sync aggregate', () => {
  it('an empty queue: zero counts, no oldest pending, no last success', async () => {
    const db = freshSalesSyncDb();
    await expect(readerFor(handleFor(db))()).resolves.toEqual({
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: null,
    });
    db.close();
  });

  it('oldestPendingAt is the earliest outbox enqueue time of an unsent sale (no state row needed)', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-b', '2026-10-17T09:00:00.000Z');
    enqueue(db, 'sale-a', '2026-10-17T08:00:00.000Z');
    const result = await readerFor(handleFor(db))();
    expect(result.pending).toBe(2);
    expect(result.oldestPendingAt).toBe('2026-10-17T08:00:00.000Z');
    db.close();
  });

  it('a retried (pending-with-state) sale still counts toward the oldest', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-a', '2026-10-17T07:00:00.000Z');
    enqueue(db, 'sale-b', '2026-10-17T09:00:00.000Z');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.recordTransient({
      saleId: 'sale-a',
      ...SCOPE,
      now: '2026-10-17T10:00:00.000Z',
      nextRetryAt: '2026-10-17T10:05:00.000Z',
      errorCategory: 'no_connection',
    });
    expect((await readerFor(handleFor(db))()).oldestPendingAt).toBe('2026-10-17T07:00:00.000Z');
    db.close();
  });

  it('synced and dead-lettered sales leave the pending set', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-old', '2026-10-17T06:00:00.000Z');
    enqueue(db, 'sale-dead', '2026-10-17T07:00:00.000Z');
    enqueue(db, 'sale-new', '2026-10-17T09:00:00.000Z');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'sale-old', ...SCOPE, now: '2026-10-17T10:00:00.000Z' });
    repo.markDeadLetter({
      saleId: 'sale-dead',
      ...SCOPE,
      now: '2026-10-17T10:01:00.000Z',
      reason: 'payload_divergence',
    });
    expect(await readerFor(handleFor(db))()).toEqual({
      pending: 1,
      heldPreviousPairing: 0,
      deadLetter: 1,
      oldestPendingAt: '2026-10-17T09:00:00.000Z',
      paused: null,
      lastSuccessAt: '2026-10-17T10:00:00.000Z',
    });
    db.close();
  });

  it('a held earlier-pairing sale is counted as held, not as the oldest pending', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-held', '2026-10-17T05:00:00.000Z', { terminal_id: 'term-old' });
    enqueue(db, 'sale-mine', '2026-10-17T09:00:00.000Z');
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({
      pending: 1,
      heldPreviousPairing: 1,
      oldestPendingAt: '2026-10-17T09:00:00.000Z',
    });
    db.close();
  });

  it('with no current terminal nothing is pending, so there is no oldest', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-a', '2026-10-17T08:00:00.000Z');
    const result = await readerFor(handleFor(db), { terminalId: null })();
    expect(result).toMatchObject({ pending: 0, heldPreviousPairing: 1, oldestPendingAt: null });
    db.close();
  });

  it('another tenant’s sales never reach this aggregate', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-x', '2026-10-17T01:00:00.000Z', { tenant_id: 'tenant-2' });
    const result = await readerFor(handleFor(db))();
    expect(result).toMatchObject({ pending: 0, oldestPendingAt: null });
    db.close();
  });

  it('carries the drain’s live paused reason', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-a', '2026-10-17T08:00:00.000Z');
    const result = await readerFor(handleFor(db), { paused: 'no_operator_credential' })();
    expect(result.paused).toBe('no_operator_credential');
    db.close();
  });

  it('carries only the closed set of fields (no ids, no payload-divergence detail)', async () => {
    const db = freshSalesSyncDb();
    const result = await readerFor(handleFor(db))();
    expect(Object.keys(result).sort()).toEqual([
      'deadLetter',
      'heldPreviousPairing',
      'lastSuccessAt',
      'oldestPendingAt',
      'paused',
      'pending',
    ]);
    db.close();
  });

  it('is a read: every prepared statement is a SELECT, and none is run', async () => {
    const db = freshSalesSyncDb();
    enqueue(db, 'sale-a', '2026-10-17T08:00:00.000Z');
    const rec = recordingHandle(db);
    await readerFor(rec.handle)();
    expect(rec.prepared.length).toBeGreaterThan(0);
    for (const sql of rec.prepared) expect(sql.trimStart()).toMatch(/^SELECT\b/i);
    expect(rec.runs()).toBe(0);
    db.close();
  });
});
