/**
 * RT-221 — the sale-sync outbox never replays a previous pairing's sales.
 *
 * A terminal that re-pairs into the same tenant/branch gets a new device
 * identity (a new `terminal_id`). RT-138 L6 (owner-ratified) forbids an
 * automatic replay under a new device identity, and the owner approved the
 * posture "hold, never replay" (RT-221 comment 10876):
 *
 *   • only outbox rows of the CURRENT `terminal_id` are eligible to sync;
 *   • rows of an earlier pairing are HELD — never sent, never deleted, never
 *     mutated — and counted as `heldPreviousPairing` on the status surface;
 *   • an unpaired / invalid terminal (no current `terminal_id`) has nothing
 *     eligible;
 *   • the retry path (a pending row whose `next_retry_at` is due) goes through
 *     the same scoped query, so an earlier pairing's retry is never re-sent.
 *
 * Recovering held rows is a separate support flow (out of scope here).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
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
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import { deriveExternalId } from '../capture-payload.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const OLD_TERMINAL = 'term-old';
const NEW_TERMINAL = 'term-new';
const NOW = '2026-06-07T10:05:00.000Z';

const SCOPE_NEW = { tenantId: TENANT, branchId: BRANCH, terminalId: NEW_TERMINAL };

/** Seed one finalized sale + its outbox row for a given terminal. */
function seedSaleFor(
  db: SqlJsDatabase,
  saleId: string,
  terminalId: string,
  enqueuedAt: string,
  scope: { tenant_id?: string; branch_id?: string } = {},
): void {
  seedSale(db, { sale_id: saleId, terminal_id: terminalId, ...scope });
  seedOutbox(db, { sale_id: saleId, terminal_id: terminalId, enqueued_at: enqueuedAt, ...scope });
}

/**
 * The state a re-paired terminal sees: two sales queued under the OLD pairing
 * (one never attempted, one pending a due retry), then two under the NEW one.
 * Same tenant, same branch.
 */
function seedRepairedTerminal(db: SqlJsDatabase): void {
  seedSaleFor(db, 'old-1', OLD_TERMINAL, '2026-06-07T09:00:00.000Z');
  seedSaleFor(db, 'old-2', OLD_TERMINAL, '2026-06-07T09:01:00.000Z');
  seedSaleFor(db, 'new-1', NEW_TERMINAL, '2026-06-07T10:00:00.000Z');
  seedSaleFor(db, 'new-2', NEW_TERMINAL, '2026-06-07T10:01:00.000Z');
  // old-2 was attempted under the old pairing and is waiting on a due retry.
  createSaleSyncStateRepo(handleFor(db)).recordTransient({
    saleId: 'old-2',
    tenantId: TENANT,
    branchId: BRANCH,
    now: '2026-06-07T09:02:00.000Z',
    nextRetryAt: '2026-06-07T09:03:00.000Z',
    errorCategory: 'no_connection',
  });
}

/** Every row of a table, ordered, as plain values (for unchanged-ness checks). */
function dump(db: SqlJsDatabase, table: string, where = '1 = 1'): unknown[][] {
  const res = db.exec(`SELECT * FROM ${table} WHERE ${where} ORDER BY sale_id`);
  return res[0]?.values ?? [];
}

const OLD_ROWS = `sale_id IN ('old-1', 'old-2')`;

