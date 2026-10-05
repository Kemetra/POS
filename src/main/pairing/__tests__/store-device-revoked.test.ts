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
import {
  createRevocationRecheckTokenRead,
  createSendableDeviceTokenRead,
  createSendableDeviceTokenReader,
} from '../device-token.js';
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

/** A SecretStore whose `get` is held until released; `called` resolves once it is reached. */
function heldSecrets(inner: SecretStore) {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const called = new Promise<void>((r) => {
    reached = r;
  });
  const held: SecretStore = {
    ...inner,
    get: (k) =>
      new Promise((resolve, reject) => {
        release = () => {
          inner.get(k).then(resolve, reject);
        };
        reached();
      }),
  };
  return {
    held,
    called,
    release: () => {
      release();
    },
  };
}

/** The sendable device-token reader over `pairingStore` (default secrets unless one is given). */
function readerOver(
  pairingStore: Parameters<typeof createSendableDeviceTokenReader>[0]['pairingStore'],
  secretStore: Parameters<typeof createSendableDeviceTokenReader>[0]['secretStore'] = secrets,
) {
  return createSendableDeviceTokenReader({ pairingStore, secretStore, deviceTokenKey: KEY });
}

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

  it('review F7: device_revoked is reported before decrypt_failed (the revocation is the operator’s first concern)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    secrets.get = () => Promise.reject(new Error('decrypt'));
    expect(await s.getStatus()).toEqual(DEVICE_REVOKED);
  });

  it('decrypt_failed still dominates when the row is not revoked', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
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
  /**
   * One table for the read-through scenarios (CodeScene 4186773598 dedupe):
   * `setup` picks the store/secret seam, `revokeAt` when the revocation lands.
   */
  interface ReadScenario {
    title: string;
    setup: 'paired' | 'restart' | 'held-token-read';
    revokeAt: 'never' | 'before-read' | 'during-token-read';
    expect: string | null;
  }
  it.each<ReadScenario>([
    { title: 'returns the token while paired', setup: 'paired', revokeAt: 'never', expect: TOKEN },
    {
      title: 'returns null after a restart into the revoked state',
      setup: 'restart',
      revokeAt: 'before-read',
      expect: null,
    },
    {
      title:
        'Codex P1 4186568808 — revoked while ITS token read is pending → null (the token is never handed out)',
      setup: 'held-token-read',
      revokeAt: 'during-token-read',
      expect: null,
    },
    {
      title:
        'Codex P1 4186568808 — control: no revocation during the reads → the token is handed out',
      setup: 'held-token-read',
      revokeAt: 'never',
      expect: TOKEN,
    },
  ])('$title', async ({ setup, revokeAt, expect: expected }) => {
    const s = store();
    await s.persist(pairing('term-1'));
    if (revokeAt === 'before-read') s.markDeviceRevoked();
    const h = heldSecrets(secrets);
    const held = setup === 'held-token-read';
    const pending = readerOver(setup === 'restart' ? store() : s, held ? h.held : secrets)();
    if (held) {
      await h.called;
      if (revokeAt === 'during-token-read') s.markDeviceRevoked();
      h.release();
    }
    await expect(pending).resolves.toBe(expected);
  });

  it('returns null once the device is revoked, although the token is still sealed', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const read = readerOver(s);
    s.markDeviceRevoked();
    expect(await read()).toBeNull();
    expect(await secrets.get(KEY)).toBe(TOKEN);
  });

  it('returns the NEW token after a re-pair', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await s.persist(pairing('term-2', 'device-token-NEW'));
    const read = readerOver(s);
    expect(await read()).toBe('device-token-NEW');
  });

  it.each<[string, PairingStatus]>([
    ['unpaired', { kind: 'unpaired' }],
    ['orphaned_row', { kind: 'invalid', reason: 'orphaned_row' }],
    ['missing_token', { kind: 'invalid', reason: 'missing_token' }],
  ])('returns null when the status is %s', async (_label, status) => {
    await secrets.set(KEY, TOKEN);
    const read = readerOver({ getStatus: () => Promise.resolve(status) });
    expect(await read()).toBeNull();
  });

  it('returns null (never throws) when the status or the token read fails', async () => {
    await secrets.set(KEY, TOKEN);
    const failingStatus = readerOver({ getStatus: () => Promise.reject(new Error('boom')) });
    expect(await failingStatus()).toBeNull();
    const s = store();
    await s.persist(pairing('term-1'));
    const failingSecret = readerOver(s, {
      ...secrets,
      get: () => Promise.reject(new Error('decrypt')),
    });
    expect(await failingSecret()).toBeNull();
  });

  it.each<[string, string | null]>([
    ['empty', ''],
    ['absent', null],
  ])('returns null for an %s stored token', async (_label, value) => {
    const read = readerOver(
      { getStatus: () => Promise.resolve({ kind: 'paired' } as PairingStatus) },
      { get: () => Promise.resolve(value) },
    );
    expect(await read()).toBeNull();
  });
});

