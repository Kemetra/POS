/**
 * RT-215 × RT-224 (#546 × #547 integration) — the device-path sale capture
 * under a revoked device, end to end on the real pieces: the RT-215 sendable
 * token read behind #547's never-reject reader, the composed device path, the
 * real client and engine, and the real 2×401 detector.
 *
 *  (a) A revoked device reads as "no token": nothing is sent and the sale stays
 *      queued. The read never rejects; a secret-store failure is "no token",
 *      logged once (closed-set).
 *  (b) The sale capture route is shared with the envelope path, so the device
 *      path is tagged at its fetch: every device-path answer reaches the
 *      detector as `sale_sync`, and every device-path 401 fires
 *      `onUnauthorized`. The envelope path is never observed.
 *  (c) A device-path 401 leaves the sale queued; a 403 still dead-letters it as
 *      `cashier_claim_refused` and is not a device signal.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { composeSaleSyncDevicePath, DEVICE_TOKEN_UNREADABLE_LOG } from '../compose-device-path.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { createSaleSyncEngine } from '../sale-sync-engine.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSendableDeviceTokenRead } from '../../pairing/device-token.js';
import {
  createDeviceAuthDetector,
  type DeviceAuthDetector,
} from '../../pairing/device-auth-detector.js';
import { makeSecretKey } from '../../../shared/secret-store.js';
import type { DeviceRevokedSource, PairingStatus } from '../../../shared/pairing-types.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const KEY = makeSecretKey('terminal.device-token');
const TOKEN = 'device-token-SECRET-77';
const ENVELOPE = 'pos-operator-envelope-SECRET';
const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'term-1',
  terminal_label: 'Counter 1',
  paired_at: 100,
};
const REVOKED: PairingStatus = { kind: 'invalid', reason: 'device_revoked' };

interface WorldOptions {
  /** Status of every capture answer. */
  status?: number;
  /** The SecretStore read of the device token. */
  secret?: () => Promise<string | null>;
  /** A legacy/manager sale (no selling_user_id): it goes out on the envelope path. */
  legacy?: boolean;
}

const detectors: DeviceAuthDetector[] = [];
afterEach(() => {
  for (const d of detectors.splice(0)) d.stop();
});

function world(o: WorldOptions = {}) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  seedSale(db, { sale_id: 'sale-1' });
  seedOutbox(db, { sale_id: 'sale-1' });
  seedSettled(db, { sale_id: 'sale-1', ...(o.legacy === true ? {} : { selling_user_id: USER_A }) });

  const pairing = { revoked: false };
  const pairingStore = {
    getStatus: () => Promise.resolve(pairing.revoked ? REVOKED : PAIRED),
    isDeviceRevoked: () => pairing.revoked,
  };
  const unauthorized: DeviceRevokedSource[] = [];
  const detector = createDeviceAuthDetector({
    probe: () => new Promise(() => undefined),
    confirmDelayMs: () => 30_000,
    onConfirmed: () => undefined,
    onUnauthorized: (source) => unauthorized.push(source),
  });
  detectors.push(detector);
  const logs: string[] = [];
  const requests: string[] = [];
  const answer = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Headers(init?.headers).get('Authorization') ?? '');
    void input;
    return Promise.resolve(new Response('{}', { status: o.status ?? 201 }));
  };
  const devicePath = composeSaleSyncDevicePath({
    db: handle,
    readToken: createSendableDeviceTokenRead({
      pairingStore,
      secretStore: { get: o.secret ?? (() => Promise.resolve(TOKEN)) },
      deviceTokenKey: KEY,
    }),
    currentTerminalId: () => 'term-1',
    deviceAuth: { fetch: answer, detector },
    logger: { warn: (_obj, msg) => logs.push(msg) },
  });
  const stateRepo = createSaleSyncStateRepo(handle);
  const engine = createSaleSyncEngine({
    client: createSaleSyncClient({
      baseUrl: 'https://backend.example',
      fetch: answer,
      getOperatorToken: () => ENVELOPE,
      ...devicePath.client,
    }),
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => 'term-1',
    getOperatorToken: () => ENVELOPE,
    ...devicePath.engine,
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
  });
  const tick = async (): Promise<void> => {
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
  };
  const statusOf = (): string => stateRepo.read('sale-1')?.sync_status ?? 'pending';
  return {
    db,
    pairing,
    detector,
    unauthorized,
    logs,
    requests,
    devicePath,
    stateRepo,
    tick,
    statusOf,
  };
}

