/**
 * RT-224 step 2 (Codex P2 on beb7b72) — no injected dependency can break the drain.
 *
 * Every dependency the sale-sync client and engine call during a send (pairing
 * reads, token readers, clocks, the state / sales stores, the route resolver,
 * the client itself) can throw — a transient SQLite or OS failure. None of those
 * may make the client reject or abort a tick:
 *   • on the device path a throw reads as "pairing unavailable / changed": the
 *     cashier sale stays queued (`no_connection`), never dead-lettered;
 *   • in the engine a throwing dependency affects only what it touches — the
 *     other sales of the tick are still handled, and the tick resolves;
 *   • the failure is reported once per episode (`onDependencyFailure`).
 *
 * Setup: a real client (recording fetch) and a real engine over a real store,
 * an envelope and a device credential held, and two due sales — a cashier sale
 * (device path) first, then a manager/legacy sale (envelope path).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { createSaleSyncClient, type CreateSaleSyncClientDeps } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';
import { createSaleSyncStateRepo, type SaleSyncStateRepo } from '../sale-sync-state-repo.js';
import type { SaleSyncClient } from '../sale-sync-client-types.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSellingUserIdResolver, type SellingUserIdResolver } from '../selling-user-id.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const CASHIER = 'pos-pulse:handoff-sale-c';
const ENVELOPE_SALE = 'pos-pulse:handoff-sale-e';
const boom = (): never => {
  throw new Error('SQLITE_IOERR: transient failure');
};

type Outcome = 'synced' | 'queued';

interface Faults {
  client?: (deps: CreateSaleSyncClientDeps) => Partial<CreateSaleSyncClientDeps>;
  engine?: (deps: SaleSyncEngineDeps) => Partial<SaleSyncEngineDeps>;
}

async function runWith(faults: Faults) {
  const db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-c' });
  seedOutbox(db, { sale_id: 'sale-c', enqueued_at: '2026-06-07T10:00:00.000Z' });
  seedSettled(db, { sale_id: 'sale-c', selling_user_id: USER_A });
  seedSale(db, { sale_id: 'sale-e' });
  seedOutbox(db, { sale_id: 'sale-e', enqueued_at: '2026-06-07T10:00:01.000Z' });
  seedSettled(db, { sale_id: 'sale-e' });
  const handle = handleFor(db);
  const posted: string[] = [];
  const clientDeps: CreateSaleSyncClientDeps = {
    baseUrl: 'https://example.invalid',
    fetch: (_input, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { externalId: string };
      posted.push(body.externalId);
      return Promise.resolve(new Response('{}', { status: 201 }));
    },
    getOperatorToken: () => 'envelope',
    getDeviceToken: () => Promise.resolve('device-token'),
    currentTerminalId: () => 'term-1',
  };
  const client = createSaleSyncClient({ ...clientDeps, ...faults.client?.(clientDeps) });
  const stateRepo = createSaleSyncStateRepo(handle);
  const failures: unknown[][] = [];
  const engineDeps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => 'term-1',
    getOperatorToken: () => 'envelope',
    hasDeviceCredential: () => true,
    sellingUsers: createSellingUserIdResolver({ db: handle }),
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onDependencyFailure: (...args: unknown[]) => failures.push(args),
  };
  const engine = createSaleSyncEngine({ ...engineDeps, ...faults.engine?.(engineDeps) });
  const admission = engine.runTickOnce();
  const settled =
    admission.kind === 'started'
      ? await admission.completed.then(
          () => 'resolved',
          () => 'rejected',
        )
      : 'none';
  const outcome = (saleId: string): Outcome | 'dead_letter' => {
    const status = stateRepo.read(saleId)?.sync_status;
    if (status === 'dead_letter') return 'dead_letter';
    return status === 'synced' ? 'synced' : 'queued';
  };
  const result = {
    settled,
    posted,
    cashier: outcome('sale-c'),
    envelope: outcome('sale-e'),
    failures,
  };
  db.close();
  return result;
}

/** Wrap one method of a repo so it throws. */
function throwing<T extends object>(target: T, method: keyof T): T {
  const copy: T = { ...target };
  Object.assign(copy, { [method]: boom });
  return copy;
}

