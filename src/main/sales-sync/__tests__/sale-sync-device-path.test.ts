/**
 * RT-224 step 2 — POS adoption of Option B (device-bearer sale capture with
 * server-verified cashier attribution; Backend-Core #709, `sales.yaml` 1.5.0-draft).
 *
 * Every queued sale has exactly ONE credential, chosen per sale, never from the
 * current session:
 *   • the sale's own `payment.settled` payload carries `selling_user_id` → the
 *     device bearer + `operatorUserId = selling_user_id` (`postSaleAsCashier`),
 *     ALWAYS — even while a manager envelope is held, so the cashier who rang the
 *     sale up is the one credited;
 *   • no `selling_user_id` (a manager/admin sale, or a sale finalized before this
 *     change) → the operator envelope exactly as before (`postSale`); it waits,
 *     untouched, while no envelope is held. It is never dead-lettered for that,
 *     and it never blocks the cashier sales queued behind it.
 *
 * The drain pauses (`no_operator_credential`, reported once per transition) only
 * when it holds NEITHER an envelope NOR a device credential.
 *
 * Device-path outcomes:
 *   • 403 `refused` → that sale alone is dead-lettered (`cashier_claim_refused`);
 *     never device-revoked, never a pause, the next sale is still sent;
 *   • 401 → the sale stays queued (transient backoff); the device path is not
 *     used again in that tick; `onDeviceUnauthorized` fires once per episode.
 *     Revocation itself belongs to RT-215's detector, not to the drain.
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
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import {
  createSaleSyncEngine,
  type SaleSyncEngine,
  type SaleSyncEngineDeps,
  type SaleSyncPauseTransition,
} from '../sale-sync-engine.js';
import {
  createSellingUserIdResolver,
  type SellingUserIdResolver,
  type SellingUserUnresolved,
} from '../selling-user-id.js';
import type { DatabaseHandle } from '../../db/client.js';
import { createSaleSyncStatusReader } from '../sale-sync-status-reader.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'term-1';
const ENVELOPE = 'pos-operator-envelope-SECRET-abc123';
const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const USER_B = '0190a3c4-0000-7000-8000-00000000000b';

/** A queued sale: `user` = its stored selling_user_id; omitted = a legacy/manager sale. */
interface QueuedSale {
  id: string;
  user?: string;
  enqueuedAt?: string;
}

interface Harness {
  engine: SaleSyncEngine;
  deps: SaleSyncEngineDeps;
  client: ReturnType<typeof createFakeSaleSyncClient>;
  stateRepo: ReturnType<typeof createSaleSyncStateRepo>;
  events: SaleSyncPauseTransition[];
  deadLetters: Array<{ saleId: string; reason: string | undefined }>;
  unauthorized: number[];
  unresolved: SellingUserUnresolved[];
  /** Sale ids the engine told the resolver to forget (rev547 F7). */
  forgotten: string[];
  setEnvelope: (token: string | null) => void;
  setDevice: (available: boolean) => void;
  db: ReturnType<typeof freshSalesSyncDb>;
}

/** Seed each queued sale: the durable Sale, its outbox row and its settled row. */
function seedQueue(db: ReturnType<typeof freshSalesSyncDb>, sales: QueuedSale[]): void {
  sales.forEach((s, i) => {
    seedSale(db, { sale_id: s.id });
    seedOutbox(db, {
      sale_id: s.id,
      enqueued_at: s.enqueuedAt ?? `2026-06-07T10:00:0${String(i)}.000Z`,
    });
    seedSettled(db, {
      sale_id: s.id,
      ...(s.user === undefined ? {} : { selling_user_id: s.user }),
    });
  });
}

