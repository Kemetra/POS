/**
 * RT-224 (interim visibility, owner comment 10889) — the sale-sync pause is visible.
 *
 * When the current session holds no sale credential (no session, or a cashier
 * session whose envelope is '' — today every cashier session), the engine pauses
 * the drain. Before RT-224 it did so silently: no log, no status. Now:
 *
 *   • the engine reports a pause TRANSITION once when it enters the paused state
 *     and once when it resumes — never on every 5-second tick;
 *   • the log line is the closed-set `sale_sync:paused_no_operator_credential`
 *     (and a matching `sale_sync:resumed_operator_credential`), whose payload is
 *     the allowlist { reason, pending } only — no token, no envelope, no ids, no PII;
 *   • the status surface carries an additive `paused` field:
 *     'no_operator_credential' while no credential is held, null once one is.
 */
import { Writable } from 'node:stream';

import pino from 'pino';
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
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import {
  createSaleSyncEngine,
  logSaleSyncPauseTransition,
  SALE_SYNC_PAUSED_LOG,
  SALE_SYNC_RESUMED_LOG,
  type SaleSyncEngine,
  type SaleSyncEngineDeps,
  type SaleSyncPauseTransition,
} from '../sale-sync-engine.js';
import { createSaleSyncStatusReader } from '../sale-sync-status-reader.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'term-1';
const SECRET_ENVELOPE = 'pos-operator-envelope-SECRET-abc123';

interface Harness {
  engine: SaleSyncEngine;
  deps: SaleSyncEngineDeps;
  events: SaleSyncPauseTransition[];
  client: ReturnType<typeof createFakeSaleSyncClient>;
  stateRepo: ReturnType<typeof createSaleSyncStateRepo>;
  setToken: (token: string | null) => void;
  db: ReturnType<typeof freshSalesSyncDb>;
}

/** One engine instance whose credential can change between ticks. */
function harness(initialToken: string | null, saleIds: string[] = []): Harness {
  const db = freshSalesSyncDb();
  for (const id of saleIds) {
    seedSale(db, { sale_id: id });
    seedOutbox(db, { sale_id: id });
  }
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient(saleIds.map(() => ({ kind: 'ok', saleRef: null })));
  const events: SaleSyncPauseTransition[] = [];
  let token = initialToken;
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: TENANT,
    branchId: BRANCH,
    resolveTerminalId: () => TERMINAL,
    getOperatorToken: () => token,
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onPauseTransition: (event) => events.push(event),
  };
  return {
    engine: createSaleSyncEngine(deps),
    deps,
    events,
    client,
    stateRepo,
    setToken: (next) => {
      token = next;
    },
    db,
  };
}

async function tick(engine: SaleSyncEngine): Promise<void> {
  const admission = engine.runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

async function ticks(engine: SaleSyncEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick(engine);
}

describe('RT-224 — the engine reports a pause transition once, not every tick', () => {
  it('no credential: one paused event across many ticks, carrying the pending count', async () => {
    const h = harness(null, ['sale-1', 'sale-2']);
    await ticks(h.engine, 12);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 2 },
    ]);
    expect(h.client.calls).toHaveLength(0);
    h.db.close();
  });

  it("a cashier session's '' envelope is a paused state too (RT-224 defect 1)", async () => {
    const h = harness('', ['sale-1']);
    await ticks(h.engine, 5);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 1 },
    ]);
    expect(h.client.calls).toHaveLength(0);
    h.db.close();
  });

  it('resume: one resumed event when a credential returns, then the queue drains', async () => {
    const h = harness(null, ['sale-1', 'sale-2']);
    await ticks(h.engine, 3);
    h.setToken(SECRET_ENVELOPE);
    await ticks(h.engine, 6);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 2 },
      { transition: 'resumed', reason: 'no_operator_credential', pending: 2 },
    ]);
    expect(h.client.calls).toHaveLength(2);
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });

  it('each later transition is reported once more (paused → resumed → paused)', async () => {
    const h = harness(null);
    await ticks(h.engine, 3);
    h.setToken(SECRET_ENVELOPE);
    await ticks(h.engine, 3);
    h.setToken('');
    await ticks(h.engine, 3);
    expect(h.events.map((e) => e.transition)).toEqual(['paused', 'resumed', 'paused']);
    h.db.close();
  });

  it('a credential present from the start never reports a pause or a resume', async () => {
    const h = harness(SECRET_ENVELOPE, ['sale-1']);
    await ticks(h.engine, 5);
    expect(h.events).toEqual([]);
    expect(h.client.calls).toHaveLength(1);
    h.db.close();
  });

  it('losing the credential mid-drain reports the pause once and sends no more', async () => {
    const h = harness(SECRET_ENVELOPE, ['sale-1', 'sale-2']);
    // The first POST succeeds, then the session ends before the next one.
    const postSale = h.client.postSale.bind(h.client);
    h.client.postSale = async (payload) => {
      const result = await postSale(payload);
      h.setToken(null);
      return result;
    };
    await ticks(h.engine, 4);
    expect(h.client.calls).toHaveLength(1);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 1 },
    ]);
    h.db.close();
  });

  it('the event carries only { transition, reason, pending } — no token, no ids', async () => {
    const h = harness(null, ['sale-1']);
    await ticks(h.engine, 2);
    h.setToken(SECRET_ENVELOPE);
    await ticks(h.engine, 2);
    for (const event of h.events) {
      expect(Object.keys(event).sort()).toEqual(['pending', 'reason', 'transition']);
    }
    const serialized = JSON.stringify(h.events);
    for (const forbidden of [SECRET_ENVELOPE, 'sale-1', TENANT, BRANCH, TERMINAL]) {
      expect(serialized).not.toContain(forbidden);
    }
    h.db.close();
  });
});

