/**
 * RT-541 — migration-shape test for `0055_sales_finalized_at_index` ([GATED],
 * owner-authorized on Jira RT-541 comment 12093: the one index the issue
 * describes, nothing else).
 *   • the number right after 0054, and only it;
 *   • exactly `sales (tenant_id, branch_id, finalized_at)`, no column or data change;
 *   • applies on a database that already holds sales, and re-applies safely;
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0055_sales_finalized_at_index';
const INDEX = 'idx_sales_tenant_branch_finalized_at';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

function indexSql(): string | undefined {
  return db.exec(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${INDEX}'`)[0]
    ?.values[0]?.[0] as string | undefined;
}

function salesSchema(): unknown {
  return db.exec('PRAGMA table_info(sales)')[0]?.values;
}

describe('0055 - sales finalized_at index (RT-541, [GATED])', () => {
  it('is the only migration numbered 0055', () => {
    const names = readdirSync(MIGRATIONS_DIR);
    expect(names.filter((n) => n.startsWith('0055_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('indexes sales (tenant_id, branch_id, finalized_at) and nothing else', () => {
    expect(indexSql()).toMatch(/ON sales \(tenant_id, branch_id, finalized_at\)$/);
    expect(indexSql()).not.toMatch(/WHERE/i);
    // One statement, an index: no table, column, trigger or data change.
    const statements = SQL_TEXT.replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch_finalized_at/,
    );
  });

  it('applies to a database that already holds sales, keeping every row and column', () => {
    db.exec(`DROP INDEX ${INDEX};`);
    seedSale(db, { sale_id: 'sale-1', finalized_at: '2026-10-15T08:00:00.000Z' });
    seedSale(db, { sale_id: 'sale-2', finalized_at: '2026-10-16T22:30:00.000Z' });
    const columnsBefore = salesSchema();
    const rowsBefore = db.exec('SELECT * FROM sales ORDER BY sale_id')[0]?.values;

    db.exec(SQL_TEXT);
    db.exec(SQL_TEXT); // IF NOT EXISTS: a re-run is a no-op

    expect(indexSql()).toBeDefined();
    expect(salesSchema()).toEqual(columnsBefore);
    expect(db.exec('SELECT * FROM sales ORDER BY sale_id')[0]?.values).toEqual(rowsBefore);
    expect(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]).toBe('ok');
  });

  it('applies exactly once through the real runner', () => {
    db.exec(`DROP INDEX ${INDEX};`);
    seedSale(db, { sale_id: 'sale-1' });
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        db.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(indexSql()).toBeDefined();
  });
});