/** A handle that counts executions of statements reading `audit_events` (Codex P2). */
function countingAuditHandle(handle: DatabaseHandle): { db: DatabaseHandle; count: () => number } {
  let auditQueries = 0;
  const db: DatabaseHandle = {
    ...handle,
    prepare: (sql: string) => {
      const stmt = handle.prepare(sql) as { all: (...p: unknown[]) => unknown };
      if (!sql.includes('audit_events')) return stmt;
      return {
        all: (...p: unknown[]) => {
          auditQueries += 1;
          return stmt.all(...p);
        },
      };
    },
  };
  return { db, count: () => auditQueries };
}

/** The real resolver, recording the sales the engine tells it to forget (rev547 F7). */
function spyingResolver(db: DatabaseHandle) {
  const forgotten: string[] = [];
  const unresolved: SellingUserUnresolved[] = [];
  const resolver = createSellingUserIdResolver({
    db,
    onUnresolved: (info) => unresolved.push(info),
  });
  const sellingUsers: SellingUserIdResolver = {
    resolve: (sales, terminalId) => resolver.resolve(sales, terminalId),
    forget: (saleId) => {
      forgotten.push(saleId);
      resolver.forget(saleId);
    },
  };
  return { sellingUsers, forgotten, unresolved };
}

function harness(opts: {
  sales: QueuedSale[];
  envelope?: string | null;
  device?: boolean;
  script?: SaleSyncResult[];
}): Harness & { auditQueries: () => number } {
  const db = freshSalesSyncDb();
  seedQueue(db, opts.sales);
  const handle = handleFor(db);
  const audit = countingAuditHandle(handle);
  const spy = spyingResolver(audit.db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient(opts.script ?? [{ kind: 'ok', saleRef: null }]);
  const events: SaleSyncPauseTransition[] = [];
  const deadLetters: Array<{ saleId: string; reason: string | undefined }> = [];
  const unauthorized: number[] = [];
  let envelope = opts.envelope ?? null;
  let device = opts.device ?? true;
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: TENANT,
    branchId: BRANCH,
    resolveTerminalId: () => TERMINAL,
    getOperatorToken: () => envelope,
    hasDeviceCredential: () => Promise.resolve(device),
    sellingUsers: spy.sellingUsers,
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onPauseTransition: (event) => events.push(event),
    onDeadLetter: (saleId, reason) => deadLetters.push({ saleId, reason }),
    onDeviceUnauthorized: () => unauthorized.push(1),
  };
  return {
    engine: createSaleSyncEngine(deps),
    deps,
    client,
    stateRepo,
    events,
    deadLetters,
    unauthorized,
    unresolved: spy.unresolved,
    setEnvelope: (t) => {
      envelope = t;
    },
    setDevice: (d) => {
      device = d;
    },
    db,
    forgotten: spy.forgotten,
    auditQueries: audit.count,
  };
}

