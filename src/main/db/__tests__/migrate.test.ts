import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';

import {
  bindMigrationsDb,
  readMigrationsFromDisk,
  runMigrations,
  SchemaAheadError,
  type AppliedRow,
  type MigrationFile,
  type MigrationsDb,
} from '../migrate.js';
import type { DatabaseHandle } from '../client.js';

/**
 * T036 — failing migration-runner unit tests.
 *
 * The runner is unit-tested against an in-memory fake of the
 * better-sqlite3 surface it actually uses. Real DB behavior (transactions,
 * WAL, native binding) is verified by T041 manual smoke. R1 mitigation.
 */

/**
 * Minimal in-memory fake. It tracks:
 *   - which "tables" exist (we only care about schema_migrations + smoke flags)
 *   - rows in schema_migrations
 *   - which raw SQL fragments were exec'd in order
 *   - whether transactions committed or rolled back
 */
function makeFakeDb(options: { failOnSql?: string } = {}): {
  db: MigrationsDb;
  applied: AppliedRow[];
  execLog: string[];
  transactionsCommitted: number;
  transactionsRolledBack: number;
  schemaMigrationsExists: () => boolean;
} {
  let schemaMigrationsTableCreated = false;
  const applied: AppliedRow[] = [];
  const execLog: string[] = [];
  let txDepth = 0;
  let txStaging: AppliedRow[] = [];
  let txStagingExec: string[] = [];
  const counters = { transactionsCommitted: 0, transactionsRolledBack: 0 };

  const db: MigrationsDb = {
    exec(sql: string): void {
      // Intercept the bootstrap CREATE so test can verify it ran before any migration.
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
        schemaMigrationsTableCreated = true;
        return;
      }
      if (options.failOnSql && sql.includes(options.failOnSql)) {
        throw new Error(`fake DB: forced failure on SQL containing "${options.failOnSql}"`);
      }
      if (txDepth > 0) {
        txStagingExec.push(sql);
      } else {
        execLog.push(sql);
      }
    },
    listAppliedNames(): string[] {
      if (!schemaMigrationsTableCreated) {
        throw new Error('fake DB: schema_migrations does not exist yet');
      }
      return applied.map((r) => r.name);
    },
    recordApplied(row: AppliedRow): void {
      if (txDepth > 0) {
        txStaging.push(row);
      } else {
        applied.push(row);
      }
    },
    transaction<T>(fn: () => T): T {
      txDepth += 1;
      txStaging = [];
      txStagingExec = [];
      try {
        const result = fn();
        // Commit: promote staged writes to the real arrays.
        applied.push(...txStaging);
        execLog.push(...txStagingExec);
        counters.transactionsCommitted += 1;
        return result;
      } catch (err) {
        // Rollback: drop staged writes.
        counters.transactionsRolledBack += 1;
        throw err;
      } finally {
        txStaging = [];
        txStagingExec = [];
        txDepth -= 1;
      }
    },
  };

  return {
    db,
    applied,
    execLog,
    get transactionsCommitted(): number {
      return counters.transactionsCommitted;
    },
    get transactionsRolledBack(): number {
      return counters.transactionsRolledBack;
    },
    schemaMigrationsExists: () => schemaMigrationsTableCreated,
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Use a placeholder DDL distinct from the bootstrap CREATE so the test fake
// can tell "the runner ensured the bookkeeping table" apart from "the runner
// applied migration 0001". In production, 0001_init.sql IS the bootstrap
// itself, but the runner runs CREATE TABLE IF NOT EXISTS schema_migrations
// independently before any file, so the duplication is harmless.
const FILE_INIT: MigrationFile = {
  name: '0001_init',
  sql: 'CREATE TABLE init_marker (id INTEGER PRIMARY KEY);',
};
const FILE_SMOKE: MigrationFile = {
  name: '0002_smoke',
  sql: 'CREATE TABLE smoke (id INTEGER PRIMARY KEY);',
};
const FILE_THIRD: MigrationFile = {
  name: '0003_more',
  sql: 'CREATE TABLE more (id INTEGER PRIMARY KEY);',
};

describe('runMigrations', () => {
  it('creates schema_migrations bootstrap before applying any file', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT] });
    expect(fake.schemaMigrationsExists()).toBe(true);
  });

  it('applies pending migrations in sorted (name-ascending) order', () => {
    const fake = makeFakeDb();
    // Provide files out of order; runner must sort them.
    runMigrations({ db: fake.db, files: [FILE_SMOKE, FILE_INIT, FILE_THIRD] });
    expect(fake.applied.map((r) => r.name)).toEqual(['0001_init', '0002_smoke', '0003_more']);
    // exec order also matches sort order
    expect(fake.execLog).toEqual([FILE_INIT.sql, FILE_SMOKE.sql, FILE_THIRD.sql]);
  });

  it('records (name, applied_at, sha256 checksum) for each applied migration', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    expect(fake.applied).toHaveLength(2);
    expect(fake.applied[0]?.name).toBe('0001_init');
    expect(fake.applied[0]?.checksum).toBe(sha256(FILE_INIT.sql));
    expect(fake.applied[0]?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 leading
    expect(fake.applied[1]?.name).toBe('0002_smoke');
    expect(fake.applied[1]?.checksum).toBe(sha256(FILE_SMOKE.sql));
  });

  it('is idempotent on re-run: skips files already in schema_migrations', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    const firstRunCount = fake.applied.length;
    const firstRunCommits = fake.transactionsCommitted;

    // Second run with the same files — nothing new should apply.
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });

    expect(fake.applied).toHaveLength(firstRunCount);
    expect(fake.transactionsCommitted).toBe(firstRunCommits);
  });

  it('rolls back and rethrows when a migration SQL fails (no row written)', () => {
    const fake = makeFakeDb({ failOnSql: 'CREATE TABLE smoke' });

    // 0001_init applies cleanly; 0002_smoke fails inside its transaction.
    expect(() => {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    }).toThrow(/forced failure/);

    // 0001_init's row IS present (it committed); 0002_smoke's row is NOT.
    expect(fake.applied.map((r) => r.name)).toEqual(['0001_init']);
    expect(fake.transactionsCommitted).toBe(1);
    expect(fake.transactionsRolledBack).toBe(1);
  });

  it('halt-launch semantics: thrown error propagates so app.whenReady can app.exit(1)', () => {
    const fake = makeFakeDb({ failOnSql: 'CREATE TABLE smoke' });
    let caughtMessage: string | null = null;
    try {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMessage).not.toBeNull();
    expect(caughtMessage).toMatch(/forced failure/);
  });

  // ── `-- @no-wrap-transaction` opt-out (Wave 5e — Slice 4) ───────────────
  //
  // Some migrations cannot safely run inside the runner's default
  // transaction wrap. The first concrete case is the
  // `payment_attempts.failure_reason` enum extension (0019), which needs
  // `PRAGMA foreign_keys = OFF` around a table rebuild; SQLite documents
  // that PRAGMA as a no-op inside a transaction, so the migration must
  // emit its own BEGIN/COMMIT pair and the runner must not wrap.
  describe('-- @no-wrap-transaction opt-out', () => {
    const MARKER_FILE: MigrationFile = {
      name: '0099_opt_out',
      sql:
        '-- @no-wrap-transaction\n' +
        '-- migration that manages its own transaction boundaries\n' +
        'PRAGMA foreign_keys = OFF;\n' +
        'BEGIN;\n' +
        'CREATE TABLE rebuilt (id INTEGER PRIMARY KEY);\n' +
        'COMMIT;\n' +
        'PRAGMA foreign_keys = ON;\n',
    };

    it('runs the migration SQL OUTSIDE the runner transaction wrap when marker present', () => {
      const fake = makeFakeDb();
      runMigrations({ db: fake.db, files: [MARKER_FILE] });
      // Exec log shows the migration SQL was executed; transaction count
      // shows exactly ONE transaction committed — the bookkeeping-only
      // one, NOT the migration wrap.
      expect(fake.execLog).toContain(MARKER_FILE.sql);
      expect(fake.transactionsCommitted).toBe(1);
      expect(fake.applied.map((r) => r.name)).toEqual(['0099_opt_out']);
    });

    it('still records the bookkeeping row in a (separate) transaction', () => {
      const fake = makeFakeDb();
      runMigrations({ db: fake.db, files: [MARKER_FILE] });
      // recordApplied was committed (one transaction) and persisted.
      expect(fake.applied).toHaveLength(1);
      expect(fake.applied[0]?.name).toBe('0099_opt_out');
      expect(fake.applied[0]?.checksum).toBe(sha256(MARKER_FILE.sql));
    });

    it('default behaviour (no marker) still wraps in one transaction', () => {
      const fake = makeFakeDb();
      runMigrations({ db: fake.db, files: [FILE_INIT] });
      // FILE_INIT has no marker — runner wraps SQL + bookkeeping together.
      expect(fake.transactionsCommitted).toBe(1);
      expect(fake.applied.map((r) => r.name)).toEqual(['0001_init']);
    });

    it('does NOT record applied row if a marker migration throws', () => {
      const failing: MigrationFile = {
        name: '0098_opt_out_failing',
        sql:
          '-- @no-wrap-transaction\n' +
          'BEGIN;\n' +
          'CREATE TABLE will_fail (-- forced failure marker --);\n' +
          'COMMIT;\n',
      };
      const fake = makeFakeDb({ failOnSql: 'forced failure marker' });
      let caught: unknown = null;
      try {
        runMigrations({ db: fake.db, files: [failing] });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      // Bookkeeping was NOT written — next boot will see this migration as
      // still pending and retry it (migration author is responsible for
      // idempotency in the body).
      expect(fake.applied).toEqual([]);
    });

    it('only scans the first 10 lines for the marker (defence-in-depth)', () => {
      // A migration that mentions `-- @no-wrap-transaction` deep in the
      // file (past line 10) should NOT opt out — the marker is a header
      // contract, not a free-text comment.
      const lateMarker: MigrationFile = {
        name: '0097_late_marker',
        sql:
          'CREATE TABLE a (id INTEGER);\n' +
          'CREATE TABLE b (id INTEGER);\n' +
          'CREATE TABLE c (id INTEGER);\n' +
          'CREATE TABLE d (id INTEGER);\n' +
          'CREATE TABLE e (id INTEGER);\n' +
          'CREATE TABLE f (id INTEGER);\n' +
          'CREATE TABLE g (id INTEGER);\n' +
          'CREATE TABLE h (id INTEGER);\n' +
          'CREATE TABLE i (id INTEGER);\n' +
          'CREATE TABLE j (id INTEGER);\n' +
          'CREATE TABLE k (id INTEGER);\n' +
          '-- @no-wrap-transaction (too late — past line 10)\n' +
          'CREATE TABLE l (id INTEGER);\n',
      };
      const fake = makeFakeDb();
      runMigrations({ db: fake.db, files: [lateMarker] });
      // Wrapped path: one committed transaction containing both the SQL
      // exec and the bookkeeping insert.
      expect(fake.transactionsCommitted).toBe(1);
      expect(fake.applied.map((r) => r.name)).toEqual(['0097_late_marker']);
    });
  });
});