/** A real pino logger writing JSON lines into memory. */
function memoryLogger(): { logger: pino.Logger; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino({ base: null, timestamp: false }, sink);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('RT-224 — the pause log line', () => {
  it('paused → warn `sale_sync:paused_no_operator_credential` with { reason, pending } only', () => {
    const { logger, lines } = memoryLogger();
    logSaleSyncPauseTransition(logger, {
      transition: 'paused',
      reason: 'no_operator_credential',
      pending: 3,
    });
    expect(SALE_SYNC_PAUSED_LOG).toBe('sale_sync:paused_no_operator_credential');
    expect(lines()).toEqual([
      { level: 40, msg: SALE_SYNC_PAUSED_LOG, reason: 'no_operator_credential', pending: 3 },
    ]);
  });

  it('resumed → info `sale_sync:resumed_operator_credential` with { reason, pending } only', () => {
    const { logger, lines } = memoryLogger();
    logSaleSyncPauseTransition(logger, {
      transition: 'resumed',
      reason: 'no_operator_credential',
      pending: 0,
    });
    expect(SALE_SYNC_RESUMED_LOG).toBe('sale_sync:resumed_operator_credential');
    expect(lines()).toEqual([
      { level: 30, msg: SALE_SYNC_RESUMED_LOG, reason: 'no_operator_credential', pending: 0 },
    ]);
  });

  it('copies only the allowlisted fields, whatever else the event object carries', () => {
    const { logger, lines } = memoryLogger();
    const polluted = {
      transition: 'paused',
      reason: 'no_operator_credential',
      pending: 1,
      token: SECRET_ENVELOPE,
      pos_operator_envelope: SECRET_ENVELOPE,
      sale_id: 'sale-1',
    } as unknown as SaleSyncPauseTransition;
    logSaleSyncPauseTransition(logger, polluted);
    const [line] = lines();
    expect(Object.keys(nn(line)).sort()).toEqual(['level', 'msg', 'pending', 'reason']);
    expect(JSON.stringify(lines())).not.toContain(SECRET_ENVELOPE);
  });

  it('engine + log: many ticks write exactly one paused and one resumed line, never the envelope', async () => {
    const { logger, lines } = memoryLogger();
    const h = harness(null, ['sale-1']);
    const engine = createSaleSyncEngine({
      ...h.deps,
      onPauseTransition: (event) => {
        logSaleSyncPauseTransition(logger, event);
      },
    });
    await ticks(engine, 10);
    h.setToken(SECRET_ENVELOPE);
    await ticks(engine, 10);
    const msgs = lines().map((l) => l['msg']);
    expect(msgs).toEqual([SALE_SYNC_PAUSED_LOG, SALE_SYNC_RESUMED_LOG]);
    const serialized = JSON.stringify(lines()).toLowerCase();
    expect(serialized).not.toContain(SECRET_ENVELOPE.toLowerCase());
    for (const forbidden of ['envelope', 'authorization', 'bearer', 'token', 'sale-1']) {
      expect(serialized).not.toContain(forbidden);
    }
    h.db.close();
  });
});

describe('RT-224 — the status surface shows the pause', () => {
  function reader(h: Harness) {
    return createSaleSyncStatusReader({
      stateRepo: h.stateRepo,
      tenantId: TENANT,
      branchId: BRANCH,
      resolveTerminalId: () => TERMINAL,
      pausedReason: () => h.engine.pausedReason(),
    });
  }

  it("paused = 'no_operator_credential' while no credential is held", async () => {
    const h = harness(null, ['sale-1']);
    const status = await reader(h)();
    expect(status.paused).toBe('no_operator_credential');
    // The existing fields keep their meaning.
    expect(status).toEqual({
      pending: 1,
      heldPreviousPairing: 0,
      deadLetter: 0,
      payloadDivergence: 0,
      lastSuccessAt: null,
      paused: 'no_operator_credential',
    });
    h.db.close();
  });

  it("a cashier session's '' envelope reads as paused", async () => {
    const h = harness('', ['sale-1']);
    expect((await reader(h)()).paused).toBe('no_operator_credential');
    h.db.close();
  });

  it('paused = null once a credential is held — read live, not from the last tick', async () => {
    const h = harness(null, ['sale-1']);
    const read = reader(h);
    await ticks(h.engine, 2);
    expect((await read()).paused).toBe('no_operator_credential');
    h.setToken(SECRET_ENVELOPE);
    // No tick has run since the credential arrived: the status is still truthful.
    expect((await read()).paused).toBeNull();
    h.setToken(null);
    expect((await read()).paused).toBe('no_operator_credential');
    h.db.close();
  });

  it('the status carries no credential', async () => {
    const h = harness(SECRET_ENVELOPE, ['sale-1']);
    const status = await reader(h)();
    expect(JSON.stringify(status)).not.toContain(SECRET_ENVELOPE);
    expect(status.paused).toBeNull();
    h.db.close();
  });
});