async function tick(engine: SaleSyncEngine): Promise<void> {
  const admission = engine.runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

async function ticks(engine: SaleSyncEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick(engine);
}

const sentAsCashier = (h: Harness): Array<[string, string]> =>
  h.client.cashierCalls.map((c) => [c.payload.externalId, c.operatorUserId]);

describe('RT-224 step 2 — credential per sale', () => {
  it('a paired till with no session sends a cashier sale with the device bearer + that sale’s own user', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null });
    await tick(h.engine);
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-1', USER_A]]);
    expect(h.client.calls).toHaveLength(0);
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });

  it('each sale carries its OWN cashier, not the latest one (two cashiers, one queue)', async () => {
    const h = harness({
      sales: [
        { id: 'sale-a', user: USER_A },
        { id: 'sale-b', user: USER_B },
        { id: 'sale-c', user: USER_A },
      ],
    });
    await tick(h.engine);
    expect(sentAsCashier(h)).toEqual([
      ['pos-pulse:handoff-sale-a', USER_A],
      ['pos-pulse:handoff-sale-b', USER_B],
      ['pos-pulse:handoff-sale-c', USER_A],
    ]);
    h.db.close();
  });

  it('a cashier sale goes on the device path even while a manager envelope is held', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: ENVELOPE });
    await tick(h.engine);
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-1', USER_A]]);
    expect(h.client.calls).toHaveLength(0);
    h.db.close();
  });

  it('a sale with no stored cashier goes on the envelope path, exactly as before', async () => {
    const h = harness({ sales: [{ id: 'sale-1' }], envelope: ENVELOPE });
    await tick(h.engine);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-sale-1']);
    expect(h.client.cashierCalls).toHaveLength(0);
    h.db.close();
  });

  it('a sale with no stored cashier is never sent on the device path, even with no envelope', async () => {
    const h = harness({ sales: [{ id: 'sale-1' }], envelope: null, device: true });
    await ticks(h.engine, 4);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.client.calls).toHaveLength(0);
    // Untouched: not attempted, not dead-lettered — it waits for an envelope.
    expect(h.stateRepo.read('sale-1')).toBeNull();
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('a waiting legacy sale does not block the cashier sales queued behind it', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }, { id: 'sale-a', user: USER_A }, { id: 'sale-b', user: USER_B }],
      envelope: null,
    });
    await tick(h.engine);
    expect(sentAsCashier(h).map(([id]) => id)).toEqual([
      'pos-pulse:handoff-sale-a',
      'pos-pulse:handoff-sale-b',
    ]);
    expect(h.stateRepo.read('legacy-1')).toBeNull();
    // A manager signs in later: the legacy sale then goes on the envelope path.
    h.setEnvelope(ENVELOPE);
    await tick(h.engine);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    expect(nn(h.stateRepo.read('legacy-1')).sync_status).toBe('synced');
    h.db.close();
  });

  it('rev547 F4b: a sale whose cashier cannot be proven (two settled rows with the key) is HELD, never sent under the envelope', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null });
    seedSettled(h.db, { sale_id: 'sale-1', selling_user_id: USER_B });
    await ticks(h.engine, 3);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.unresolved).toEqual([{ saleId: 'sale-1', reason: 'multiple_settled_events' }]);
    h.setEnvelope(ENVELOPE);
    await ticks(h.engine, 3);
    expect(h.client.calls).toHaveLength(0);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.stateRepo.read('sale-1')).toBeNull();
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('rev547 F4b: a malformed selling_user_id is HELD even with an envelope; the sales behind it still go', async () => {
    const h = harness({
      sales: [
        { id: 'sale-bad', user: 'not-a-uuid' },
        { id: 'sale-1', user: USER_A },
        { id: 'legacy-1' },
      ],
      envelope: ENVELOPE,
    });
    await tick(h.engine);
    expect(h.unresolved).toEqual([{ saleId: 'sale-bad', reason: 'malformed_selling_user_id' }]);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    expect(h.client.cashierCalls.map((c) => c.payload.externalId)).toEqual([
      'pos-pulse:handoff-sale-1',
    ]);
    expect(h.stateRepo.read('sale-bad')).toBeNull();
    h.db.close();
  });

  it('the device-path payload is the same capture payload the envelope path would send', async () => {
    const dev = harness({ sales: [{ id: 'sale-1', user: USER_A }] });
    await tick(dev.engine);
    const env = harness({ sales: [{ id: 'sale-1' }], envelope: ENVELOPE });
    await tick(env.engine);
    expect(nn(dev.client.cashierCalls[0]).payload).toEqual(nn(env.client.calls[0]));
    dev.db.close();
    env.db.close();
  });
});

