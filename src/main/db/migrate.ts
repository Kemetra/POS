import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

import type { DatabaseHandle } from './client.js';

/**
 * T039 — migration runner.
 *
 * Reads `migrations/*.sql` (sorted by filename), applies any not yet present
 * in `schema_migrations`, and records each successful application with a
 * sha256 checksum of the file content (R4). Each file applies inside a single
 * transaction; a failure rolls back the file's writes AND rethrows so the
 * caller (`app.whenReady` chain in `src/main/index.ts`) can call `app.exit(1)`
 * (R3).
 *
 * Decoupled from better-sqlite3 via the `MigrationsDb` interface. Production
 * adapter at the bottom of this file binds it to a real `DatabaseHandle`;
 * tests pass an in-memory fake. R1 mitigation.
 */

export interface MigrationFile {
  /** Basename without extension, e.g. "0001_init". */
  name: string;
  /** Raw SQL contents of the file. */
  sql: string;
}

export interface AppliedRow {
  name: string;
  /** ISO-8601 UTC. */
  applied_at: string;
  /** sha256 hex of the file content as applied. */
  checksum: string;
}

/**
 * Narrow surface the runner needs from a database. Production: backed by a
 * better-sqlite3 handle (see `bindMigrationsDb`). Tests: backed by an
 * in-memory fake.
 */
