/**
 * RT-224 step 2 (rev547 F2) — the composition-root wiring of the device path.
 *
 * `index.ts` only calls `composeSaleSyncDevicePath`; everything it wires is here
 * and tested: the never-reject device-token read, the per-sale cashier resolver
 * over the real `audit_events` table (each sale's OWN cashier — the wiring has no
 * access to the current session at all), and the redaction-safe log lines.
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
import { composeSaleSyncDevicePath } from '../compose-device-path.js';
import { createSaleSyncEngine } from '../sale-sync-engine.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const USER_B = '0190a3c4-0000-7000-8000-00000000000b';
const TOKEN = 'device-token-SECRET';

function memoryLogger() {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    logger: { warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }) },
  };
}

function setup(opts: { paired?: boolean; read?: () => Promise<string | null | undefined> } = {}) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const log = memoryLogger();
  const devicePath = composeSaleSyncDevicePath({
    db: handle,
    isPaired: () => Promise.resolve(opts.paired ?? true),
    readToken: opts.read ?? (() => Promise.resolve(TOKEN)),
    currentTerminalId: () => 'term-1',
    logger: log.logger,
  });
  return { db, handle, devicePath, log };
}

describe('rev547 F2 — composeSaleSyncDevicePath', () => {
  it('drives the engine so each sale goes out under its OWN cashier', async () => {
    const { db, handle, devicePath } = setup();
    for (const [n, id, user] of [
      [0, 'sale-a', USER_A],
      [1, 'sale-b', USER_B],
      [2, 'sale-c', USER_A],
    ] as const) {
      seedSale(db, { sale_id: id });
      seedOutbox(db, { sale_id: id, enqueued_at: `2026-06-07T10:00:0${String(n)}.000Z` });
      seedSettled(db, { sale_id: id, selling_user_id: user });
    }
    const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
    const engine = createSaleSyncEngine({
      client,
      stateRepo: createSaleSyncStateRepo(handle),
      salesRepo: bindSalesRepository(handle),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      resolveTerminalId: () => 'term-1',
      getOperatorToken: () => null,
      ...devicePath.engine,
      now: () => '2026-06-07T10:05:00.000Z',
      backoff: { baseMs: 1000, maxMs: 300_000 },
    });
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
    expect(client.cashierCalls.map((c) => [c.payload.externalId, c.operatorUserId])).toEqual([
      ['pos-pulse:handoff-sale-a', USER_A],
      ['pos-pulse:handoff-sale-b', USER_B],
      ['pos-pulse:handoff-sale-c', USER_A],
    ]);
    db.close();
  });

  it('the device token: paired → token; unpaired → null; a read failure → null, logged once with no data', async () => {
    const paired = setup();
    expect(await paired.devicePath.client.getDeviceToken()).toBe(TOKEN);
    expect(await nn(paired.devicePath.engine.hasDeviceCredential)()).toBe(true);
    paired.db.close();

    const unpaired = setup({ paired: false });
    expect(await unpaired.devicePath.client.getDeviceToken()).toBeNull();
    expect(await nn(unpaired.devicePath.engine.hasDeviceCredential)()).toBe(false);
    unpaired.db.close();

    const failing = setup({ read: () => Promise.reject(new Error(`DPAPI ${TOKEN}`)) });
    expect(await failing.devicePath.client.getDeviceToken()).toBeNull();
    expect(await nn(failing.devicePath.engine.hasDeviceCredential)()).toBe(false);
    expect(failing.log.lines).toEqual([{ obj: {}, msg: 'sale_sync:device_token_unreadable' }]);
    failing.db.close();
  });

  it('log lines are closed-set and carry no token, user id or envelope', () => {
    const { db, handle, devicePath, log } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: 'not-a-uuid' });
    nn(devicePath.engine.sellingUsers).resolve(
      [nn(bindSalesRepository(handle).readById('sale-1'))],
      'term-1',
    );
    nn(devicePath.engine.onDeviceUnauthorized)();
    expect(log.lines).toEqual([
      {
        obj: { sale_id: 'sale-1', reason: 'malformed_selling_user_id' },
        msg: 'sale_sync:selling_user_unresolved',
      },
      { obj: {}, msg: 'sale_sync:device_unauthorized' },
    ]);
    for (const secret of [TOKEN, USER_A]) expect(JSON.stringify(log.lines)).not.toContain(secret);
    db.close();
  });

  it('a failing lookup is logged once, closed-set', () => {
    const { db, handle, log } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    const broken = composeSaleSyncDevicePath({
      db: {
        ...handle,
        prepare: () => {
          throw new Error('SQLITE_ERROR');
        },
      },
      isPaired: () => Promise.resolve(true),
      readToken: () => Promise.resolve(TOKEN),
      currentTerminalId: () => 'term-1',
      logger: log.logger,
    });
    const sale = nn(bindSalesRepository(handle).readById('sale-1'));
    nn(broken.engine.sellingUsers).resolve([sale], 'term-1');
    nn(broken.engine.sellingUsers).resolve([sale], 'term-1');
    expect(log.lines).toEqual([{ obj: {}, msg: 'sale_sync:selling_user_lookup_failed' }]);
    db.close();
  });
});

describe('RT-224 (Codex P2 on 0020877) — a re-pair during the token read never sends the old sale', () => {
  it('real client + composed wiring: no request, the sale stays pending (not dead-lettered), logged once', async () => {
    const db = freshSalesSyncDb();
    const handle = handleFor(db);
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    let terminal = 'term-1';
    let release!: (token: string) => void;
    let tokenReadStarted = false;
    const log = memoryLogger();
    const devicePath = composeSaleSyncDevicePath({
      db: handle,
      isPaired: () => Promise.resolve(true),
      readToken: () => {
        tokenReadStarted = true;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      currentTerminalId: () => terminal,
      logger: log.logger,
    });
    const requests: unknown[] = [];
    const client = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: (input) => {
        requests.push(input);
        return Promise.resolve(new Response('{}', { status: 201 }));
      },
      getOperatorToken: () => null,
      ...devicePath.client,
    });
    const stateRepo = createSaleSyncStateRepo(handle);
    const engine = createSaleSyncEngine({
      client,
      stateRepo,
      salesRepo: bindSalesRepository(handle),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      resolveTerminalId: () => terminal,
      getOperatorToken: () => null,
      ...devicePath.engine,
      // Only the client's own read is the deferred one.
      hasDeviceCredential: () => true,
      now: () => '2026-06-07T10:05:00.000Z',
      backoff: { baseMs: 1000, maxMs: 300_000 },
    });
    const admission = engine.runTickOnce();
    for (let i = 0; i < 50 && !tokenReadStarted; i += 1) await new Promise((r) => setImmediate(r));
    expect(tokenReadStarted).toBe(true);
    terminal = 'term-NEW'; // the same-branch re-pair completes while the read is pending
    release('new-device-token');
    if (admission.kind === 'started') await admission.completed;
    expect(requests).toHaveLength(0);
    expect(nn(stateRepo.read('sale-1')).sync_status).toBe('pending');
    expect(log.lines).toEqual([{ obj: {}, msg: 'sale_sync:device_terminal_changed' }]);
    db.close();
  });
});