describe('RT-224 step 2 — the pause signal', () => {
  it('no envelope but a device credential: never paused, no pause event', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null, device: true });
    await ticks(h.engine, 3);
    expect(h.events).toEqual([]);
    expect(await h.engine.pausedReason()).toBeNull();
    const status = await createSaleSyncStatusReader({
      stateRepo: h.stateRepo,
      tenantId: TENANT,
      branchId: BRANCH,
      resolveTerminalId: () => TERMINAL,
      pausedReason: () => h.engine.pausedReason(),
    })();
    expect(status.paused).toBeNull();
    h.db.close();
  });

  it('neither an envelope nor a device credential: paused once, nothing sent (cashier sales included)', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }, { id: 'sale-2' }],
      envelope: null,
      device: false,
    });
    await ticks(h.engine, 6);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 2 },
    ]);
    expect(await h.engine.pausedReason()).toBe('no_operator_credential');
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.client.calls).toHaveLength(0);
    h.db.close();
  });

  it('the device credential returning resumes the drain once and sends the cashier sale', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null, device: false });
    await ticks(h.engine, 3);
    h.setDevice(true);
    await ticks(h.engine, 3);
    expect(h.events.map((e) => e.transition)).toEqual(['paused', 'resumed']);
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-1', USER_A]]);
    h.db.close();
  });

  it('a cashier sale with no device credential waits even while an envelope is held', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }],
      envelope: ENVELOPE,
      device: false,
    });
    await ticks(h.engine, 3);
    expect(h.client.calls).toHaveLength(0);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.stateRepo.read('sale-1')).toBeNull();
    h.db.close();
  });
});