describe('RT-221 — sale-sync-state-repo eligible() is scoped to the current terminal', () => {
  it("after a re-pair into the same tenant/branch, the old terminal's rows are never eligible", () => {
    const db = freshSalesSyncDb();
    seedRepairedTerminal(db);
    const repo = createSaleSyncStateRepo(handleFor(db));
    const due = repo.eligible(SCOPE_NEW, NOW);
    expect(due.map((e) => e.sale_id)).toEqual(['new-1', 'new-2']);
    db.close();
  });

  it("the current terminal's rows are unaffected (FIFO, first drain + due retry)", () => {
    const db = freshSalesSyncDb();
    seedSaleFor(db, 'new-1', NEW_TERMINAL, '2026-06-07T10:00:00.000Z');
    seedSaleFor(db, 'new-2', NEW_TERMINAL, '2026-06-07T10:01:00.000Z');
    seedSaleFor(db, 'new-3', NEW_TERMINAL, '2026-06-07T10:02:00.000Z');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.recordTransient({
      saleId: 'new-1',
      tenantId: TENANT,
      branchId: BRANCH,
      now: '2026-06-07T10:03:00.000Z',
      nextRetryAt: '2026-06-07T10:04:00.000Z',
      errorCategory: 'transient',
    });
    repo.markSynced({ saleId: 'new-3', tenantId: TENANT, branchId: BRANCH, now: NOW });
    expect(repo.eligible(SCOPE_NEW, NOW).map((e) => e.sale_id)).toEqual(['new-1', 'new-2']);
    db.close();
  });

  it('the old terminal still sees its own rows (scope is the terminal, not "newest wins")', () => {
    const db = freshSalesSyncDb();
    seedRepairedTerminal(db);
    const repo = createSaleSyncStateRepo(handleFor(db));
    const due = repo.eligible(
      { tenantId: TENANT, branchId: BRANCH, terminalId: OLD_TERMINAL },
      NOW,
    );
    expect(due.map((e) => e.sale_id)).toEqual(['old-1', 'old-2']);
    db.close();
  });

  it('an unpaired / invalid terminal (no current terminal_id) has nothing eligible', () => {
    const db = freshSalesSyncDb();
    seedRepairedTerminal(db);
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.eligible({ tenantId: TENANT, branchId: BRANCH, terminalId: null }, NOW)).toEqual(
      [],
    );
    db.close();
  });

  it("retry path: an earlier pairing's pending row with a due next_retry_at is not eligible", () => {
    const db = freshSalesSyncDb();
    seedSaleFor(db, 'old-2', OLD_TERMINAL, '2026-06-07T09:01:00.000Z');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.recordTransient({
      saleId: 'old-2',
      tenantId: TENANT,
      branchId: BRANCH,
      now: '2026-06-07T09:02:00.000Z',
      nextRetryAt: '2026-06-07T09:03:00.000Z',
      errorCategory: 'transient',
    });
    expect(repo.eligible(SCOPE_NEW, NOW)).toEqual([]);
    db.close();
  });
});

describe('RT-221 — readSyncStatus counts pending per terminal and the held rows', () => {
  it('pending counts only the current terminal; earlier pairings are heldPreviousPairing', () => {
    const db = freshSalesSyncDb();
    seedRepairedTerminal(db);
    const repo = createSaleSyncStateRepo(handleFor(db));
    const status = repo.readSyncStatus(SCOPE_NEW);
    expect(status.pending).toBe(2);
    expect(status.heldPreviousPairing).toBe(2);
    db.close();
  });

  it('a synced or dead-lettered row of an earlier pairing is not held (it is terminal)', () => {
    const db = freshSalesSyncDb();
    seedSaleFor(db, 'old-1', OLD_TERMINAL, '2026-06-07T09:00:00.000Z');
    seedSaleFor(db, 'old-2', OLD_TERMINAL, '2026-06-07T09:01:00.000Z');
    seedSaleFor(db, 'old-3', OLD_TERMINAL, '2026-06-07T09:02:00.000Z');
    const repo = createSaleSyncStateRepo(handleFor(db));
    repo.markSynced({ saleId: 'old-1', tenantId: TENANT, branchId: BRANCH, now: NOW });
    repo.markDeadLetter({ saleId: 'old-2', tenantId: TENANT, branchId: BRANCH, now: NOW });
    const status = repo.readSyncStatus(SCOPE_NEW);
    expect(status.heldPreviousPairing).toBe(1);
    expect(status.pending).toBe(0);
    // Existing fields keep their meaning: dead-letter / last success are not terminal-scoped.
    expect(status.deadLetter).toBe(1);
    expect(status.lastSuccessAt).toBe(NOW);
    db.close();
  });

  it('held rows are counted within the tenant/branch scope only', () => {
    const db = freshSalesSyncDb();
    seedSaleFor(db, 'other-1', OLD_TERMINAL, '2026-06-07T09:00:00.000Z', {
      tenant_id: 'tenant-2',
      branch_id: 'branch-9',
    });
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.readSyncStatus(SCOPE_NEW).heldPreviousPairing).toBe(0);
    db.close();
  });

  it('an unpaired terminal has nothing pending: every unsent row in scope is held', () => {
    const db = freshSalesSyncDb();
    seedRepairedTerminal(db);
    const repo = createSaleSyncStateRepo(handleFor(db));
    const status = repo.readSyncStatus({ tenantId: TENANT, branchId: BRANCH, terminalId: null });
    expect(status.pending).toBe(0);
    expect(status.heldPreviousPairing).toBe(4);
    db.close();
  });

  it('reports zero held on an empty terminal and keeps the existing fields', () => {
    const db = freshSalesSyncDb();
    const repo = createSaleSyncStateRepo(handleFor(db));
    expect(repo.readSyncStatus(SCOPE_NEW)).toEqual({
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      payloadDivergence: 0,
      lastSuccessAt: null,
    });
    db.close();
  });
});

