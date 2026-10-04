/**
 * RT-15 S1 — the server `saleRef` is persisted on `sale_sync_state` (0038).
 *
 *   • repo: `markSynced` stores `serverSaleRef`; a later write without one
 *     (409 duplicate, malformed body, transient, dead-letter) never clears it;
 *     a new non-null value replaces it; `findServerSaleRefBySaleId` is
 *     tenant/branch-scoped and only answers for a synced sale.
 *   • engine: `ok` persists the saleRef with the synced transition; `duplicate`
 *     stores none; a retry that ends in a replayed 200 stores it.
 *   • a pre-S1 row (written without the column) reads NULL.
 *   • end-to-end through the live client: a 201 `Sale` body lands in the row.
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
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import type { SaleSyncClient } from '../sale-sync-client-types.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1' };
const REF_A = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const REF_B = '0190f5a2-7b3c-7d4e-8f90-0000000000bb';

describe('sale-sync-state-repo — server_sale_ref (RT-15 S1)', () => {
  it('markSynced stores the serverSaleRef and read() returns it', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-10-04T10:00:00.000Z',
      serverSaleRef: REF_A,
    });
    expect(nn(repo.read('sale-1')).server_sale_ref).toBe(REF_A);
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBe(REF_A);
    db.close();
  });

  it('markSynced without a saleRef (e.g. 409) stores NULL', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'sale-1', ...SCOPE, now: '2026-10-04T10:00:00.000Z' });
    expect(nn(repo.read('sale-1')).server_sale_ref).toBeNull();
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBeNull();
    db.close();
  });

  it('a re-sync is idempotent: same value kept; null never clears; a new value replaces', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    const base = { saleId: 'sale-1', ...SCOPE };
    repo.markSynced({ ...base, now: '2026-10-04T10:00:00.000Z', serverSaleRef: REF_A });
    repo.markSynced({ ...base, now: '2026-10-04T10:01:00.000Z', serverSaleRef: REF_A });
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBe(REF_A);
    repo.markSynced({ ...base, now: '2026-10-04T10:02:00.000Z', serverSaleRef: null });
    repo.markSynced({ ...base, now: '2026-10-04T10:03:00.000Z' });
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBe(REF_A);
    repo.markSynced({ ...base, now: '2026-10-04T10:04:00.000Z', serverSaleRef: REF_B });
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBe(REF_B);
    db.close();
  });

  it('transient and dead-letter writes keep a stored reference (never clear it)', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-10-04T10:00:00.000Z',
      serverSaleRef: REF_A,
    });
    repo.recordTransient({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-10-04T10:01:00.000Z',
      nextRetryAt: '2026-10-04T10:02:00.000Z',
      errorCategory: 'transient',
    });
    expect(nn(repo.read('sale-1')).server_sale_ref).toBe(REF_A);
    repo.markDeadLetter({ saleId: 'sale-1', ...SCOPE, now: '2026-10-04T10:03:00.000Z' });
    expect(nn(repo.read('sale-1')).server_sale_ref).toBe(REF_A);
    db.close();
  });

  it('findServerSaleRefBySaleId is tenant/branch-scoped and synced-only', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedSale(db, { sale_id: 'sale-2' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({
      saleId: 'sale-1',
      ...SCOPE,
      now: '2026-10-04T10:00:00.000Z',
      serverSaleRef: REF_A,
    });
    expect(
      repo.findServerSaleRefBySaleId({ tenantId: 'tenant-2', branchId: 'branch-1' }, 'sale-1'),
    ).toBeNull();
    expect(
      repo.findServerSaleRefBySaleId({ tenantId: 'tenant-1', branchId: 'branch-2' }, 'sale-1'),
    ).toBeNull();
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'unknown-sale')).toBeNull();
    // A pending sale has no usable reference yet.
    repo.recordTransient({
      saleId: 'sale-2',
      ...SCOPE,
      now: '2026-10-04T10:00:00.000Z',
      nextRetryAt: '2026-10-04T10:01:00.000Z',
      errorCategory: 'no_connection',
    });
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-2')).toBeNull();
    db.close();
  });

  it('a pre-S1 synced row (written without the column) stays NULL', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-old' });
    // Exactly the INSERT shape the pre-S1 repo issued (no server_sale_ref column).
    db.run(
      `INSERT INTO sale_sync_state
         (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at,
          last_error_category, last_attempt_at, synced_at, created_at, updated_at)
       VALUES ('sale-old', 'tenant-1', 'branch-1', 'synced', 0, NULL, NULL,
               '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z',
               '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z')`,
    );
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(nn(repo.read('sale-old')).server_sale_ref).toBeNull();
    expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-old')).toBeNull();
    db.close();
  });

  it('the storage CHECK refuses a non-UUID reference', () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(() => {
      repo.markSynced({
        saleId: 'sale-1',
        ...SCOPE,
        now: '2026-10-04T10:00:00.000Z',
        serverSaleRef: 'nope',
      });
    }).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

function engineDeps(
  db: ReturnType<typeof freshSalesSyncDb>,
  client: SaleSyncClient,
  now: () => string = () => '2026-10-04T10:05:00.000Z',
): SaleSyncEngineDeps {
  const handle = handleFor(db);
  return {
    client,
    stateRepo: createSaleSyncStateRepo(handle),
    salesRepo: bindSalesRepository(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    getOperatorToken: () => 'tok-1',
    now,
    backoff: { baseMs: 1000, maxMs: 300_000 },
  };
}

async function runOnce(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

describe('sale-sync-engine — persists saleRef (RT-15 S1)', () => {
  it('ok with a saleRef → synced row carries server_sale_ref', async () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const deps = engineDeps(db, createFakeSaleSyncClient([{ kind: 'ok', saleRef: REF_A }]));
    await runOnce(deps);
    const row = nn(deps.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('synced');
    expect(row.server_sale_ref).toBe(REF_A);
    db.close();
  });

  it('ok with saleRef null → synced, server_sale_ref NULL (captured, not returnable)', async () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const deps = engineDeps(db, createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]));
    await runOnce(deps);
    const row = nn(deps.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('synced');
    expect(row.server_sale_ref).toBeNull();
    db.close();
  });

  it('duplicate (409) → synced with no saleRef', async () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const deps = engineDeps(db, createFakeSaleSyncClient([{ kind: 'duplicate' }]));
    await runOnce(deps);
    const row = nn(deps.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('synced');
    expect(row.server_sale_ref).toBeNull();
    db.close();
  });

  it('a retry that ends in a replayed 200 stores the saleRef', async () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const script: SaleSyncResult[] = [{ kind: 'transient' }, { kind: 'ok', saleRef: REF_A }];
    let clock = '2026-10-04T10:05:00.000Z';
    const deps = engineDeps(db, createFakeSaleSyncClient(script), () => clock);
    await runOnce(deps);
    expect(nn(deps.stateRepo.read('sale-1')).server_sale_ref).toBeNull();
    clock = '2026-10-04T11:00:00.000Z'; // past the backoff
    await runOnce(deps);
    const row = nn(deps.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('synced');
    expect(row.attempt_count).toBe(1);
    expect(row.server_sale_ref).toBe(REF_A);
    db.close();
  });

  it('end-to-end through the live client: a 201 Sale body lands in the row', async () => {
    const db = freshSalesSyncDb();
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    const live = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ saleRef: REF_A, voided: false, lines: [] }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      getOperatorToken: () => 'tok-1',
    });
    const deps = engineDeps(db, live);
    await runOnce(deps);
    expect(deps.stateRepo.findServerSaleRefBySaleId(SCOPE, 'sale-1')).toBe(REF_A);
    db.close();
  });
});