describe('RT-224 step 2 — device-path outcomes', () => {
  it('403 refused dead-letters that sale alone; the next sale is still sent; no pause, no revocation', async () => {
    const h = harness({
      sales: [
        { id: 'sale-1', user: USER_A },
        { id: 'sale-2', user: USER_B },
      ],
      script: [{ kind: 'refused' }, { kind: 'ok', saleRef: null }],
    });
    await tick(h.engine);
    const refused = nn(h.stateRepo.read('sale-1'));
    expect(refused.sync_status).toBe('dead_letter');
    expect(refused.last_error_category).toBe('cashier_claim_refused');
    expect(h.deadLetters).toEqual([{ saleId: 'sale-1', reason: 'cashier_claim_refused' }]);
    expect(nn(h.stateRepo.read('sale-2')).sync_status).toBe('synced');
    expect(h.unauthorized).toEqual([]);
    expect(h.events).toEqual([]);
    expect(await h.engine.pausedReason()).toBeNull();
    // Terminal: never retried.
    await ticks(h.engine, 3);
    expect(h.client.cashierCalls).toHaveLength(2);
    h.db.close();
  });

  it('401 keeps the sale queued with a backoff and stops the device path for the rest of the tick', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }, { id: 'sale-2', user: USER_B }, { id: 'legacy-1' }],
      envelope: ENVELOPE,
      script: [{ kind: 'device_unauthorized' }, { kind: 'ok', saleRef: null }],
    });
    await tick(h.engine);
    const first = nn(h.stateRepo.read('sale-1'));
    expect(first.sync_status).toBe('pending');
    expect(first.attempt_count).toBe(1);
    expect(first.last_error_category).toBe('device_unauthorized');
    expect(first.next_retry_at).toBe('2026-06-07T10:05:01.000Z');
    // sale-2 is not tried on the device path this tick …
    expect(h.client.cashierCalls).toHaveLength(1);
    expect(h.stateRepo.read('sale-2')).toBeNull();
    // … but the envelope path still runs.
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    expect(h.unauthorized).toEqual([1]);
    expect(h.deadLetters).toEqual([]);
    expect(h.events).toEqual([]);
    h.db.close();
  });

  it('onDeviceUnauthorized fires once per episode, and again only after a device-path answer that is not 401', async () => {
    const h = harness({
      sales: [
        { id: 'sale-1', user: USER_A },
        { id: 'sale-2', user: USER_A },
      ],
      script: [
        { kind: 'device_unauthorized' }, // tick 1: sale-1 (episode starts → 1 report)
        { kind: 'device_unauthorized' }, // tick 2: sale-1 again (same episode → silent)
        { kind: 'ok', saleRef: null }, // tick 3: sale-1 accepted (episode over)
        { kind: 'device_unauthorized' }, // tick 3: sale-2 (new episode → 1 report)
      ],
    });
    let clock = Date.parse('2026-06-07T10:05:00.000Z');
    const engine = createSaleSyncEngine({
      ...h.deps,
      now: () => new Date(clock).toISOString(),
    });
    await tick(engine);
    expect(h.unauthorized).toEqual([1]);
    clock += 10 * 60 * 1000; // past any backoff
    await tick(engine);
    expect(h.unauthorized).toEqual([1]);
    clock += 10 * 60 * 1000;
    await tick(engine);
    expect(h.client.cashierCalls.map((c) => c.payload.externalId)).toEqual([
      'pos-pulse:handoff-sale-1',
      'pos-pulse:handoff-sale-1',
      'pos-pulse:handoff-sale-1',
      'pos-pulse:handoff-sale-2',
    ]);
    expect(h.unauthorized).toEqual([1, 1]);
    h.db.close();
  });

  it('a device-path no_connection (no answer) neither ends nor restarts a 401 episode', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }],
      script: [
        { kind: 'device_unauthorized' },
        { kind: 'no_connection' },
        { kind: 'device_unauthorized' },
      ],
    });
    let clock = Date.parse('2026-06-07T10:05:00.000Z');
    const engine = createSaleSyncEngine({ ...h.deps, now: () => new Date(clock).toISOString() });
    for (let i = 0; i < 3; i += 1) {
      await tick(engine);
      clock += 10 * 60 * 1000; // past any backoff
    }
    expect(h.client.cashierCalls).toHaveLength(3);
    expect(h.unauthorized).toEqual([1]);
    h.db.close();
  });

  it('a 401 never pauses the drain and never dead-letters', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }],
      script: [{ kind: 'device_unauthorized' }],
    });
    await tick(h.engine);
    expect(await h.engine.pausedReason()).toBeNull();
    expect(h.events).toEqual([]);
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('400 / 409 / transient on the device path keep their existing handling', async () => {
    const h = harness({
      sales: [
        { id: 'sale-1', user: USER_A },
        { id: 'sale-2', user: USER_A },
        { id: 'sale-3', user: USER_A },
      ],
      script: [
        { kind: 'permanent' },
        { kind: 'divergent', errorCode: 'idempotency_key_conflict' },
        { kind: 'transient', retryAfterMs: 2000 },
      ],
    });
    await tick(h.engine);
    expect(nn(h.stateRepo.read('sale-1')).last_error_category).toBe('permanent');
    expect(nn(h.stateRepo.read('sale-2')).last_error_category).toBe('payload_divergence');
    const third = nn(h.stateRepo.read('sale-3'));
    expect(third.sync_status).toBe('pending');
    expect(third.last_error_category).toBe('transient');
    expect(third.next_retry_at).toBe('2026-06-07T10:05:02.000Z');
    h.db.close();
  });

  it('hooks never receive the cashier id or the envelope', async () => {
    const h = harness({
      sales: [
        { id: 'sale-1', user: USER_A },
        { id: 'sale-2', user: USER_B },
      ],
      envelope: ENVELOPE,
      script: [{ kind: 'refused' }, { kind: 'device_unauthorized' }],
    });
    await tick(h.engine);
    const seen = JSON.stringify([h.deadLetters, h.unauthorized, h.events, h.unresolved]);
    for (const secret of [USER_A, USER_B, ENVELOPE]) expect(seen).not.toContain(secret);
    h.db.close();
  });
});