/**
 * RT-320 — roll-forward safety (ADR-0006 rule 2). A build must never run on a
 * database that a newer build has migrated: `schema_migrations` naming a file
 * this build does not ship means the DB is ahead of the code.
 */
describe('runMigrations — SchemaAheadGuard (RT-320)', () => {
  it('refuses with SchemaAheadError naming the unknown migrations', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE, FILE_THIRD] });

    // An older build ships only 0001 and 0002.
    let caught: unknown = null;
    try {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaAheadError);
    expect((caught as SchemaAheadError).unknownMigrations).toEqual(['0003_more']);
  });

  it('applies nothing when it refuses, even if the older build has its own pending file', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_THIRD] });
    const commitsBefore = fake.transactionsCommitted;

    // This build knows 0001 + 0002 but not 0003: 0002 is pending, 0003 is unknown.
    expect(() => {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    }).toThrow(SchemaAheadError);
    expect(fake.applied.map((r) => r.name)).toEqual(['0001_init', '0003_more']);
    expect(fake.transactionsCommitted).toBe(commitsBefore);
  });

  it('starts normally when the database matches the build', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    expect(() => {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    }).not.toThrow();
  });

  it('starts normally and applies pending files when the database is behind the build', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT] });
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE] });
    expect(fake.applied.map((r) => r.name)).toEqual(['0001_init', '0002_smoke']);
  });
});

