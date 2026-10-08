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
  type PairingStoreDb,
  type PersistInput,
} from '../store.js';
import { openDeviceToken, sealDeviceToken } from '../token-binding.js';

/**
 * RT-306 (RT-215 10901-(a), owner approval 10906) — the sealed device token is
 * bound to the pairing row it was written for.
 *
 * `persist()` writes the token first and the `terminal_assignment` row second,
 * in two stores with no shared transaction. A hard crash between them during a
 * re-pair used to leave the NEW token beside the OLD row, reported `paired`, and
 * sent under the old terminal's identity and scope. The token is now sealed
 * together with the identity of its pairing (tenant, branch, terminal and the
 * strictly increasing pairing epoch `paired_at`), so that state is detected on
 * boot and on every sendable read: `invalid / inconsistent`, and never sent.
 *
 * No migration: the binding lives inside the sealed secret. Runs the
 * PRODUCTION `bindPairingStoreDb` SQL against sql.js with every migration.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirnameForFile, '..', '..', '..', '..', 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

const KEY = makeSecretKey('terminal.device-token');
const OLD_TOKEN = 'old-device-token-SENTINEL-1a';
const NEW_TOKEN = 'new-device-token-SENTINEL-2b';

const INCONSISTENT: PairingStatus = { kind: 'invalid', reason: 'inconsistent' };
const DEVICE_REVOKED: PairingStatus = { kind: 'invalid', reason: 'device_revoked' };

function pairing(
  terminal_id: string,
  device_token: string,
  paired_at: number,
  over: Partial<PersistInput> = {},
): PersistInput {
  return {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    terminal_label: 'Till 1',
    paired_at,
    branch_name: 'Branch',
    branch_address: 'Addr',
    tenant_tax_registration_id: 'TRN',
    printer_vendor_id: null,
    printer_product_id: null,
    printer_com_port: null,
    device_token,
    ...over,
  };
}

const OLD = pairing('term-old', OLD_TOKEN, 1_760_000_000);
const NEW = pairing('term-new', NEW_TOKEN, 1_760_000_100, { branch_id: 'branch-2' });

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

/** A store over the shared database and SecretStore; a new one is a restart. */
function store(db: PairingStoreDb = bindPairingStoreDb(handle), secretStore = secrets) {
  return createPairingStore({ secretStore, db, deviceTokenKey: KEY });
}

/**
 * The process dies after the new token is sealed and before the row is
 * written: the row write never lands, and nothing gets to compensate.
 */
async function crashMidRepair(input: PersistInput): Promise<void> {
  const real = bindPairingStoreDb(handle);
  const crashingDb: PairingStoreDb = {
    ...real,
    transaction: () => {
      throw new Error('process killed');
    },
  };
  const noCompensation: SecretStore = {
    ...secrets,
    delete: () => Promise.reject(new Error('process killed')),
  };
  await expect(store(crashingDb, noCompensation).persist(input)).rejects.toThrow('process killed');
}

function sendableReaders(s: ReturnType<typeof store>) {
  return {
    reader: createSendableDeviceTokenReader({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    }),
    read: createSendableDeviceTokenRead({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    }),
    recheck: createRevocationRecheckTokenRead({
      pairingStore: s,
      secretStore: secrets,
      deviceTokenKey: KEY,
    }),
  };
}

describe('RT-306 — a crash mid-re-pair fails closed after restart', () => {
  it('reports invalid / inconsistent on boot and never hands out the new token', async () => {
    await store().persist(OLD);
    await crashMidRepair(NEW);

    // Restart: a fresh store over the same database and SecretStore.
    const booted = store();
    expect(booted.getCurrentTerminalId()).toBe('term-old');
    expect(await booted.getStatus()).toEqual(INCONSISTENT);
    const { reader, read, recheck } = sendableReaders(booted);
    expect(await reader()).toBeNull();
    expect(await read()).toBeNull();
    expect(await recheck()).toBeNull();
  });

  it('a stale token kept by a failed compensation is caught the same way', async () => {
    // Re-pair whose row write fails and whose compensation delete also fails.
    await store().persist(OLD);
    await crashMidRepair(NEW);
    expect(await store().getStatus()).toEqual(INCONSISTENT);
  });

  it('fails closed on an identity mismatch in any single field', async () => {
    for (const over of [
      { tenant_id: 'tenant-x' },
      { branch_id: 'branch-x' },
      { terminal_id: 'term-x' },
      { paired_at: OLD.paired_at + 1 },
    ] satisfies Partial<PersistInput>[]) {
      raw.exec('DELETE FROM terminal_assignment');
      await store().persist(OLD);
      await secrets.set(KEY, sealDeviceToken(NEW_TOKEN, { ...OLD, ...over }));
      const s = store();
      expect(await s.getStatus()).toEqual(INCONSISTENT);
      expect(await sendableReaders(s).reader()).toBeNull();
    }
  });

  it('a revoked row stays reported as device_revoked, and Check again sends nothing on a mismatch', async () => {
    const s = store();
    await s.persist(OLD);
    s.markDeviceRevoked();
    await crashMidRepair(NEW);
    const booted = store();
    expect(await booted.getStatus()).toEqual(DEVICE_REVOKED);
    expect(await sendableReaders(booted).recheck()).toBeNull();
  });

  it('an unreadable sealed value is inconsistent, never sent', async () => {
    await store().persist(OLD);
    for (const sealed of [
      '{',
      '{"v":1}',
      '{"v":2,"token":"t","binding":{}}',
      '{"v":1,"token":""}',
    ]) {
      await secrets.set(KEY, sealed);
      const s = store();
      expect(await s.getStatus()).toEqual(INCONSISTENT);
      expect(await sendableReaders(s).reader()).toBeNull();
    }
  });
});