describe('RT-224 step 2 (Codex P2) — the audit log is read once per batch, not per sale', () => {
  it('a tick over many cashier sales runs ONE audit_events query', async () => {
    const sales = Array.from({ length: 40 }, (_, i) => ({
      id: `sale-${String(i).padStart(2, '0')}`,
      user: i % 2 === 0 ? USER_A : USER_B,
      enqueuedAt: `2026-06-07T10:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    const h = harness({ sales });
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(40);
    expect(h.auditQueries()).toBe(1);
    h.db.close();
  });

  it('a retried sale is not looked up again; a waiting legacy sale is not re-scanned each tick', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }, { id: 'sale-1', user: USER_A }],
      envelope: null,
      script: [{ kind: 'transient' }, { kind: 'ok', saleRef: null }],
    });
    let clock = Date.parse('2026-06-07T10:05:00.000Z');
    const engine = createSaleSyncEngine({ ...h.deps, now: () => new Date(clock).toISOString() });
    for (let i = 0; i < 4; i += 1) {
      await tick(engine);
      clock += 10 * 60 * 1000; // past any backoff
    }
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    expect(h.stateRepo.read('legacy-1')).toBeNull();
    expect(h.auditQueries()).toBe(1);
    h.db.close();
  });
});

describe('RT-224 step 2 (Codex P2) — a device-credential read failure never aborts the drain', () => {
  it('hasDeviceCredential rejecting: the envelope sale still goes out, the cashier sale waits', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }, { id: 'legacy-1' }],
      envelope: ENVELOPE,
    });
    const engine = createSaleSyncEngine({
      ...h.deps,
      hasDeviceCredential: () => Promise.reject(new Error('DPAPI failure')),
    });
    await expect(tick(engine)).resolves.toBeUndefined();
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.stateRepo.read('sale-1')).toBeNull();
    await expect(engine.pausedReason()).resolves.toBeNull();
    h.db.close();
  });

  it('hasDeviceCredential throwing with no envelope: paused, and pausedReason resolves', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null });
    const engine = createSaleSyncEngine({
      ...h.deps,
      hasDeviceCredential: () => {
        throw new Error('keychain unavailable');
      },
    });
    await expect(tick(engine)).resolves.toBeUndefined();
    await expect(engine.pausedReason()).resolves.toBe('no_operator_credential');
    expect(h.events.map((e) => e.transition)).toEqual(['paused']);
    h.db.close();
  });
});

describe('rev547 F1 — the pause stays visible for sales that need an envelope', () => {
  it('upgrade with a legacy queue on a cashier-only day: cashier sales flow, the pause is logged once (envelope subset), resume once', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }, { id: 'legacy-2' }, { id: 'sale-a', user: USER_A }],
      envelope: null,
      device: true,
    });
    await ticks(h.engine, 4);
    // The cashier sale went out on the device path …
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-a', USER_A]]);
    // … while the two envelope-routed sales are blocked: ONE pause, counting them only.
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 2 },
    ]);
    expect(await h.engine.pausedReason()).toBe('no_operator_credential');
    const status = await createSaleSyncStatusReader({
      stateRepo: h.stateRepo,
      tenantId: TENANT,
      branchId: BRANCH,
      resolveTerminalId: () => TERMINAL,
      pausedReason: () => h.engine.pausedReason(),
    })();
    expect(status.paused).toBe('no_operator_credential');
    // A manager signs in: resumed once, the legacy sales drain.
    h.setEnvelope(ENVELOPE);
    expect(await h.engine.pausedReason()).toBeNull();
    await ticks(h.engine, 3);
    expect(h.events).toEqual([
      { transition: 'paused', reason: 'no_operator_credential', pending: 2 },
      { transition: 'resumed', reason: 'no_operator_credential', pending: 2 },
    ]);
    expect(h.client.calls.map((p) => p.externalId)).toEqual([
      'pos-pulse:handoff-legacy-1',
      'pos-pulse:handoff-legacy-2',
    ]);
    // The manager signs out with nothing envelope-routed left: no pause.
    h.setEnvelope(null);
    await ticks(h.engine, 2);
    expect(h.events.map((e) => e.transition)).toEqual(['paused', 'resumed']);
    expect(await h.engine.pausedReason()).toBeNull();
    h.db.close();
  });

  it('a cashier-only queue with a device credential never pauses', async () => {
    const h = harness({
      sales: [
        { id: 'sale-a', user: USER_A },
        { id: 'sale-b', user: USER_B },
      ],
      envelope: null,
    });
    await ticks(h.engine, 3);
    expect(h.events).toEqual([]);
    expect(await h.engine.pausedReason()).toBeNull();
    h.db.close();
  });

  it('a held sale (unprovable cashier) does not count as waiting for an envelope', async () => {
    const h = harness({ sales: [{ id: 'sale-bad', user: 'not-a-uuid' }], envelope: null });
    await ticks(h.engine, 3);
    expect(h.events).toEqual([]);
    expect(await h.engine.pausedReason()).toBeNull();
    h.db.close();
  });
});

describe('rev547 F6 — a failing selling-user lookup holds that batch only', () => {
  it('a lookup that throws: no send this tick (never the envelope), the tick resolves; the next tick sends', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', user: USER_A }, { id: 'legacy-1' }],
      envelope: ENVELOPE,
    });
    let failing = true;
    const engine = createSaleSyncEngine({
      ...h.deps,
      sellingUsers: {
        resolve: (sales, terminalId) => {
          if (failing) throw new Error('SQLITE_ERROR: malformed JSON');
          return nn(h.deps.sellingUsers).resolve(sales, terminalId);
        },
        forget: (saleId) => {
          nn(h.deps.sellingUsers).forget(saleId);
        },
      },
    });
    await expect(tick(engine)).resolves.toBeUndefined();
    expect(h.client.calls).toHaveLength(0);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.stateRepo.read('sale-1')).toBeNull();
    failing = false;
    await tick(engine);
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-1', USER_A]]);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    h.db.close();
  });
});

describe('rev547 F7 — a memoized cashier is forgotten when its sale leaves the queue', () => {
  it('synced, refused, permanent and divergent sales are forgotten; a transient one is kept', async () => {
    const h = harness({
      sales: [
        { id: 'sale-ok', user: USER_A },
        { id: 'sale-refused', user: USER_A },
        { id: 'sale-permanent', user: USER_A },
        { id: 'sale-divergent', user: USER_A },
        { id: 'sale-transient', user: USER_A },
      ],
      script: [
        { kind: 'ok', saleRef: null },
        { kind: 'refused' },
        { kind: 'permanent' },
        { kind: 'divergent', errorCode: 'idempotency_key_conflict' },
        { kind: 'transient' },
      ],
    });
    await tick(h.engine);
    expect([...h.forgotten].sort()).toEqual(
      ['sale-divergent', 'sale-ok', 'sale-permanent', 'sale-refused'].sort(),
    );
    h.db.close();
  });
});

describe('RT-224 step 2 (Codex P2 on bf5960d) — the envelope-due count follows the queue', () => {
  it('envelope sales drained mid-tick, then the envelope disappears before a later sale: no pause, no transition', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }, { id: 'sale-a', user: USER_A }],
      envelope: ENVELOPE,
    });
    // The manager signs out right after the envelope sale is captured.
    const postSale = h.client.postSale.bind(h.client);
    h.client.postSale = async (payload) => {
      const result = await postSale(payload);
      h.setEnvelope(null);
      return result;
    };
    await tick(h.engine);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-legacy-1']);
    expect(sentAsCashier(h)).toEqual([['pos-pulse:handoff-sale-a', USER_A]]);
    expect(h.events).toEqual([]);
    expect(await h.engine.pausedReason()).toBeNull();
    h.db.close();
  });

  it('a dead-lettered envelope sale leaves the count too', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }],
      envelope: ENVELOPE,
      script: [{ kind: 'permanent' }],
    });
    await tick(h.engine);
    h.setEnvelope(null);
    expect(await h.engine.pausedReason()).toBeNull();
    await tick(h.engine);
    expect(h.events).toEqual([]);
    h.db.close();
  });

  it('an envelope sale that is still queued (transient) keeps the pause visible', async () => {
    const h = harness({
      sales: [{ id: 'legacy-1' }],
      envelope: ENVELOPE,
      script: [{ kind: 'transient' }],
    });
    await tick(h.engine);
    h.setEnvelope(null);
    expect(await h.engine.pausedReason()).toBe('no_operator_credential');
    h.db.close();
  });
});