export interface MigrationsDb {
  /** Run arbitrary SQL outside the migration loop (used to ensure the bootstrap table exists). */
  exec(sql: string): void;
  /** Names already in schema_migrations, in any order. */
  listAppliedNames(): string[];
  /** Insert a row into schema_migrations. */
  recordApplied(row: AppliedRow): void;
  /** Run `fn` inside a transaction; commit on return, rollback + rethrow on error. */
  transaction<T>(fn: () => T): T;
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checksum   TEXT
);
`.trim();

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface RunMigrationsOptions {
  db: MigrationsDb;
  files: MigrationFile[];
  /**
   * RT-320 — called once, before the first pending file is applied, with the
   * pending names. Fires only when the DB already holds applied migrations (a
   * fresh DB has nothing to protect). If it throws, nothing is applied and the
   * error propagates. Production wires the pre-migration snapshot here.
   */
  onBeforeApply?: (pending: readonly string[]) => void;
}

/**
 * RT-320 / ADR-0006 rule 2 — the database is ahead of this build.
 *
 * `schema_migrations` names migrations this build does not ship, so a newer
 * build has already migrated this DB. Running on it would read and write a
 * schema the code does not understand, so startup is refused (fail closed).
 * This holds however the older binary reached the machine (updater, manual
 * installer, copied folder).
 *
 * Shipped migrations are immutable for the same reason: a migration file that
 * has shipped in any signed release is never edited, renamed, renumbered or
 * deleted. A bad migration is corrected by a new migration in a higher version.
 */
export class SchemaAheadError extends Error {
  readonly unknownMigrations: readonly string[];

  constructor(unknownMigrations: readonly string[]) {
    super(
      `database is ahead of this build: unknown applied migrations ${unknownMigrations.join(', ')}`,
    );
    this.name = 'SchemaAheadError';
    this.unknownMigrations = unknownMigrations;
  }
}

/**
 * Pre-scan for the `-- @no-wrap-transaction` opt-out marker.
 *
 * Default behaviour wraps each migration in `db.transaction(...)`. SQLite
 * documents `PRAGMA foreign_keys` as a no-op inside a transaction, and at
 * least one Slice-4 migration (0019, the `failure_reason` enum extension)
 * needs to disable FK enforcement around a table rebuild — DROP TABLE on a
 * parent with child rows raises `FOREIGN KEY constraint failed` even when
 * the rebuild preserves every parent row in advance via INSERT…SELECT.
 *
 * The opt-out is intentionally explicit: a migration author asks for it
 * by placing `-- @no-wrap-transaction` in the first 10 lines of the file,
 * AND is then responsible for emitting their own `BEGIN`/`COMMIT` pair
 * (plus any PRAGMA toggling). Bookkeeping (`schema_migrations` insert)
 * still happens through the runner, in a separate transaction, only if
 * the migration succeeded — so a partial DDL still surfaces as "pending"
 * on the next boot and gets retried.
 *
 * Default is OFF — every existing migration keeps its old shape.
 */
const NO_WRAP_TRANSACTION_MARKER = '-- @no-wrap-transaction';
const MARKER_SCAN_LINE_LIMIT = 10;

function fileOptsOutOfTransactionWrap(sql: string): boolean {
  const lines = sql.split(/\r?\n/, MARKER_SCAN_LINE_LIMIT);
  for (const line of lines) {
    if (line.includes(NO_WRAP_TRANSACTION_MARKER)) return true;
  }
  return false;
}

/**
 * Apply every pending migration in `options.files`, sorted by name.
 * Throws on the first failure (caller decides whether to halt the app).
 */
export function runMigrations(options: RunMigrationsOptions): void {
  const { db, files, onBeforeApply } = options;

  // Step 1: ensure the bookkeeping table exists. Bootstrap chicken-and-egg —
  // we can't read schema_migrations to know whether 0001_init has run if the
  // table doesn't exist yet.
  db.exec(BOOTSTRAP_SQL);

  // Step 2: which names are already on disk?
  const applied = new Set<string>(db.listAppliedNames());

  // Step 2b (RT-320): refuse a DB that a newer build has migrated, before
  // touching anything.
  const known = new Set(files.map((f) => f.name));
  const unknown = [...applied].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0) throw new SchemaAheadError(unknown);

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const pending = sorted.filter((f) => !applied.has(f.name)).map((f) => f.name);
  if (pending.length > 0 && applied.size > 0) onBeforeApply?.(pending);

  // Step 3: walk files in sorted order; apply each pending one. Each file is
  // either wrapped in a single transaction (the default) or — if it carries
  // the `-- @no-wrap-transaction` marker — executed directly, with bookkeeping
  // recorded in a second, smaller transaction afterwards.
  for (const file of sorted) {
    if (applied.has(file.name)) continue;

    const checksum = sha256Hex(file.sql);
    const appliedAt = new Date().toISOString();
    const optedOut = fileOptsOutOfTransactionWrap(file.sql);

    if (optedOut) {
      // The migration runs outside the runner's transaction wrap. It MUST
      // emit its own BEGIN/COMMIT; the runner only re-throws on failure
      // (so bookkeeping is not recorded, the migration appears pending on
      // the next boot, and gets retried).
      db.exec(file.sql);
      // Bookkeeping gets its own small transaction so a crash between the
      // schema work and the insert leaves the next boot in a recoverable
      // state (schema work re-applies; idempotency in the migration body
      // is the author's responsibility).
      db.transaction(() => {
        db.recordApplied({ name: file.name, applied_at: appliedAt, checksum });
      });
    } else {
      // Default: one transaction wraps the migration SQL AND the bookkeeping
      // insert, so rollback removes both on failure.
      db.transaction(() => {
        db.exec(file.sql);
        db.recordApplied({ name: file.name, applied_at: appliedAt, checksum });
      });
    }
  }
}

/**
 * Filesystem source of migration files. Reads every `*.sql` from `dir`,
 * stripping the extension to derive `name`. Returns them in name-sorted order
 * (the runner re-sorts defensively, but stable input helps tests/diffing).
 */
export function readMigrationsFromDisk(dir: string): MigrationFile[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;
    const fullPath = path.join(dir, entry.name);
    const sql = readFileSync(fullPath, 'utf8');
    const name = entry.name.slice(0, -'.sql'.length);
    files.push({ name, sql });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/**
 * Adapt a `DatabaseHandle` (better-sqlite3) to the `MigrationsDb` interface
 * the runner expects. Used at the production wire-in site
 * (`src/main/index.ts`); tests pass their own fake instead.
 */
export function bindMigrationsDb(handle: DatabaseHandle): MigrationsDb {
  // better-sqlite3's prepared statements are sync. Cast the unknown returns to
  // the minimal surface we use; we control the SQL strings.
  //
  // Statements are prepared LAZILY (on first use). Eager preparation would
  // fail on a fresh database because `schema_migrations` does not exist until
  // the runner has executed the bootstrap CREATE TABLE — which happens AFTER
  // bindMigrationsDb returns. Lazy prep means the table is in place before
  // any of these statements is compiled.
  type Stmt = {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  let insertStmt: Stmt | null = null;
  let selectNamesStmt: Stmt | null = null;

  return {
    exec(sql: string): void {
      handle.exec(sql);
    },
    listAppliedNames(): string[] {
      selectNamesStmt ??= handle.prepare('SELECT name FROM schema_migrations') as Stmt;
      const rows = selectNamesStmt.all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    },
    recordApplied(row: AppliedRow): void {
      insertStmt ??= handle.prepare(
        'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
      ) as Stmt;
      insertStmt.run(row.name, row.applied_at, row.checksum);
    },
    transaction<T>(fn: () => T): T {
      // better-sqlite3's `transaction` wraps a function and returns a wrapped
      // callable. Calling that callable runs fn inside BEGIN/COMMIT (rollback
      // on throw). We don't reuse the wrapper across calls because the runner
      // only invokes once per file.
      const wrapped = handle.transaction(fn as never) as unknown as () => T;
      return wrapped();
    },
  };
}