describe('PairingStore — pairing epoch + isDeviceRevoked (RT-215, Codex P1)', () => {
  it('is null when unpaired, and a value while paired', async () => {
    const s = store();
    expect(s.getPairingEpoch()).toBeNull();
    expect(s.isDeviceRevoked()).toBe(false);
    await s.persist(pairing('term-1'));
    expect(s.getPairingEpoch()).toEqual(expect.any(String));
    expect(s.isDeviceRevoked()).toBe(false);
  });

  it('becomes null at once when the device is revoked, and stays null after a restart', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    expect(s.getPairingEpoch()).toBeNull();
    expect(s.isDeviceRevoked()).toBe(true);
    const rebooted = store();
    expect(rebooted.getPairingEpoch()).toBeNull();
    expect(rebooted.isDeviceRevoked()).toBe(true);
  });

  it('is null even when the durable write failed (in-memory latch)', async () => {
    const s0 = store();
    await s0.persist(pairing('term-1'));
    const s = store({
      ...bindPairingStoreDb(handle),
      markDeviceRevoked: () => {
        throw new Error('disk');
      },
    });
    expect(() => s.markDeviceRevoked()).toThrow('disk');
    expect(s.getPairingEpoch()).toBeNull();
    expect(s.isDeviceRevoked()).toBe(true);
  });

  it('differs for every pairing, even a re-pair of the same terminal id and time', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const a = s.getPairingEpoch();
    await s.persist(pairing('term-1'));
    const b = s.getPairingEpoch();
    await s.persist(pairing('term-2', 'device-token-NEW'));
    const c = s.getPairingEpoch();
    expect(new Set([a, b, c]).size).toBe(3);
    expect([a, b, c]).not.toContain(null);
  });

  it('a re-pair after a revocation yields a fresh, non-null epoch', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const before = s.getPairingEpoch();
    s.markDeviceRevoked();
    await s.persist(pairing('term-2', 'device-token-NEW'));
    expect(s.getPairingEpoch()).not.toBeNull();
    expect(s.getPairingEpoch()).not.toBe(before);
    expect(s.isDeviceRevoked()).toBe(false);
  });

  it('clear() makes it null', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    await s.clear();
    expect(s.getPairingEpoch()).toBeNull();
  });
});

// ── Codex P1 4186568808: revoked DURING an await ────────────────────────────

describe('Codex P1 4186568808 — a revocation latched during an await wins', () => {
  function storeOver(secretStore: SecretStore) {
    return createPairingStore({
      secretStore,
      db: bindPairingStoreDb(handle),
      deviceTokenKey: KEY,
      now: () => NOW,
    });
  }

  it('getStatus: revoked while the token read is pending → device_revoked, not paired', async () => {
    await store().persist(pairing('term-1'));
    const h = heldSecrets(secrets);
    const s = storeOver(h.held);
    const pending = s.getStatus();
    await h.called;
    s.markDeviceRevoked(); // the detector confirms while the read is pending
    h.release();
    await expect(pending).resolves.toEqual(DEVICE_REVOKED);
  });

  it('sendable reader: revoked during the status read → null', async () => {
    await store().persist(pairing('term-1'));
    const h = heldSecrets(secrets);
    const s = storeOver(h.held);
    const read = readerOver(s);
    const pending = read();
    await h.called;
    s.markDeviceRevoked();
    h.release();
    await expect(pending).resolves.toBeNull();
  });
});

// ── RT-215 10897-A: the user-initiated "Check again" ─────────────────────────