describe('RT-306 — every sendable read checks the binding itself', () => {
  it('a re-pair landing between the status read and the token read is not handed out under the old status', async () => {
    const s = store();
    await s.persist(OLD);
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const called = new Promise<void>((r) => {
      reached = r;
    });
    const held: SecretStore = {
      ...secrets,
      get: (k) =>
        new Promise((resolve, reject) => {
          release = () => {
            secrets.get(k).then(resolve, reject);
          };
          reached();
        }),
    };
    const statusHeld = createPairingStore({
      secretStore: secrets,
      db: bindPairingStoreDb(handle),
      deviceTokenKey: KEY,
    });
    const pending = createSendableDeviceTokenRead({
      pairingStore: statusHeld,
      secretStore: held,
      deviceTokenKey: KEY,
    })();
    await called; // `paired` (OLD) was read; the token read is pending
    await s.persist(NEW);
    release();
    await expect(pending).resolves.toBeNull();
  });
});

describe('RT-306 — normal pairing behaviour is unchanged', () => {
  it('a completed pairing is paired and sends the raw token (never the sealed envelope)', async () => {
    const s = store();
    await s.persist(OLD);
    expect(await s.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-old' });
    const { reader, read, recheck } = sendableReaders(s);
    expect(await reader()).toBe(OLD_TOKEN);
    expect(await read()).toBe(OLD_TOKEN);
    expect(await recheck()).toBeNull(); // only while revoked
    // The secret holds the bound form, which opens to the same token.
    const sealed = await secrets.get(KEY);
    expect(sealed).not.toBe(OLD_TOKEN);
    expect(openDeviceToken(sealed ?? '')).toEqual({
      kind: 'bound',
      token: OLD_TOKEN,
      binding: {
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'term-old',
        paired_at: OLD.paired_at,
      },
    });
  });

  it('a completed re-pair sends the new token', async () => {
    await store().persist(OLD);
    const s = store();
    await s.persist(NEW);
    expect(await s.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-new' });
    expect(await sendableReaders(s).reader()).toBe(NEW_TOKEN);
  });

  it('a revoked, consistent pairing still offers its raw token to Check again only', async () => {
    const s = store();
    await s.persist(OLD);
    s.markDeviceRevoked();
    const { reader, recheck } = sendableReaders(s);
    expect(await reader()).toBeNull();
    expect(await recheck()).toBe(OLD_TOKEN);
  });

  it('a token sealed before RT-306 (raw, unbound) keeps working: no upgrade lockout', async () => {
    await store().persist(OLD);
    await secrets.set(KEY, OLD_TOKEN); // the pre-RT-306 format
    const s = store();
    expect(await s.getStatus()).toMatchObject({ kind: 'paired', terminal_id: 'term-old' });
    expect(await sendableReaders(s).reader()).toBe(OLD_TOKEN);
    s.markDeviceRevoked();
    expect(await sendableReaders(s).recheck()).toBe(OLD_TOKEN);
  });

  it('the earlier orphan reasons keep their precedence', async () => {
    // token only (crash on the very first pairing): missing_token, as before.
    await crashMidRepair(OLD);
    expect(await store().getStatus()).toEqual({ kind: 'invalid', reason: 'missing_token' });
    // row only: orphaned_row, as before.
    await store().persist(OLD);
    await secrets.delete(KEY);
    expect(await store().getStatus()).toEqual({ kind: 'invalid', reason: 'orphaned_row' });
  });
});

describe('RT-306 — sealDeviceToken / openDeviceToken', () => {
  const binding = { tenant_id: 't', branch_id: 'b', terminal_id: 'x', paired_at: 5 };

  it('round-trips a token and its binding', () => {
    expect(openDeviceToken(sealDeviceToken('tok', binding))).toEqual({
      kind: 'bound',
      token: 'tok',
      binding,
    });
  });

  it('reads a value that is not a sealed envelope as a legacy raw token', () => {
    // Backend-Core issues base64url tokens, which never start with `{`.
    expect(openDeviceToken('aB3_-x')).toEqual({ kind: 'legacy', token: 'aB3_-x' });
  });

  it('reads an envelope it cannot trust as malformed', () => {
    expect(openDeviceToken('{"v":1,"token":"t","binding":{"tenant_id":"t"}}')).toEqual({
      kind: 'malformed',
    });
    expect(
      openDeviceToken(
        '{"v":1,"token":"t","binding":{"tenant_id":"t","branch_id":"b","terminal_id":"x","paired_at":"5"}}',
      ),
    ).toEqual({ kind: 'malformed' });
  });

  it('never puts the token into an error', () => {
    expect(() => openDeviceToken('{"v":1,"token":"SECRET-T"')).not.toThrow();
  });
});
