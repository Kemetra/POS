/**
 * 011 T020 (RED) — `sale-sync-state-repo`.
 *
 * Contract (data-model.md §"sale_sync_state" + plan AD-1):
 *   • `read(sale_id)` → null before any attempt; the stored row afterwards.
 *   • `markSynced` / `markDeadLetter` / `recordTransient` transition `sync_status`
 *     and bookkeeping; tenant-scoped (a write for tenant A never touches tenant B).
 *   • `eligible(scope, now)` is the DRAIN query: it starts from `sale_sync_outbox`
 *     LEFT JOIN `sale_sync_state` — a freshly-enqueued sale (outbox row, NO state
 *     row) MUST be eligible; a `synced`/`dead_letter` sale MUST NOT be; a `pending`
 *     sale whose `next_retry_at` is in the future MUST NOT be (backoff), but one
 *     whose `next_retry_at` is due (or null) MUST be. FIFO by `enqueued_at`.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

describe('T020 — sale-sync-state-repo', () => {
  it('read returns null before any attempt is recorded', () => {
    const db = freshSalesSyncDb();
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.read('sale-1')).toBeNull();
    db.close();
  });

  it('markSynced sets sync_status=synced and synced_at', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'sale-1', ...SCOPE, now: '2026-06-07T10:05:00.000Z' });
    const row = nn(repo.read('sale-1'));
    expect(row.sync_status).toBe('synced');
    expect(row.synced_at).toBe('2026-06-07T10:05:00.000Z');
    db.close();
  });

  it('recordTransient stays pending, increments attempt_count, sets next_retry_at', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.recordTransient({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-06-07T10:05:00.000Z',
      nextRetryAt: '2026-06-07T10:06:00.000Z',
      errorCategory: 'transient',
    });
    const row = nn(repo.read('sale-1'));
    expect(row.sync_status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.next_retry_at).toBe('2026-06-07T10:06:00.000Z');
    // A second transient increments again.
    repo.recordTransient({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-06-07T10:07:00.000Z',
      nextRetryAt: '2026-06-07T10:09:00.000Z',
      errorCategory: 'transient',
    });
    expect(nn(repo.read('sale-1')).attempt_count).toBe(2);
    db.close();
  });

  it('markDeadLetter sets sync_status=dead_letter', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markDeadLetter({ saleId: 'sale-1', ...SCOPE, now: '2026-06-07T10:05:00.000Z' });
    expect(nn(repo.read('sale-1')).sync_status).toBe('dead_letter');
    db.close();
  });

  it('is tenant-scoped: a tenant-A write never creates a row read under tenant-B', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1', tenant_id: 'tenant-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'sale-1', tenantId: 'tenant-1', branchId: 'branch-1', now: 'X' });
    // eligible() for a different tenant must not see sale-1.
    const other = repo.eligible(
      { tenantId: 'tenant-2', branchId: 'branch-9', terminalId: 'term-1' },
      'Z',
    );
    expect(other.find((e) => e.sale_id === 'sale-1')).toBeUndefined();
    db.close();
  });

  describe('eligible() — the drain query (outbox LEFT JOIN state)', () => {
    it('a freshly-enqueued sale (outbox row, NO state row) is eligible', () => {
      const db = freshSalesSyncDb();
      seedSale(db, { sale_id: 'sale-1' });
      seedOutbox(db, { sale_id: 'sale-1' });
      const repo = createSaleSyncStateRepo(handleFor(db));
      const due = repo.eligible(SCOPE, '2026-06-07T10:05:00.000Z');
      expect(due.map((e) => e.sale_id)).toEqual(['sale-1']);
      db.close();
    });

    it('a synced sale is NOT eligible', () => {
      const db = freshSalesSyncDb();
      seedSale(db, { sale_id: 'sale-1' });
      seedOutbox(db, { sale_id: 'sale-1' });
      const repo = createSaleSyncStateRepo(handleFor(db));
      repo.markSynced({ saleId: 'sale-1', ...SCOPE, now: 'X' });
      expect(repo.eligible(SCOPE, 'Z')).toEqual([]);
      db.close();
    });

    it('a dead_letter sale is NOT eligible', () => {
      const db = freshSalesSyncDb();
      seedSale(db, { sale_id: 'sale-1' });
      seedOutbox(db, { sale_id: 'sale-1' });
      const repo = createSaleSyncStateRepo(handleFor(db));
      repo.markDeadLetter({ saleId: 'sale-1', ...SCOPE, now: 'X' });
      expect(repo.eligible(SCOPE, 'Z')).toEqual([]);
      db.close();
    });

    it('a pending sale whose next_retry_at is in the future is NOT eligible (backoff)', () => {
      const db = freshSalesSyncDb();
      seedSale(db, { sale_id: 'sale-1' });
      seedOutbox(db, { sale_id: 'sale-1' });
      const repo = createSaleSyncStateRepo(handleFor(db));
      repo.recordTransient({
        saleId: 'sale-1',
        ...SCOPE,
        now: '2026-06-07T10:05:00.000Z',
        nextRetryAt: '2026-06-07T11:00:00.000Z',
        errorCategory: 'transient',
      });
      // now is BEFORE next_retry_at → not yet due.
      expect(repo.eligible(SCOPE, '2026-06-07T10:30:00.000Z')).toEqual([]);
      // now is AFTER next_retry_at → due again.
      expect(repo.eligible(SCOPE, '2026-06-07T11:30:00.000Z').map((e) => e.sale_id)).toEqual([
        'sale-1',
      ]);
      db.close();
    });

    it('returns due sales in FIFO order by enqueued_at', () => {
      const db = freshSalesSyncDb();
      seedSale(db, { sale_id: 'sale-A' });
      seedSale(db, { sale_id: 'sale-B' });
      seedOutbox(db, { sale_id: 'sale-B', enqueued_at: '2026-06-07T10:00:02.000Z' });
      seedOutbox(db, { sale_id: 'sale-A', enqueued_at: '2026-06-07T10:00:01.000Z' });
      const repo = createSaleSyncStateRepo(handleFor(db));
      expect(repo.eligible(SCOPE, '2026-06-07T11:00:00.000Z').map((e) => e.sale_id)).toEqual([
        'sale-A',
        'sale-B',
      ]);
      db.close();
    });
  });
});
