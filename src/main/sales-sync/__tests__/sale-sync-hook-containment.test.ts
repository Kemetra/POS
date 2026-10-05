/**
 * RT-224 step 2 (Codex P2 on bf5960d) — no injected hook can break the drain.
 *
 * Every notification hook of the sale-sync path (client, engine, resolver,
 * device-token reader) is a side channel — a log line. A hook that throws (a
 * failing log sink) must never make the client reject, abort the engine tick, or
 * stop the sales queued after the one that fired it. The state transition the
 * hook reports is already persisted before it is called.
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
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSellingUserIdResolver } from '../selling-user-id.js';
import { createSaleSyncDeviceTokenReader } from '../sale-sync-device-token.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const REF_A = '0190a3c4-5b6d-7e8f-9a0b-00000000000a';
const REF_B = '0190a3c4-5b6d-7e8f-9a0b-00000000000b';
const boom = (): never => {
  throw new Error('log sink unavailable');
};

const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-1',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-06-09T10:00:00.000Z',
  totalMinor: 1000,
  lines: [
    {
      lineRef: 'l1',
      productRef: 'p1',
      lineName: 'Item',
      quantity: 1,
      unitPriceMinor: 1000,
      lineAmountMinor: 1000,
    },
  ],
};

describe('client hooks', () => {
  it('onSaleRefUnavailable throwing: still ok', async () => {
    const c = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: () => Promise.resolve(new Response('{}', { status: 201 })),
      getOperatorToken: () => 'envelope',
      onSaleRefUnavailable: boom,
    });
    await expect(c.postSale(PAYLOAD)).resolves.toEqual({ kind: 'ok', saleRef: null });
  });

  it('onDeviceTerminalChanged throwing: still no_connection, no request', async () => {
    const requests: unknown[] = [];
    const c = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: (input) => {
        requests.push(input);
        return Promise.resolve(new Response('{}', { status: 201 }));
      },
      getOperatorToken: () => 'envelope',
      getDeviceToken: () => Promise.resolve('device-token'),
      currentTerminalId: () => 'term-OTHER',
      onDeviceTerminalChanged: boom,
    });
    await expect(c.postSaleAsCashier(PAYLOAD, USER_A)).resolves.toEqual({ kind: 'no_connection' });
    expect(requests).toHaveLength(0);
  });
});

describe('device-token reader hook', () => {
  it('onReadFailure throwing: still null', async () => {
    const read = createSaleSyncDeviceTokenReader({
      isPaired: () => Promise.resolve(true),
      readToken: () => Promise.reject(new Error('DPAPI')),
      onReadFailure: boom,
    });
    await expect(read()).resolves.toBeNull();
  });
});

describe('resolver hooks', () => {
  it('onUnresolved throwing: the sale is still routed, the batch is not held', () => {
    const db = freshSalesSyncDb();
    const handle = handleFor(db);
    seedSale(db, { sale_id: 'sale-bad' });
    seedSettled(db, { sale_id: 'sale-bad', selling_user_id: 'not-a-uuid' });
    seedSale(db, { sale_id: 'sale-ok' });
    seedSettled(db, { sale_id: 'sale-ok', selling_user_id: USER_A });
    seedSale(db, { sale_id: 'sale-old', terminal_id: 'term-OLD' });
    const resolver = createSellingUserIdResolver({ db: handle, onUnresolved: boom });
    const sales = bindSalesRepository(handle);
    const rows = ['sale-bad', 'sale-ok', 'sale-old'].map((id) => nn(sales.readById(id)));
    const routes = resolver.resolve(rows, 'term-1');
    expect(routes.get('sale-bad')).toEqual({ kind: 'hold' });
    expect(routes.get('sale-ok')).toEqual({ kind: 'device', operatorUserId: USER_A });
    expect(routes.get('sale-old')).toEqual({ kind: 'hold' });
    db.close();
  });

  it('onLookupFailed throwing: the batch is held, resolve does not throw', () => {
    const db = freshSalesSyncDb();
    const handle = handleFor(db);
    seedSale(db, { sale_id: 'sale-1' });
    const resolver = createSellingUserIdResolver({
      db: { ...handle, prepare: boom },
      onLookupFailed: boom,
    });
    const sale = nn(bindSalesRepository(handle).readById('sale-1'));
    expect(resolver.resolve([sale], 'term-1').get('sale-1')).toEqual({ kind: 'hold' });
    db.close();
  });
});

/**
 * Two cashier sales; the first answer fires the hook under test (which throws).
 * The tick must resolve and the second sale must still be sent.
 */
function engineWith(
  first: SaleSyncResult,
  hooks: Partial<SaleSyncEngineDeps>,
  prepare?: (db: ReturnType<typeof freshSalesSyncDb>) => void,
) {
  const db = freshSalesSyncDb();
  for (const [i, id] of ['sale-1', 'sale-2'].entries()) {
    seedSale(db, { sale_id: id });
    seedOutbox(db, { sale_id: id, enqueued_at: `2026-06-07T10:00:0${String(i)}.000Z` });
    seedSettled(db, { sale_id: id, selling_user_id: USER_A });
  }
  prepare?.(db);
  const handle = handleFor(db);
  const client = createFakeSaleSyncClient([first, { kind: 'ok', saleRef: null }]);
  const stateRepo = createSaleSyncStateRepo(handle);
  const engine = createSaleSyncEngine({
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => 'term-1',
    getOperatorToken: () => null,
    hasDeviceCredential: () => true,
    sellingUsers: createSellingUserIdResolver({ db: handle }),
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    ...hooks,
  });
  return { db, engine, client, stateRepo };
}

describe('engine hooks', () => {
  it.each<[string, SaleSyncResult, Partial<SaleSyncEngineDeps>, boolean]>([
    ['onDeadLetter (permanent)', { kind: 'permanent' }, { onDeadLetter: boom }, false],
    ['onDeadLetter (cashier_claim_refused)', { kind: 'refused' }, { onDeadLetter: boom }, false],
    [
      'onPayloadDivergence',
      { kind: 'divergent', errorCode: 'idempotency_key_conflict' },
      { onPayloadDivergence: boom },
      false,
    ],
    [
      'onDeviceUnauthorized',
      { kind: 'device_unauthorized' },
      { onDeviceUnauthorized: boom },
      false,
    ],
    ['onSaleRefMismatch', { kind: 'ok', saleRef: REF_B }, { onSaleRefMismatch: boom }, true],
  ])(
    '%s throwing: the tick resolves and the next sale is still handled',
    async (_name, first, hooks, mismatch) => {
      const h = engineWith(first, hooks, (db) => {
        if (!mismatch) return;
        db.run(
          `INSERT INTO sale_sync_state
           (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at,
            last_error_category, last_attempt_at, synced_at, created_at, updated_at, server_sale_ref)
         VALUES ('sale-1', 'tenant-1', 'branch-1', 'pending', 1, NULL, 'transient', NULL, NULL,
                 '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z', ?)`,
          [REF_A],
        );
      });
      const admission = h.engine.runTickOnce();
      if (admission.kind === 'started') await expect(admission.completed).resolves.toBeUndefined();
      // After a device-path 401 the device path rests for the tick (by design), so
      // the next sale goes on the next tick.
      if (first.kind === 'device_unauthorized') {
        const next = h.engine.runTickOnce();
        if (next.kind === 'started') await next.completed;
      }
      expect(h.client.cashierCalls.map((c) => c.payload.externalId)).toContain(
        'pos-pulse:handoff-sale-2',
      );
      expect(nn(h.stateRepo.read('sale-2')).sync_status).toBe('synced');
      h.db.close();
    },
  );
});
