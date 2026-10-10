/**
 * RT-352 — migration-shape test for `0046_carts_owner_key_index`: an index
 * only, on the held-cart owner key, partial on non-cancelled carts, and the
 * sign-in owner-key lookup uses it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');
const sql = (name: string): string => readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('0046 — carts owner-key index', () => {
  it('adds a partial index on the owner key and nothing else', () => {
    const db = new SQL.Database();
    db.exec(sql('0008_carts.sql'));
    const columnsBefore = db.exec('PRAGMA table_info(carts)')[0]?.values;

    db.exec(sql('0046_carts_owner_key_index.sql'));
    db.exec(sql('0046_carts_owner_key_index.sql')); // IF NOT EXISTS: re-run safe

    const index = db.exec(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_carts_owner_key'`,
    )[0]?.values[0]?.[0] as string;
    expect(index).toMatch(/\(tenant_id, branch_id, terminal_id, owning_operator_id\)/);
    expect(index).toMatch(/WHERE state <> 'cancelled'/);
    expect(db.exec('PRAGMA table_info(carts)')[0]?.values).toEqual(columnsBefore);

    const plan = db
      .exec(
        `EXPLAIN QUERY PLAN SELECT cart_id FROM carts
          WHERE tenant_id = 't' AND branch_id = 'b' AND terminal_id = 'x'
            AND owning_operator_id = 'o' AND state <> 'cancelled'
            AND state IN ('editing', 'discount_pending_attribution')`,
      )[0]
      ?.values.map((row) => String(row[3]))
      .join(' ');
    expect(plan).toContain('idx_carts_owner_key');
    db.close();
  });
});