/**
 * RT-320 — pre-migration snapshot hook (ADR-0006 rule 4). The runner tells the
 * caller once, before the first pending file, so the caller can copy the DB.
 */
describe('runMigrations — onBeforeApply hook (RT-320)', () => {
  it('fires once, before the first pending file, with the pending names', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT] });

    const calls: Array<{ pending: readonly string[]; appliedAtCall: number }> = [];
    runMigrations({
      db: fake.db,
      files: [FILE_INIT, FILE_SMOKE, FILE_THIRD],
      onBeforeApply: (pending) => {
        calls.push({ pending, appliedAtCall: fake.applied.length });
      },
    });

    expect(calls).toEqual([{ pending: ['0002_smoke', '0003_more'], appliedAtCall: 1 }]);
  });

  it('does not fire when nothing is pending', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT] });
    const onBeforeApply = vi.fn();
    runMigrations({ db: fake.db, files: [FILE_INIT], onBeforeApply });
    expect(onBeforeApply).not.toHaveBeenCalled();
  });

  it('does not fire on a fresh database (nothing to protect yet)', () => {
    const fake = makeFakeDb();
    const onBeforeApply = vi.fn();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE], onBeforeApply });
    expect(onBeforeApply).not.toHaveBeenCalled();
    expect(fake.applied).toHaveLength(2);
  });

  it('does not fire when the SchemaAheadGuard refuses', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT, FILE_THIRD] });
    const onBeforeApply = vi.fn();
    expect(() => {
      runMigrations({ db: fake.db, files: [FILE_INIT, FILE_SMOKE], onBeforeApply });
    }).toThrow(SchemaAheadError);
    expect(onBeforeApply).not.toHaveBeenCalled();
  });

  it('applies nothing and rethrows when the hook throws (no migration without a snapshot)', () => {
    const fake = makeFakeDb();
    runMigrations({ db: fake.db, files: [FILE_INIT] });
    expect(() => {
      runMigrations({
        db: fake.db,
        files: [FILE_INIT, FILE_SMOKE],
        onBeforeApply: () => {
          throw new Error('disk full');
        },
      });
    }).toThrow(/disk full/);
    expect(fake.applied.map((r) => r.name)).toEqual(['0001_init']);
  });
});

