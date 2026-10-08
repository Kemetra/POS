/**
 * RT-113 P1.1 — test fixture for the offline grant store.
 *
 *  - A sql.js database with the FULL migration stack applied (so
 *    `cashier_offline_grants` and `cashier_offline_clock_hwm` exist exactly as
 *    production sees them), wrapped in the production `DatabaseHandle` by the
 *    009/010 `handleFor` adapter.
 *  - An AUTHENTICATED fake of `SafeStorageLike` (AES-256-GCM, one random key
 *    per instance). It models what the store relies on from DPAPI: a sealed
 *    blob cannot be edited without the decrypt failing, and a blob sealed under
 *    another key (another Windows profile) does not open. The trivial
 *    `enc:<plain>` fake used elsewhere would let a test forge a seal by hand.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import { handleFor } from '../../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { DatabaseHandle } from '../../../db/client.js';
import type { SafeStorageLike } from '../../../secrets/safe-storage.js';
import type { CashierAdmittedEvent } from '../../cashier-admission.js';

export { handleFor };

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
// __tests__/__helpers__ → operator → main → src → repo root
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

let SQL: SqlJsStatic | undefined;

/** Initialise the sql.js engine once. Call in a `beforeAll`. */
export async function initGrantSql(): Promise<void> {
  if (SQL === undefined) SQL = await initSqlJs();
}

/** A raw sql.js database with EVERY migration applied. */
export function freshGrantDb(): SqlJsDatabase {
  if (SQL === undefined) throw new Error('await initGrantSql() in beforeAll first');
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ALL_MIGRATIONS) db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  return db;
}

export interface AeadSafeStorage extends SafeStorageLike {
  /** How many times each method ran (lets a test prove a path never sealed). */
  readonly calls: { encrypt: number; decrypt: number };
}

/** AES-256-GCM: iv(12) | tag(16) | ciphertext. A wrong key or any edited byte throws. */
export function aeadSafeStorage(key: Buffer = randomBytes(32)): AeadSafeStorage {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString(plain: string): Buffer {
      calls.encrypt += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]);
    },
    decryptString(buf: Buffer): string {
      calls.decrypt += 1;
      const bytes = Buffer.from(buf);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

export interface GrantDb {
  raw: SqlJsDatabase;
  handle: DatabaseHandle;
}

export function grantDb(): GrantDb {
  const raw = freshGrantDb();
  return { raw, handle: handleFor(raw) };
}

// ── Sentinel identity values: every one is unique, so a log or error leak of
//    any grant field is detectable by a plain substring search.
export const TENANT = 'tenant-SENTINEL-7f1c';
export const BRANCH = 'branch-SENTINEL-2b9d';
export const TERMINAL = 'terminal-SENTINEL-c4e0';
export const EPOCH = 1_790_000_000;
export const USER = 'user-SENTINEL-5a17';
export const OPERATOR = 'user_clerk_SENTINEL_9e3b';
export const DISPLAY_NAME = 'Nour SENTINEL-Haddad';
export const ADMISSION = 'adm-SENTINEL-0d42';
export const SERVER_TIME = '2026-10-05T08:00:00.000Z';

/** Every value that must never reach a logger or an error message. */
export const SENSITIVE_VALUES: readonly string[] = [
  TENANT,
  BRANCH,
  TERMINAL,
  USER,
  OPERATOR,
  DISPLAY_NAME,
  ADMISSION,
  SERVER_TIME,
];

/** The local wall time the default admitted event was received. */
export const T0 = new Date('2026-10-05T08:00:01.000Z');
export const T0_MS = T0.getTime();

export const HOUR_MS = 3_600_000;
export const MIN_MS = 60_000;

export interface Scope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  pairing_epoch: number;
}

export function scope(over: Partial<Scope> = {}): Scope {
  return {
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    pairing_epoch: EPOCH,
    ...over,
  };
}

export function admitted(over: Partial<CashierAdmittedEvent> = {}): CashierAdmittedEvent {
  return {
    user_id: USER,
    operator_id: OPERATOR,
    admission_id: ADMISSION,
    display_name: DISPLAY_NAME,
    offline_grace_seconds: 86_400,
    server_time: SERVER_TIME,
    received_at: T0.toISOString(),
    ...over,
  };
}

export function at(ms: number): Date {
  return new Date(ms);
}

/** Every row of a table, blobs as Buffers. */
export function rows(db: SqlJsDatabase, table: string): Record<string, unknown>[] {
  const stmt = db.prepare(`SELECT * FROM ${table}`);
  const out: Record<string, unknown>[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject();
      for (const [k, v] of Object.entries(r)) if (v instanceof Uint8Array) r[k] = Buffer.from(v);
      out.push(r);
    }
  } finally {
    stmt.free();
  }
  return out;
}

/** The sealed body of one grant row (throws when the row is absent). */
export function grantBlob(db: SqlJsDatabase, user = USER): Buffer {
  const stmt = db.prepare('SELECT sealed_body FROM cashier_offline_grants WHERE user_id = ?');
  try {
    stmt.bind([user]);
    if (!stmt.step()) throw new Error('no grant row');
    const v = stmt.getAsObject()['sealed_body'];
    if (!(v instanceof Uint8Array)) throw new Error('no sealed body');
    return Buffer.from(v);
  } finally {
    stmt.free();
  }
}

export function setGrantBlob(db: SqlJsDatabase, blob: Buffer | null, user = USER): void {
  db.run('UPDATE cashier_offline_grants SET sealed_body = ? WHERE user_id = ?', [blob, user]);
}