describe('RT-215 10897-A — clearDeviceRevoked (a recheck answered 2xx)', () => {
  it('clears the revocation durably AND in memory, and returns the pairing scope', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    expect(s.clearDeviceRevoked()).toEqual({
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'term-1',
    });
    expect(revokedAtColumn()).toBeNull();
    expect(s.isDeviceRevoked()).toBe(false);
    expect(await s.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-1' });
    // Durable: a restart over the same database is paired too.
    expect(await store().getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-1' });
  });

  it('clears the in-memory latch even when the durable mark had failed', async () => {
    const s0 = store();
    await s0.persist(pairing('term-1'));
    const real = bindPairingStoreDb(handle);
    const s = store({
      ...real,
      markDeviceRevoked: () => {
        throw new Error('disk');
      },
    });
    expect(() => s.markDeviceRevoked()).toThrow('disk');
    expect(s.clearDeviceRevoked()).not.toBeNull();
    expect(s.isDeviceRevoked()).toBe(false);
  });

  it('gives the pairing a fresh, non-null epoch (a sign-in captured under the revocation stays stale)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    const before = s.getPairingEpoch();
    s.markDeviceRevoked();
    s.clearDeviceRevoked();
    expect(s.getPairingEpoch()).not.toBeNull();
    expect(s.getPairingEpoch()).not.toBe(before);
  });

  it('is a no-op returning null when the terminal is not revoked (paired, or unpaired)', async () => {
    const s = store();
    expect(s.clearDeviceRevoked()).toBeNull();
    await s.persist(pairing('term-1'));
    const epoch = s.getPairingEpoch();
    expect(s.clearDeviceRevoked()).toBeNull();
    expect(s.getPairingEpoch()).toBe(epoch);
  });

  it('fails closed: a failing durable clear rethrows and the terminal stays revoked', async () => {
    const s0 = store();
    await s0.persist(pairing('term-1'));
    s0.markDeviceRevoked();
    const s = store({
      ...bindPairingStoreDb(handle),
      clearDeviceRevoked: () => {
        throw new Error('disk');
      },
    });
    expect(() => s.clearDeviceRevoked()).toThrow('disk');
    expect(s.isDeviceRevoked()).toBe(true);
    expect(await s.getStatus()).toEqual(DEVICE_REVOKED);
  });
});

describe('RT-215 10897-A — createRevocationRecheckTokenRead (the ONE deliberate exception)', () => {
  function recheckReadOver(
    pairingStore: Parameters<typeof createRevocationRecheckTokenRead>[0]['pairingStore'],
    secretStore: SecretStore = secrets,
  ) {
    return createRevocationRecheckTokenRead({ pairingStore, secretStore, deviceTokenKey: KEY });
  }

  it('returns the sealed token ONLY while revoked; the default send paths stay null', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    expect(await recheckReadOver(s)()).toBe(TOKEN);
    // The default readers are NOT weakened by the recheck reader.
    expect(await readerOver(s)()).toBeNull();
    expect(
      await createSendableDeviceTokenRead({
        pairingStore: s,
        secretStore: secrets,
        deviceTokenKey: KEY,
      })(),
    ).toBeNull();
  });

  it('returns null while paired (not revoked), without even reading the sealed token', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    let reads = 0;
    const counting: SecretStore = {
      ...secrets,
      get: (k) => {
        reads += 1;
        return secrets.get(k);
      },
    };
    expect(await recheckReadOver(s, counting)()).toBeNull();
    expect(reads).toBe(0);
  });

  it('returns null when unpaired, and once the revocation was cleared', async () => {
    const s = store();
    expect(await recheckReadOver(s)()).toBeNull();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    s.clearDeviceRevoked();
    expect(await recheckReadOver(s)()).toBeNull();
  });

  it('returns null when the revocation ends while its token read is pending (a re-pair raced it)', async () => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    const h = heldSecrets(secrets);
    const pending = recheckReadOver(s, h.held)();
    await h.called;
    s.clearDeviceRevoked();
    h.release();
    await expect(pending).resolves.toBeNull();
  });

  it.each<[string, SecretStore['get']]>([
    ['absent', () => Promise.resolve(null)],
    ['empty', () => Promise.resolve('')],
    ['undecryptable', () => Promise.reject(new Error('decrypt'))],
  ])('returns null (never throws) for an %s sealed token', async (_label, get) => {
    const s = store();
    await s.persist(pairing('term-1'));
    s.markDeviceRevoked();
    await expect(recheckReadOver(s, { ...secrets, get })()).resolves.toBeNull();
  });
});
