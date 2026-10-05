import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { DatabaseHandle } from '../../db/client.js';
import { createInMemorySecretStore } from '../../secrets/in-memory.js';
import { makeSecretKey, type SecretStore } from '../../../shared/secret-store.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';
import { createSendableDeviceTokenReader } from '../device-token.js';
import {
  bindPairingStoreDb,
  createPairingStore,
  type PersistInput,
  type PairingStoreDb,
} from '../store.js';

/**
 * RT-215 — the durable device-revoked state on the pairing row.
 *
 * Runs the PRODUCTION `bindPairingStoreDb` SQL against sql.js with the full
 * migration stack (0042 included):
 *   • `markDeviceRevoked()` writes `device_revoked_at`, and `getStatus()` then
 *     reports `invalid / device_revoked` (RT-215 decision 4);
 *   • the state survives a restart (a fresh store over the same database);
 *   • a re-pair (`persist`, INSERT OR REPLACE) clears it;
 *   • the device token stays sealed in the SecretStore, but the sendable-token
 *     reader never returns it while revoked (decision 3).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirnameForFile, '..', '..', '..', '..', 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

const KEY = makeSecretKey('terminal.device-token');
const TOKEN = 'device-token-SENTINEL-91ab';
const NOW = new Date('2026-10-05T09:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

function pairing(terminal_id: string, device_token = TOKEN): PersistInput {
  return {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    terminal_label: 'Till 1',
    paired_at: 1_760_000_000,
    branch_name: 'Branch',
    branch_address: 'Addr',
    tenant_tax_registration_id: 'TRN',
    printer_vendor_id: null,
    printer_product_id: null,
    printer_com_port: null,
    device_token,
  };
}

let SQL: SqlJsStatic | undefined;
let raw: SqlJsDatabase;
let handle: DatabaseHandle;
let secrets: SecretStore;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  raw = new SQL.Database();
  for (const name of ALL_MIGRATIONS)
    raw.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  handle = handleFor(raw);
  secrets = createInMemorySecretStore();
});

afterEach(() => {
  raw.close();
});

function store(db: PairingStoreDb = bindPairingStoreDb(handle)) {
  return createPairingStore({ secretStore: secrets, db, deviceTokenKey: KEY, now: () => NOW });
}

function revokedAtColumn(): unknown {
  return raw.exec('SELECT device_revoked_at FROM terminal_assignment WHERE id = 1')[0]
    ?.values[0]?.[0];
}

const DEVICE_REVOKED: PairingStatus = { kind: 'invalid', reason: 'device_revoked' };

describe('PairingStore — device revoked (RT-215)', () => {
  it('markDeviceRevoked records the time on the row and returns the revoked scope', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    expect(s.markDeviceRevoked()).toEqual({
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'term-1',
    });
    expect(revokedAtColumn()).toBe(NOW_S);
    expect(await s.getStatus()).toEqual(DEVICE_REVOKED);
  });

  it('is idempotent: a second mark keeps the first time', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    raw.run('UPDATE terminal_assignment SET device_revoked_at = 5 WHERE id = 1');
    s.markDeviceRevoked();
    expect(revokedAtColumn()).toBe(5);
  });

  it('returns null and records nothing when the terminal is not paired', async () => {
    const s = store();
    expect(s.markDeviceRevoked()).toBeNull();
    expect(await s.getStatus()).toEqual({ kind: 'unpaired' });
  });

  it('is durable across a restart: a fresh store over the same database still reports device_revoked', async () => {
    const before = store();
    await before.persist(pairing('term-1'));
    before.markDeviceRevoked();

    const afterRestart = store();
    expect(await afterRestart.getStatus()).toEqual(DEVICE_REVOKED);
  });

  it('keeps the device token sealed (not deleted) while revoked', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    expect(await secrets.get(KEY)).toBe(TOKEN);
  });

  it('reports device_revoked even when the token half is gone (row is the source of truth)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await secrets.delete(KEY);
    expect(await s.getStatus()).toEqual(DEVICE_REVOKED);
  });

  it('decrypt_failed still dominates (the SecretStore is unhealthy)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    secrets.get = () => Promise.reject(new Error('decrypt'));
    expect(await s.getStatus()).toEqual({ kind: 'invalid', reason: 'decrypt_failed' });
  });

  it('a re-pair (persist) clears the revoked state, on the row and in memory', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await s.persist(pairing('term-2', 'device-token-NEW'));
    expect(revokedAtColumn()).toBeNull();
    expect(await s.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-2' });
    // And after a restart.
    expect(await store().getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-2' });
  });

  it('clear() also drops the in-memory revoked latch', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await s.clear();
    expect(await s.getStatus()).toEqual({ kind: 'unpaired' });
  });

  it('holds the revoked state in memory even when the row write fails, and surfaces the failure', async () => {
    const s0 = store();
    await s0.persist(pairing('term-1'));
    const real = bindPairingStoreDb(handle);
    const failing: PairingStoreDb = {
      ...real,
      markDeviceRevoked: () => {
        throw new Error('disk I/O error');
      },
    };
    const s = store(failing);
    expect(() => s.markDeviceRevoked()).toThrow('disk I/O error');
    expect(await s.getStatus()).toEqual(DEVICE_REVOKED);
  });

  it('getCurrentTerminalId is unchanged while revoked (an open sale can still finish)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    expect(s.getCurrentTerminalId()).toBe('term-1');
  });
});

describe('createSendableDeviceTokenReader (RT-215: never send a revoked token)', () => {
  it('returns the token while paired', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const read = createSendableDeviceTokenReader({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await read()).toBe(TOKEN);
  });

  it('returns null once the device is revoked, although the token is still sealed', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const read = createSendableDeviceTokenReader({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    s.markDeviceRevoked();
    expect(await read()).toBeNull();
    expect(await secrets.get(KEY)).toBe(TOKEN);
  });

  it('returns null after a restart into the revoked state', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    const read = createSendableDeviceTokenReader({
      pairingStore: store(),
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await read()).toBeNull();
  });

  it('returns the NEW token after a re-pair', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await s.persist(pairing('term-2', 'device-token-NEW'));
    const read = createSendableDeviceTokenReader({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await read()).toBe('device-token-NEW');
  });

  it.each<[string, PairingStatus]>([
    ['unpaired', { kind: 'unpaired' }],
    ['orphaned_row', { kind: 'invalid', reason: 'orphaned_row' }],
    ['missing_token', { kind: 'invalid', reason: 'missing_token' }],
  ])('returns null when the status is %s', async (_label, status) => {
    await secrets.set(KEY, TOKEN);
    const read = createSendableDeviceTokenReader({
      pairingStore: { getStatus: () => Promise.resolve(status) },
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await read()).toBeNull();
  });

  it('returns null (never throws) when the status or the token read fails', async () => {
    await secrets.set(KEY, TOKEN);
    const failingStatus = createSendableDeviceTokenReader({
      pairingStore: { getStatus: () => Promise.reject(new Error('boom')) },
      secretStore: secrets,
      deviceTokenKey: KEY,
    });
    expect(await failingStatus()).toBeNull();
    const s = store();
    await s.persist(pairing('term-1'));
    const failingSecret = createSendableDeviceTokenReader({
      pairingStore: s,
      secretStore: { ...secrets, get: () => Promise.reject(new Error('decrypt')) },
      deviceTokenKey: KEY,
    });
    expect(await failingSecret()).toBeNull();
  });

  it.each<[string, string | null]>([
    ['empty', ''],
    ['absent', null],
  ])('returns null for an %s stored token', async (_label, value) => {
    const read = createSendableDeviceTokenReader({
      pairingStore: { getStatus: () => Promise.resolve({ kind: 'paired' } as PairingStatus) },
      secretStore: { get: () => Promise.resolve(value) },
      deviceTokenKey: KEY,
    });
    expect(await read()).toBeNull();
  });
});
