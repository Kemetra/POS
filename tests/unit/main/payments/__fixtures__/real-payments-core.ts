/**
 * The real 006 payments core over an in-memory sql.js database with every
 * migration applied: repositories, both FSMs and the idempotency helper, as
 * `index.ts` wires them. Shared by the real-stack payment tests (RT-304,
 * RT-700) so each test file only wires the handlers it exercises.
 */

import { beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentActionOutboxRepository } from '../../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../../src/main/payments/idempotency.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

const MIGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../migrations',
);

/** Every `.sql` migration, in order. */
const MIGRATIONS: readonly string[] = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), 'utf8'));

/**
 * Registers the hooks that give each test a fresh migrated database, and
 * returns a reader for the current one.
 */
export function freshMigratedDbPerTest(): () => SqlJsDatabase {
  let SQL: SqlJsStatic | undefined;
  let db: SqlJsDatabase | undefined;
  beforeAll(async () => {
    SQL = await initSqlJs();
  });
  beforeEach(() => {
    if (SQL === undefined) throw new Error('sql.js not initialised');
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
  });
  return () => {
    if (db === undefined) throw new Error('no database for this test');
    return db;
  };
}

/** The real repositories, FSMs and idempotency helper over `db`. */
export function bindRealPaymentsCore(db: SqlJsDatabase) {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  return {
    handle,
    attempts,
    lines,
    outbox,
    tenderLineFsm: createTenderLineFsm({ db: handle, attempts, lines, outbox }),
    paymentAttemptFsm: createPaymentAttemptFsm({ db: handle, attempts, lines, outbox }),
    idempotency: createIdempotencyHelper({ outbox }),
  };
}
