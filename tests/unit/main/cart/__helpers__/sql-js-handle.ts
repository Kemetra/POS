/**
 * Test helper: adapt sql.js to the production `DatabaseHandle` interface
 * so cart-store + cart-bridge can run unmodified under Vitest.
 *
 * sql.js is pure-JS WASM SQLite and loads in Node without the Electron-
 * rebuilt better-sqlite3 binary. Production wiring uses better-sqlite3.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import type { DatabaseHandle } from '../../../../../src/main/db/client.js';

export function makeSqlJsHandle(db: SqlJsDatabase): DatabaseHandle {
  let depth = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pragma(_sql: string): unknown {
      return null;
    },

    prepare(sql: string): unknown {
      // Lazily compile per call so each invocation runs fresh statements
      // and Vitest test ordering does not depend on cached state.
      return {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
          const stmt = db.prepare(sql);
          const bound = bindParams(params);
          try {
            stmt.run(bound);
            return { changes: db.getRowsModified(), lastInsertRowid: 0 };
          } finally {
            stmt.free();
          }
        },
        get(...params: unknown[]): unknown {
          const stmt = db.prepare(sql);
          const bound = bindParams(params);
          try {
            stmt.bind(bound);
            if (!stmt.step()) return undefined;
            return stmt.getAsObject();
          } finally {
            stmt.free();
          }
        },
        all(...params: unknown[]): unknown[] {
          const stmt = db.prepare(sql);
          const bound = bindParams(params);
          const rows: Record<string, unknown>[] = [];
          try {
            stmt.bind(bound);
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            stmt.free();
          }
        },
      };
    },

    exec(sql: string): void {
      db.run(sql);
    },

    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      // Mirrors better-sqlite3's wrapper: the outermost call is BEGIN/COMMIT,
      // a nested call (a transaction function invoked inside another) is a
      // SAVEPOINT that rolls back only its own writes on throw.
      return ((...args: unknown[]): unknown => {
        const nested = depth > 0;
        const savepoint = `sp_${String(depth)}`;
        db.run(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
        depth += 1;
        try {
          const result = (fn as (...a: unknown[]) => unknown)(...args);
          depth -= 1;
          db.run(nested ? `RELEASE ${savepoint}` : 'COMMIT');
          return result;
        } catch (err) {
          depth -= 1;
          if (nested) {
            db.run(`ROLLBACK TO ${savepoint}`);
            db.run(`RELEASE ${savepoint}`);
          } else {
            db.run('ROLLBACK');
          }
          throw err;
        }
      }) as unknown as T;
    },

    close(): void {
      db.close();
    },
  };
}

function bindParams(params: unknown[]): (string | number | null | Uint8Array)[] {
  // sql.js BindParams cannot accept `undefined`; coerce to `null`.
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as string | number | null | Uint8Array;
  });
}