describe('(a) the sale-sync device token is the RT-215 sendable read, behind the never-reject reader', () => {
  it.each<{ title: string; options: WorldOptions; revoked: boolean; logs: string[] }>([
    {
      title: 'a revoked device: "no token", nothing sent, the sale stays queued',
      options: {},
      revoked: true,
      logs: [],
    },
    {
      title:
        'a secret-store failure: "no token" (never a rejection), nothing sent, the sale stays queued, logged once with no data',
      options: { secret: () => Promise.reject(new Error(`DPAPI ${TOKEN}`)) },
      revoked: false,
      logs: [DEVICE_TOKEN_UNREADABLE_LOG],
    },
  ])('$title', async ({ options, revoked, logs }) => {
    const w = world(options);
    w.pairing.revoked = revoked;
    await expect(w.devicePath.client.getDeviceToken()).resolves.toBeNull();
    await w.tick();
    expect(w.requests).toEqual([]);
    expect(w.statusOf()).toBe('pending');
    expect(w.logs).toEqual(logs);
    w.db.close();
  });

  it('revoked while the token read is pending: the token is never handed out, nothing sent', async () => {
    let release: (token: string) => void = () => undefined;
    let reads = 0;
    const w = world({
      secret: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = w.devicePath.client.getDeviceToken();
    for (let i = 0; i < 20 && reads === 0; i += 1) await Promise.resolve();
    expect(reads).toBe(1);
    w.pairing.revoked = true; // the detector confirms while the read is pending
    release(TOKEN);
    await expect(pending).resolves.toBeNull();
    w.db.close();
  });
});

describe('(b)+(c) device-path answers reach the 2×401 detector through the device fetch tag', () => {
  it('a device-path 401: onUnauthorized(sale_sync), the detector is suspect, the sale stays queued', async () => {
    const w = world({ status: 401 });
    await w.tick();
    expect(w.requests).toEqual([`Bearer ${TOKEN}`]);
    expect(w.unauthorized).toEqual(['sale_sync']);
    expect(w.detector.state).toBe('suspect');
    const row = nn(w.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('pending');
    expect(row.last_error_category).toBe('device_unauthorized');
    w.db.close();
  });

  it('a device-path 403 dead-letters the sale as cashier_claim_refused and is not a device signal', async () => {
    const w = world({ status: 403 });
    await w.tick();
    const row = nn(w.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('dead_letter');
    expect(row.last_error_category).toBe('cashier_claim_refused');
    expect(w.unauthorized).toEqual([]);
    expect(w.detector.state).toBe('clear');
    w.db.close();
  });

  it('a device-path 2xx resets a pending count (a device-bearer success)', async () => {
    const w = world({ status: 201 });
    w.detector.observe('cashier_admissions', 401);
    expect(w.detector.state).toBe('suspect');
    await w.tick();
    expect(w.statusOf()).toBe('synced');
    expect(w.detector.state).toBe('clear');
    w.db.close();
  });

  it('the envelope path on the same route is never observed: its 401 is the operator credential', async () => {
    const w = world({ status: 401, legacy: true });
    await w.tick();
    expect(w.requests).toEqual([`Bearer ${ENVELOPE}`]);
    expect(w.unauthorized).toEqual([]);
    expect(w.detector.state).toBe('clear');
    w.db.close();
  });
});
