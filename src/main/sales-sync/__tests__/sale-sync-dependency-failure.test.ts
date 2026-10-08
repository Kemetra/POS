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
import {
  createSaleSyncEngine,
  type SaleSyncEngine,
  type SaleSyncEngineDeps,
} from '../sale-sync-engine.js';
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

/** One table row: the dependency that throws and what must still happen. */
interface Row {
  dep: string;
  faults: Faults;
  /** externalIds that reached `fetch`. */
  posted: string[];
  cashier: Outcome;
  envelope: Outcome;
  /** Reported once through `onDependencyFailure`. */
  reported: boolean;
}

/** A cashier sale (device path) first, then a manager/legacy sale (envelope path). */
function seedTwoSales(db: ReturnType<typeof freshSalesSyncDb>): void {
  seedSale(db, { sale_id: 'sale-c' });
  seedOutbox(db, { sale_id: 'sale-c', enqueued_at: '2026-06-07T10:00:00.000Z' });
  seedSettled(db, { sale_id: 'sale-c', selling_user_id: USER_A });
  seedSale(db, { sale_id: 'sale-e' });
  seedOutbox(db, { sale_id: 'sale-e', enqueued_at: '2026-06-07T10:00:01.000Z' });
  seedSettled(db, { sale_id: 'sale-e' });
}

/** Healthy client deps whose fetch records each POSTed externalId and answers 201. */
function recordingClientDeps(posted: string[]): CreateSaleSyncClientDeps {
  return {
    baseUrl: 'https://example.invalid',
    fetch: (_input, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      posted.push((JSON.parse(raw) as { externalId: string }).externalId);
      return Promise.resolve(new Response('{}', { status: 201 }));
    },
    getOperatorToken: () => 'envelope',
    getDeviceToken: () => Promise.resolve('device-token'),
    currentTerminalId: () => 'term-1',
  };
}

/** Healthy engine deps: an envelope and a device credential held. */
function healthyEngineDeps(
  handle: ReturnType<typeof handleFor>,
  client: SaleSyncClient,
  failures: unknown[][],
): SaleSyncEngineDeps {
  return {
    client,
    stateRepo: createSaleSyncStateRepo(handle),
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
}

/** Whether the tick's promise resolved or rejected. */
async function settleTick(admission: ReturnType<SaleSyncEngine['runTickOnce']>): Promise<string> {
  if (admission.kind !== 'started') return 'none';
  return admission.completed.then(
    () => 'resolved',
    () => 'rejected',
  );
}

/** synced / queued (no state row, or pending) / dead_letter. */
function outcomeOf(stateRepo: SaleSyncStateRepo, saleId: string): Outcome | 'dead_letter' {
  const status = stateRepo.read(saleId)?.sync_status;
  if (status === 'dead_letter') return 'dead_letter';
  return status === 'synced' ? 'synced' : 'queued';
}

async function runWith(faults: Faults) {
  const db = freshSalesSyncDb();
  seedTwoSales(db);
  const handle = handleFor(db);
  const posted: string[] = [];
  const clientDeps = recordingClientDeps(posted);
  const client = createSaleSyncClient({ ...clientDeps, ...faults.client?.(clientDeps) });
  const failures: unknown[][] = [];
  const engineDeps = healthyEngineDeps(handle, client, failures);
  const engine = createSaleSyncEngine({ ...engineDeps, ...faults.engine?.(engineDeps) });
  const settled = await settleTick(engine.runTickOnce());
  const result = {
    settled,
    posted,
    cashier: outcomeOf(engineDeps.stateRepo, 'sale-c'),
    envelope: outcomeOf(engineDeps.stateRepo, 'sale-e'),
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

  it.each<Row>([
    {
      dep: 'client.currentTerminalId',
      faults: { client: () => ({ currentTerminalId: boom }) },
      posted: [ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'synced',
      reported: false,
    },
    {
      dep: 'client.getDeviceToken',
      faults: { client: () => ({ getDeviceToken: () => Promise.reject(new Error('DPAPI')) }) },
      posted: [ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'synced',
      reported: false,
    },
    {
      dep: 'client.getOperatorToken',
      faults: { client: () => ({ getOperatorToken: boom }) },
      posted: [CASHIER],
      cashier: 'synced',
      envelope: 'queued',
      reported: false,
    },
    {
      dep: 'engine.getOperatorToken',
      faults: { engine: () => ({ getOperatorToken: boom }) },
      posted: [CASHIER],
      cashier: 'synced',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'engine.hasDeviceCredential',
      faults: { engine: () => ({ hasDeviceCredential: boom }) },
      posted: [ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'synced',
      reported: true,
    },
    {
      dep: 'engine.resolveTerminalId',
      faults: { engine: () => ({ resolveTerminalId: boom }) },
      posted: [],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'engine.now',
      faults: { engine: () => ({ now: boom }) },
      posted: [],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'stateRepo.eligible',
      faults: { engine: (d) => ({ stateRepo: throwing(d.stateRepo, 'eligible') }) },
      posted: [],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'stateRepo.markSynced',
      faults: { engine: (d) => ({ stateRepo: throwing(d.stateRepo, 'markSynced') }) },
      posted: [CASHIER, ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'salesRepo.readById',
      faults: { engine: (d) => ({ salesRepo: throwing(d.salesRepo, 'readById') }) },
      posted: [],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'sellingUsers.resolve',
      faults: {
        engine: (d) => ({
          sellingUsers: throwing(d.sellingUsers as SellingUserIdResolver, 'resolve'),
        }),
      },
      posted: [],
      cashier: 'queued',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'sellingUsers.forget',
      faults: {
        engine: (d) => ({
          sellingUsers: throwing(d.sellingUsers as SellingUserIdResolver, 'forget'),
        }),
      },
      posted: [CASHIER, ENVELOPE_SALE],
      cashier: 'synced',
      envelope: 'synced',
      reported: true,
    },
    {
      dep: 'client.postSaleAsCashier',
      faults: { engine: (d) => ({ client: throwing(d.client, 'postSaleAsCashier') }) },
      posted: [ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'synced',
      reported: true,
    },
    {
      dep: 'client.postSale',
      faults: { engine: (d) => ({ client: throwing(d.client, 'postSale') }) },
      posted: [CASHIER],
      cashier: 'synced',
      envelope: 'queued',
      reported: true,
    },
    {
      dep: 'salesRepo.readById (one sale only)',
      faults: {
        engine: (d) => ({
          salesRepo: {
            readById: (id: string) => (id === 'sale-c' ? boom() : d.salesRepo.readById(id)),
          },
        }),
      },
      posted: [ENVELOPE_SALE],
      cashier: 'queued',
      envelope: 'synced',
      reported: true,
    },
  ])(
    '$dep throws: the tick resolves, nothing is dead-lettered, the other path still sends',
    async (row) => {
      const r = await runWith(row.faults);
      expect(r.settled).toBe('resolved');
      expect(r.posted).toEqual(row.posted);
      expect({ cashier: r.cashier, envelope: r.envelope }).toEqual({
        cashier: row.cashier,
        envelope: row.envelope,
      });
      expect(r.failures).toEqual(row.reported ? [[]] : []);
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
