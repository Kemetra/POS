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
import { createSellingUserIdReader, type SellingUserUnresolved } from '../selling-user-id.js';
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
  setEnvelope: (token: string | null) => void;
  setDevice: (available: boolean) => void;
  db: ReturnType<typeof freshSalesSyncDb>;
}

function harness(opts: {
  sales: QueuedSale[];
  envelope?: string | null;
  device?: boolean;
  script?: SaleSyncResult[];
}): Harness {
  const db = freshSalesSyncDb();
  opts.sales.forEach((s, i) => {
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
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient(opts.script ?? [{ kind: 'ok', saleRef: null }]);
  const events: SaleSyncPauseTransition[] = [];
  const deadLetters: Array<{ saleId: string; reason: string | undefined }> = [];
  const unauthorized: number[] = [];
  const unresolved: SellingUserUnresolved[] = [];
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
    sellingUserIdOf: createSellingUserIdReader({
      db: handle,
      onUnresolved: (info) => unresolved.push(info),
    }),
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
    unresolved,
    setEnvelope: (t) => {
      envelope = t;
    },
    setDevice: (d) => {
      device = d;
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

  it('an unresolvable sale (two settled rows) falls back to the envelope path and is reported once', async () => {
    const h = harness({ sales: [{ id: 'sale-1', user: USER_A }], envelope: null });
    seedSettled(h.db, { sale_id: 'sale-1', selling_user_id: USER_B });
    await ticks(h.engine, 3);
    expect(h.client.cashierCalls).toHaveLength(0);
    expect(h.unresolved).toEqual([{ saleId: 'sale-1', reason: 'multiple_settled_events' }]);
    h.setEnvelope(ENVELOPE);
    await tick(h.engine);
    expect(h.client.calls.map((p) => p.externalId)).toEqual(['pos-pulse:handoff-sale-1']);
    expect(h.client.cashierCalls).toHaveLength(0);
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