/**
 * Coverage for the filesystem adapter. Uses a real temp dir — no native
 * binding involved, so safe in Vitest (R1 stays clean).
 */
describe('readMigrationsFromDisk', () => {
  function makeTempMigrationsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pos-pulse-mig-'));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), contents, 'utf8');
    }
    return dir;
  }

  it('returns *.sql files sorted by name, with extension stripped', () => {
    const dir = makeTempMigrationsDir({
      '0002_b.sql': 'SELECT 2;',
      '0001_a.sql': 'SELECT 1;',
      'README.md': 'not a migration',
    });
    try {
      const files = readMigrationsFromDisk(dir);
      expect(files).toEqual([
        { name: '0001_a', sql: 'SELECT 1;' },
        { name: '0002_b', sql: 'SELECT 2;' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores subdirectories and non-.sql files', () => {
    const dir = makeTempMigrationsDir({ '0001_a.sql': 'SELECT 1;' });
    try {
      mkdirSync(path.join(dir, 'subdir'));
      writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');
      const files = readMigrationsFromDisk(dir);
      expect(files.map((f) => f.name)).toEqual(['0001_a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Coverage for the better-sqlite3 → MigrationsDb adapter. Uses a hand-rolled
 * mock DatabaseHandle so we never load the native binding (R1).
 */
describe('bindMigrationsDb', () => {
  type StmtMock = {
    all: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };

  function makeMockHandle(opts: { selectRows?: Array<{ name: string }> } = {}): {
    handle: DatabaseHandle;
    prepareSpy: ReturnType<typeof vi.fn>;
    insertStmt: StmtMock;
    selectStmt: StmtMock;
    execCalls: string[];
    transactionCalls: number;
  } {
    const insertStmt: StmtMock = { all: vi.fn(), run: vi.fn() };
    const selectStmt: StmtMock = { all: vi.fn(() => opts.selectRows ?? []), run: vi.fn() };
    const execCalls: string[] = [];
    let transactionCalls = 0;

    const prepareSpy = vi.fn((sql: string) => {
      if (/INSERT INTO schema_migrations/i.test(sql)) return insertStmt;
      if (/SELECT name FROM schema_migrations/i.test(sql)) return selectStmt;
      return { all: vi.fn(), run: vi.fn() };
    });

    const handle = {
      pragma: vi.fn(),
      prepare: prepareSpy,
      exec: vi.fn((sql: string) => {
        execCalls.push(sql);
      }),
      // better-sqlite3's transaction() returns a wrapped callable; mimic that
      // here. The cast below bridges to the generic `DatabaseHandle.transaction`
      // signature without losing the runtime behavior tests rely on.
      transaction: vi.fn((fn: (...args: never[]) => unknown) => {
        return (...args: never[]) => {
          transactionCalls += 1;
          return fn(...args);
        };
      }),
      close: vi.fn(),
    } as unknown as DatabaseHandle;
    return {
      handle,
      prepareSpy,
      insertStmt,
      selectStmt,
      execCalls,
      get transactionCalls(): number {
        return transactionCalls;
      },
    };
  }

  it('exec forwards to the underlying handle', () => {
    const m = makeMockHandle();
    const db = bindMigrationsDb(m.handle);
    db.exec('CREATE TABLE x (id INT);');
    expect(m.execCalls).toContain('CREATE TABLE x (id INT);');
  });

  it('does not prepare any statement at bind time (lazy preparation)', () => {
    // Regression: eager prepare crashed on a fresh DB because
    // schema_migrations did not exist yet. Statements must be deferred until
    // first use, so the runner's bootstrap CREATE TABLE has time to run.
    const m = makeMockHandle();
    bindMigrationsDb(m.handle);
    expect(m.prepareSpy).not.toHaveBeenCalled();
  });

  it('listAppliedNames returns names from the prepared select', () => {
    const m = makeMockHandle({ selectRows: [{ name: '0001_init' }, { name: '0002_more' }] });
    const db = bindMigrationsDb(m.handle);
    expect(db.listAppliedNames()).toEqual(['0001_init', '0002_more']);
    expect(m.selectStmt.all).toHaveBeenCalledTimes(1);
  });

  it('recordApplied runs the prepared insert with positional params', () => {
    const m = makeMockHandle();
    const db = bindMigrationsDb(m.handle);
    const row: AppliedRow = {
      name: '0001_init',
      applied_at: '2026-05-02T00:00:00.000Z',
      checksum: 'abc',
    };
    db.recordApplied(row);
    expect(m.insertStmt.run).toHaveBeenCalledWith('0001_init', '2026-05-02T00:00:00.000Z', 'abc');
  });

  it('transaction wraps fn via handle.transaction and invokes the wrapped callable', () => {
    const m = makeMockHandle();
    const db = bindMigrationsDb(m.handle);
    let ran = false;
    const result = db.transaction(() => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(m.transactionCalls).toBe(1);
  });
});

/**
 * 002-terminal-pairing T007 — `0003_terminal_assignment.sql` migration tests.
 *
 * The CHECK (id = 1) constraint is a behavioural guarantee, not a textual one,
 * so this suite executes the migration SQL against a real SQLite engine.
 * Production uses `better-sqlite3` via Electron's rebuilt ABI; loading that
 * native binary in Vitest (system Node) crashes with NODE_MODULE_VERSION
 * mismatch (R1, see client.test.ts header). We use `sql.js` (pure-JS SQLite-
 * compiled-to-WASM) as the unit-test engine. CHECK / NOT NULL / PRIMARY KEY
 * semantics in sql.js match SQLite proper because it IS SQLite. The native
 * better-sqlite3 path remains exercised by the manual smoke (T079).
 */

const __dirnameForMigrationFile = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(
  __dirnameForMigrationFile,
  '..',
  '..',
  '..',
  '..',
  'migrations',
);
const MIGRATION_NAME = '0003_terminal_assignment';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.sql`);

async function openInMemoryDb(): Promise<SqlJsDatabase> {
  // sql.js's default export is an init promise that resolves to the SQL module.
  // Calling with no options uses the bundled WASM (no fs / network).
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function readMigrationSql(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

describe('migration 0003_terminal_assignment', () => {
  it('applies cleanly against a fresh SQLite database', async () => {
    const db = await openInMemoryDb();
    try {
      const sql = readMigrationSql();
      expect(() => db.run(sql)).not.toThrow();
      // Sanity: the table exists and accepts the canonical row.
      expect(() =>
        db.run(
          `INSERT INTO terminal_assignment
             (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
           VALUES (1, 't1', 'b1', 'term-1', 'Counter 1', 1735689600)`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('CHECK (id = 1) rejects a second-row insert with id != 1', async () => {
    const db = await openInMemoryDb();
    try {
      db.run(readMigrationSql());
      // First row at id=1 is fine.
      db.run(
        `INSERT INTO terminal_assignment
           (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
         VALUES (1, 't1', 'b1', 'term-1', 'Counter 1', 1735689600)`,
      );
      // Any other id MUST fail the CHECK constraint.
      expect(() =>
        db.run(
          `INSERT INTO terminal_assignment
             (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
           VALUES (2, 't2', 'b2', 'term-2', 'Counter 2', 1735689601)`,
        ),
      ).toThrow(/CHECK constraint/i);
    } finally {
      db.close();
    }
  });

  it('PRIMARY KEY (id) blocks a duplicate insert at id=1', async () => {
    // Belt-and-braces: even if the CHECK is somehow bypassed, the PRIMARY KEY
    // still prevents a second row at id=1. Together they enforce "at most one row".
    const db = await openInMemoryDb();
    try {
      db.run(readMigrationSql());
      db.run(
        `INSERT INTO terminal_assignment
           (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
         VALUES (1, 't1', 'b1', 'term-1', 'Counter 1', 1735689600)`,
      );
      expect(() =>
        db.run(
          `INSERT INTO terminal_assignment
             (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at)
           VALUES (1, 't9', 'b9', 'term-9', 'Counter 9', 1735689602)`,
        ),
      ).toThrow(/UNIQUE|PRIMARY KEY/i);
    } finally {
      db.close();
    }
  });

  it('every column except id has NOT NULL enforced', async () => {
    const db = await openInMemoryDb();
    try {
      db.run(readMigrationSql());
      // Try to insert with each NOT NULL column nulled in turn. SQLite reports
      // "NOT NULL constraint failed: <table>.<col>".
      const required = ['tenant_id', 'branch_id', 'terminal_id', 'terminal_label', 'paired_at'];
      for (const col of required) {
        const cols = ['id', 'tenant_id', 'branch_id', 'terminal_id', 'terminal_label', 'paired_at'];
        const values: Record<string, string | number | null> = {
          id: 1,
          tenant_id: 't',
          branch_id: 'b',
          terminal_id: 'term',
          terminal_label: 'Counter',
          paired_at: 1735689600,
        };
        values[col] = null;
        const placeholders = cols.map((c) => JSON.stringify(values[c])).join(', ');
        expect(() =>
          db.run(`INSERT INTO terminal_assignment (${cols.join(', ')}) VALUES (${placeholders})`),
        ).toThrow(/NOT NULL constraint/i);
        // Reset between iterations.
        db.run('DELETE FROM terminal_assignment');
      }
    } finally {
      db.close();
    }
  });

  it('migration file is recorded as applied by the runMigrations runner (idempotent on re-run)', () => {
    // Runner-level integration: read the real on-disk file via the existing
    // adapter and confirm runMigrations records it once and skips it on rerun.
    const all = readMigrationsFromDisk(MIGRATIONS_DIR);
    const file = all.find((f) => f.name === MIGRATION_NAME);
    expect(file).toBeDefined();
    if (!file) return;

    // Use the in-memory MigrationsDb fake (SQL never executes here — we only
    // exercise the runner's bookkeeping path; SQL semantics are covered by the
    // sql.js suite above).
    const applied: AppliedRow[] = [];
    let schemaMigrationsTableCreated = false;
    const execLog: string[] = [];
    const fakeDb: MigrationsDb = {
      exec(sql: string): void {
        if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
          schemaMigrationsTableCreated = true;
          return;
        }
        execLog.push(sql);
      },
      listAppliedNames(): string[] {
        return applied.map((r) => r.name);
      },
      recordApplied(row: AppliedRow): void {
        applied.push(row);
      },
      transaction<T>(fn: () => T): T {
        return fn();
      },
    };

    runMigrations({ db: fakeDb, files: [file] });
    expect(schemaMigrationsTableCreated).toBe(true);
    expect(applied.map((r) => r.name)).toEqual([MIGRATION_NAME]);
    expect(execLog).toContain(file.sql);

    // Second run — no new rows, no re-exec.
    const execCountBefore = execLog.length;
    runMigrations({ db: fakeDb, files: [file] });
    expect(applied.map((r) => r.name)).toEqual([MIGRATION_NAME]);
    expect(execLog.length).toBe(execCountBefore);
  });
});