interface EngineHarness {
  db: SqlJsDatabase;
  client: ReturnType<typeof createFakeSaleSyncClient>;
  deps: SaleSyncEngineDeps;
  stateRepo: ReturnType<typeof createSaleSyncStateRepo>;
}

function engineHarness(
  resolveTerminalId: SaleSyncEngineDeps['resolveTerminalId'],
  script: Parameters<typeof createFakeSaleSyncClient>[0] = [{ kind: 'ok', saleRef: null }],
): EngineHarness {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient(script);
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: TENANT,
    branchId: BRANCH,
    resolveTerminalId,
    getOperatorToken: () => 'env-1',
    now: () => NOW,
    backoff: { baseMs: 1000, maxMs: 300_000 },
  };
  return { db, client, deps, stateRepo };
}

async function runOnce(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

function sentSaleIds(h: EngineHarness): string[] {
  return h.client.calls.map((p) => p.externalId);
}

describe('RT-221 — sale-sync-engine drains only the current terminal', () => {
  it('after a re-pair, only the new terminal’s sales are POSTed; old rows are held untouched', async () => {
    const h = engineHarness(() => NEW_TERMINAL);
    seedRepairedTerminal(h.db);
    const outboxBefore = dump(h.db, 'sale_sync_outbox');
    const salesBefore = dump(h.db, 'sales');
    const oldStateBefore = dump(h.db, 'sale_sync_state', OLD_ROWS);

    await runOnce(h.deps);
    await runOnce(h.deps); // a second tick (retry timer) changes nothing for old rows

    expect(h.client.calls).toHaveLength(2);
    expect(sentSaleIds(h)).toEqual([
      deriveExternalId(nn(h.deps.salesRepo.readById('new-1'))),
      deriveExternalId(nn(h.deps.salesRepo.readById('new-2'))),
    ]);
    expect(nn(h.stateRepo.read('new-1')).sync_status).toBe('synced');
    expect(nn(h.stateRepo.read('new-2')).sync_status).toBe('synced');
    // Held: never sent, never deleted, never mutated.
    expect(h.stateRepo.read('old-1')).toBeNull();
    expect(dump(h.db, 'sale_sync_state', OLD_ROWS)).toEqual(oldStateBefore);
    expect(dump(h.db, 'sale_sync_outbox')).toEqual(outboxBefore);
    expect(dump(h.db, 'sales')).toEqual(salesBefore);
    expect(h.stateRepo.readSyncStatus(SCOPE_NEW)).toMatchObject({
      pending: 0,
      heldPreviousPairing: 2,
    });
    h.db.close();
  });

  it('an unpaired / invalid terminal (resolver → null) POSTs nothing and writes nothing', async () => {
    const h = engineHarness(() => null);
    seedRepairedTerminal(h.db);
    const stateBefore = dump(h.db, 'sale_sync_state');
    await runOnce(h.deps);
    expect(h.client.calls).toEqual([]);
    expect(dump(h.db, 'sale_sync_state')).toEqual(stateBefore);
    h.db.close();
  });

  it('accepts an async resolver (the live pairing status is read asynchronously)', async () => {
    const h = engineHarness(() => Promise.resolve(NEW_TERMINAL));
    seedRepairedTerminal(h.db);
    await runOnce(h.deps);
    expect(h.client.calls).toHaveLength(2);
    h.db.close();
  });

  it('re-resolves the terminal every tick: a re-pair between ticks holds the earlier rows', async () => {
    let current: string | null = OLD_TERMINAL;
    let clock = NOW;
    const h = engineHarness(
      () => current,
      [{ kind: 'no_connection' }, { kind: 'ok', saleRef: null }],
    );
    h.deps.now = () => clock;
    // ONE engine across both ticks — the scope must not be captured at creation.
    const engine = createSaleSyncEngine(h.deps);
    const tick = async (): Promise<void> => {
      const admission = engine.runTickOnce();
      if (admission.kind === 'started') await admission.completed;
    };
    seedSaleFor(h.db, 'old-1', OLD_TERMINAL, '2026-06-07T09:00:00.000Z');
    await tick(); // old pairing: attempted, stays pending (retry)
    expect(h.client.calls).toHaveLength(1);
    const oldStateBefore = dump(h.db, 'sale_sync_state', OLD_ROWS);

    current = NEW_TERMINAL; // re-paired in-process
    clock = '2026-06-07T12:00:00.000Z'; // the old retry is long due
    seedSaleFor(h.db, 'new-1', NEW_TERMINAL, '2026-06-07T11:00:00.000Z');
    await tick();
    // Only the new pairing's sale is sent; the old retry is never re-sent.
    expect(sentSaleIds(h)).toEqual([
      deriveExternalId(nn(h.deps.salesRepo.readById('old-1'))),
      deriveExternalId(nn(h.deps.salesRepo.readById('new-1'))),
    ]);
    expect(dump(h.db, 'sale_sync_state', OLD_ROWS)).toEqual(oldStateBefore);
    h.db.close();
  });

  it('a re-pair in the middle of a drain stops before the next POST', async () => {
    // Resolved at the start of the tick, then again before each POST: the third
    // read (before new-2) sees a different pairing.
    let reads = 0;
    const h = engineHarness(() => {
      reads += 1;
      return reads <= 2 ? NEW_TERMINAL : 'term-newer';
    });
    seedSaleFor(h.db, 'new-1', NEW_TERMINAL, '2026-06-07T10:00:00.000Z');
    seedSaleFor(h.db, 'new-2', NEW_TERMINAL, '2026-06-07T10:01:00.000Z');
    await runOnce(h.deps);
    expect(h.client.calls).toHaveLength(1);
    expect(nn(h.stateRepo.read('new-1')).sync_status).toBe('synced');
    expect(h.stateRepo.read('new-2')).toBeNull();
    h.db.close();
  });

  it('a resolver that throws fails closed: nothing is POSTed', async () => {
    const h = engineHarness(() => {
      throw new Error('pairing store unavailable');
    });
    seedRepairedTerminal(h.db);
    // RT-224 step 2 (Codex P2 on #547): a throwing dependency never aborts the
    // tick — it resolves, sends nothing, and reports the failure once.
    const failures: unknown[][] = [];
    const engine = createSaleSyncEngine({
      ...h.deps,
      onDependencyFailure: (...args: unknown[]) => failures.push(args),
    });
    const first = engine.runTickOnce();
    expect(first.kind).toBe('started');
    if (first.kind === 'started') await expect(first.completed).resolves.toBeUndefined();
    expect(h.client.calls).toEqual([]);
    expect(failures).toEqual([[]]);
    // The engine is not wedged: the next tick is admitted.
    const second = engine.runTickOnce();
    expect(second.kind).toBe('started');
    if (second.kind === 'started') await second.completed.catch(() => undefined);
    h.db.close();
  });
});