describe('RT-224 (Codex P2 on beb7b72) — a throwing dependency never breaks the drain', () => {
  it('baseline: both sales go out', async () => {
    const r = await runWith({});
    expect(r).toMatchObject({
      settled: 'resolved',
      posted: [CASHIER, ENVELOPE_SALE],
      cashier: 'synced',
      envelope: 'synced',
      failures: [],
    });
  });

  it.each<[string, Faults, string[], Outcome, Outcome, boolean]>([
    // [dependency, fault, posted, cashier, envelope, reported as a dependency failure]
    [
      'client.currentTerminalId',
      { client: () => ({ currentTerminalId: boom }) },
      [ENVELOPE_SALE],
      'queued',
      'synced',
      false,
    ],
    [
      'client.getDeviceToken',
      { client: () => ({ getDeviceToken: () => Promise.reject(new Error('DPAPI')) }) },
      [ENVELOPE_SALE],
      'queued',
      'synced',
      false,
    ],
    [
      'client.getOperatorToken',
      { client: () => ({ getOperatorToken: boom }) },
      [CASHIER],
      'synced',
      'queued',
      false,
    ],
    [
      'engine.getOperatorToken',
      { engine: () => ({ getOperatorToken: boom }) },
      [CASHIER],
      'synced',
      'queued',
      true,
    ],
    [
      'engine.hasDeviceCredential',
      { engine: () => ({ hasDeviceCredential: boom }) },
      [ENVELOPE_SALE],
      'queued',
      'synced',
      true,
    ],
    [
      'engine.resolveTerminalId',
      { engine: () => ({ resolveTerminalId: boom }) },
      [],
      'queued',
      'queued',
      true,
    ],
    ['engine.now', { engine: () => ({ now: boom }) }, [], 'queued', 'queued', true],
    [
      'stateRepo.eligible',
      { engine: (d) => ({ stateRepo: throwing(d.stateRepo, 'eligible') }) },
      [],
      'queued',
      'queued',
      true,
    ],
    [
      'stateRepo.markSynced',
      { engine: (d) => ({ stateRepo: throwing(d.stateRepo, 'markSynced') }) },
      [CASHIER, ENVELOPE_SALE],
      'queued',
      'queued',
      true,
    ],
    [
      'salesRepo.readById',
      { engine: (d) => ({ salesRepo: throwing(d.salesRepo, 'readById') }) },
      [],
      'queued',
      'queued',
      true,
    ],
    [
      'sellingUsers.resolve',
      {
        engine: (d) => ({
          sellingUsers: throwing(d.sellingUsers as SellingUserIdResolver, 'resolve'),
        }),
      },
      [],
      'queued',
      'queued',
      true,
    ],
    [
      'sellingUsers.forget',
      {
        engine: (d) => ({
          sellingUsers: throwing(d.sellingUsers as SellingUserIdResolver, 'forget'),
        }),
      },
      [CASHIER, ENVELOPE_SALE],
      'synced',
      'synced',
      true,
    ],
    [
      'client.postSaleAsCashier',
      { engine: (d) => ({ client: throwing(d.client, 'postSaleAsCashier') }) },
      [ENVELOPE_SALE],
      'queued',
      'synced',
      true,
    ],
    [
      'client.postSale',
      { engine: (d) => ({ client: throwing(d.client, 'postSale') }) },
      [CASHIER],
      'synced',
      'queued',
      true,
    ],
    [
      'salesRepo.readById (one sale only)',
      {
        engine: (d) => ({
          salesRepo: {
            readById: (id: string) => (id === 'sale-c' ? boom() : d.salesRepo.readById(id)),
          },
        }),
      },
      [ENVELOPE_SALE],
      'queued',
      'synced',
      true,
    ],
  ])(
    '%s throws: the tick resolves, nothing is dead-lettered, the other path still sends',
    async (_dep, faults, posted, cashier, envelope, reported) => {
      const r = await runWith(faults);
      expect(r.settled).toBe('resolved');
      expect(r.posted).toEqual(posted);
      expect(r.cashier).toBe(cashier);
      expect(r.envelope).toBe(envelope);
      expect(r.failures).toEqual(reported ? [[]] : []);
    },
  );

  it('the failure is reported once per episode, and again after a clean tick', async () => {
    const db = freshSalesSyncDb();
    const handle = handleFor(db);
    let failing = true;
    const failures: unknown[][] = [];
    const base = createSaleSyncStateRepo(handle);
    const stateRepo: SaleSyncStateRepo = {
      ...base,
      eligible: (...args) => (failing ? boom() : base.eligible(...args)),
    };
    const engine = createSaleSyncEngine({
      client: {} as SaleSyncClient,
      stateRepo,
      salesRepo: bindSalesRepository(handle),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      resolveTerminalId: () => 'term-1',
      getOperatorToken: () => 'envelope',
      now: () => '2026-06-07T10:05:00.000Z',
      backoff: { baseMs: 1000, maxMs: 300_000 },
      onDependencyFailure: (...args: unknown[]) => failures.push(args),
    });
    const tick = async () => {
      const a = engine.runTickOnce();
      if (a.kind === 'started') await a.completed;
    };
    await tick();
    await tick();
    expect(failures).toEqual([[]]);
    failing = false;
    await tick();
    failing = true;
    await tick();
    expect(failures).toEqual([[], []]);
    db.close();
  });
});

describe('RT-224 (Codex P2 on beb7b72) — client dependencies on a 425/429 answer', () => {
  it('nowMs throwing while reading Retry-After: still transient, never rejects', async () => {
    const payload: CaptureSalePayload = {
      externalId: 'pos-pulse:handoff-1',
      sourceSystem: 'pos-pulse',
      tenantId: 't1',
      branchId: 'b1',
      terminalId: 'term-1',
      operatorId: 'op-1',
      occurredAt: '2026-06-09T10:00:00.000Z',
      totalMinor: 100,
      lines: [
        {
          lineRef: 'l1',
          productRef: 'p1',
          lineName: 'Item',
          quantity: 1,
          unitPriceMinor: 100,
          lineAmountMinor: 100,
        },
      ],
    };
    const c = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: () =>
        Promise.resolve(new Response(null, { status: 425, headers: { 'Retry-After': '2' } })),
      getOperatorToken: () => 'envelope',
      nowMs: boom,
    });
    await expect(c.postSale(payload)).resolves.toEqual({ kind: 'transient' });
  });
});
