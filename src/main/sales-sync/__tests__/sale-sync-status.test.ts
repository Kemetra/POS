/**
 * 011 T050 (RED) — sale-sync status reader (the read-only surface source).
 *
 * `readSyncStatus(scope)` returns the tenant-scoped counts the renderer shows:
 *   • pending      — sales not yet synced (state pending OR no state row yet)
 *   • deadLetter   — sales in dead_letter (payload divergences included)
 *   • payloadDivergence — RT-190: the dead-lettered sales whose capture answered 409
 *   • lastSuccessAt — the most recent synced_at, or null if none ever synced
 * No secrets, no token, no PII — counts + one timestamp only (P7).
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

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1' };

describe('T050 — readSyncStatus', () => {
  it('reports zero/null on an empty terminal', () => {
    const db = freshSalesSyncDb();
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.readSyncStatus(SCOPE)).toEqual({
      pending: 0,
      deadLetter: 0,
      payloadDivergence: 0,
      lastSuccessAt: null,
    });
    db.close();
  });

  it('counts a freshly-enqueued (no state row) sale as pending', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.readSyncStatus(SCOPE).pending).toBe(1);
    db.close();
  });

  it('reports the most recent synced_at as lastSuccessAt', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedSale(db, { sale_id: 'sale-2' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'sale-1', ...SCOPE, now: '2026-06-07T10:00:00.000Z' });
    repo.markSynced({ saleId: 'sale-2', ...SCOPE, now: '2026-06-07T11:00:00.000Z' });
    const status = repo.readSyncStatus(SCOPE);
    expect(status.lastSuccessAt).toBe('2026-06-07T11:00:00.000Z');
    expect(status.pending).toBe(0);
    db.close();
  });

  it('counts dead_letter sales', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markDeadLetter({ saleId: 'sale-1', ...SCOPE, now: '2026-06-07T10:00:00.000Z' });
    expect(repo.readSyncStatus(SCOPE).deadLetter).toBe(1);
    db.close();
  });

  it('RT-190: counts a payload divergence as a dead-letter AND as a divergence', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedSale(db, { sale_id: 'sale-2' });
    seedOutbox(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-2' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    const now = '2026-06-07T10:00:00.000Z';
    repo.markDeadLetter({ saleId: 'sale-1', ...SCOPE, now });
    repo.markDeadLetter({ saleId: 'sale-2', ...SCOPE, now, reason: 'payload_divergence' });
    expect(repo.readSyncStatus(SCOPE)).toEqual({
      pending: 0,
      deadLetter: 2,
      payloadDivergence: 1,
      lastSuccessAt: null,
    });
    expect(nn(repo.read('sale-1')).last_error_category).toBe('permanent');
    expect(nn(repo.read('sale-2')).last_error_category).toBe('payload_divergence');
    db.close();
  });

  it('RT-190: the divergence count is tenant-scoped', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markDeadLetter({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-06-07T10:00:00.000Z',
      reason: 'payload_divergence',
    });
    expect(repo.readSyncStatus({ tenantId: 'tenant-2', branchId: 'branch-9' })).toEqual({
      pending: 0,
      deadLetter: 0,
      payloadDivergence: 0,
      lastSuccessAt: null,
    });
    db.close();
  });

  it('is tenant-scoped: tenant-B counts exclude tenant-A rows', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1', tenant_id: 'tenant-1' });
    seedOutbox(db, { sale_id: 'sale-1', tenant_id: 'tenant-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.readSyncStatus({ tenantId: 'tenant-2', branchId: 'branch-9' }).pending).toBe(0);
    db.close();
  });
});
