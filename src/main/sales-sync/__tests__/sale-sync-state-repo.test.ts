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

// ── RT-225 step 3 — support reset of `cashier_claim_refused` dead-letters ────────

describe('RT-225 — resetCashierClaimRefused', () => {
  const NOW = '2026-06-08T09:00:00.000Z';
  const LATER = '2026-06-08T09:00:01.000Z';

  /** One queued sale (durable Sale + outbox row) on `terminal`, in tenant-1/branch-1 by default. */
  function queue(
    db: ReturnType<typeof freshSalesSyncDb>,
    saleId: string,
    o: { terminal?: string; tenant?: string; branch?: string } = {},
  ): void {
    const where = {
      tenant_id: o.tenant ?? 'tenant-1',
      branch_id: o.branch ?? 'branch-1',
      terminal_id: o.terminal ?? 'term-1',
    };
    seedSale(db, { sale_id: saleId, ...where });
    seedOutbox(db, { sale_id: saleId, ...where });
  }

  function refuse(
    repo: ReturnType<typeof createSaleSyncStateRepo>,
    saleId: string,
    o: { tenantId?: string; branchId?: string } = {},
  ): void {
    repo.markDeadLetter({
      saleId,
      tenantId: o.tenantId ?? 'tenant-1',
      branchId: o.branchId ?? 'branch-1',
      now: '2026-06-07T10:05:00.000Z',
      reason: 'cashier_claim_refused',
    });
  }

  it('re-queues the current terminal’s cashier_claim_refused dead-letters as pending and due', () => {
    const db = freshSalesSyncDb();
    queue(db, 'sale-1');
    queue(db, 'sale-2');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.recordTransient({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-06-07T10:04:00.000Z',
      nextRetryAt: '2026-06-07T10:04:01.000Z',
      errorCategory: 'device_unauthorized',
    });
    refuse(repo, 'sale-1');
    refuse(repo, 'sale-2');
    expect(repo.eligible(SCOPE, LATER)).toEqual([]);
    expect(repo.readSyncStatus(SCOPE).deadLetter).toBe(2);

    expect(repo.resetCashierClaimRefused(SCOPE, NOW)).toBe(2);

    const row = nn(repo.read('sale-1'));
    expect(row.sync_status).toBe('pending');
    expect(row.next_retry_at).toBeNull();
    expect(row.last_error_category).toBeNull();
    expect(row.updated_at).toBe(NOW);
    // Bookkeeping is kept: the attempt count is history, not reset.
    expect(row.attempt_count).toBe(1);
    expect(row.synced_at).toBeNull();
    expect(repo.eligible(SCOPE, LATER).map((e) => e.sale_id)).toEqual(['sale-1', 'sale-2']);
    const counts = repo.readSyncStatus(SCOPE);
    expect(counts.deadLetter).toBe(0);
    expect(counts.pending).toBe(2);
    db.close();
  });

  it('leaves every other dead-letter reason, synced and pending rows untouched', () => {
    const db = freshSalesSyncDb();
    for (const id of ['perm', 'diverged', 'synced', 'pending']) queue(db, id);
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markDeadLetter({ saleId: 'perm', ...SCOPE, now: '2026-06-07T10:05:00.000Z' });
    repo.markDeadLetter({
      saleId: 'diverged',
      ...SCOPE,
      now: '2026-06-07T10:05:00.000Z',
      reason: 'payload_divergence',
    });
    repo.markSynced({ saleId: 'synced', ...SCOPE, now: '2026-06-07T10:05:00.000Z' });
    repo.recordTransient({
      saleId: 'pending',
      ...SCOPE,
      now: '2026-06-07T10:05:00.000Z',
      nextRetryAt: '2026-06-09T00:00:00.000Z',
      errorCategory: 'transient',
    });
    const before = ['perm', 'diverged', 'synced', 'pending'].map((id) => repo.read(id));

    expect(repo.resetCashierClaimRefused(SCOPE, NOW)).toBe(0);

    expect(['perm', 'diverged', 'synced', 'pending'].map((id) => repo.read(id))).toEqual(before);
    db.close();
  });

  it('never touches an earlier pairing’s (held) rows or another tenant/branch', () => {
    const db = freshSalesSyncDb();
    queue(db, 'mine');
    queue(db, 'old-terminal', { terminal: 'term-0' });
    queue(db, 'other-branch', { branch: 'branch-2' });
    queue(db, 'other-tenant', { tenant: 'tenant-2' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    refuse(repo, 'mine');
    refuse(repo, 'old-terminal');
    refuse(repo, 'other-branch', { branchId: 'branch-2' });
    refuse(repo, 'other-tenant', { tenantId: 'tenant-2' });

    expect(repo.resetCashierClaimRefused(SCOPE, NOW)).toBe(1);

    expect(nn(repo.read('mine')).sync_status).toBe('pending');
    for (const id of ['old-terminal', 'other-branch', 'other-tenant']) {
      const row = nn(repo.read(id));
      expect(row.sync_status).toBe('dead_letter');
      expect(row.last_error_category).toBe('cashier_claim_refused');
    }
    db.close();
  });

  it('no current pairing (null terminal): resets nothing', () => {
    const db = freshSalesSyncDb();
    queue(db, 'sale-1');
    const repo = createSaleSyncStateRepo(handleFor(db));
    refuse(repo, 'sale-1');
    expect(repo.resetCashierClaimRefused({ ...SCOPE, terminalId: null }, NOW)).toBe(0);
    expect(nn(repo.read('sale-1')).sync_status).toBe('dead_letter');
    db.close();
  });

  it('is idempotent: a second reset finds nothing to do', () => {
    const db = freshSalesSyncDb();
    queue(db, 'sale-1');
    const repo = createSaleSyncStateRepo(handleFor(db));
    refuse(repo, 'sale-1');
    expect(repo.resetCashierClaimRefused(SCOPE, NOW)).toBe(1);
    expect(repo.resetCashierClaimRefused(SCOPE, LATER)).toBe(0);
    expect(nn(repo.read('sale-1')).updated_at).toBe(NOW);
    db.close();
  });
});
