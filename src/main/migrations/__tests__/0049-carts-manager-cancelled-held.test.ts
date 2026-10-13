/**
 * RT-441 (RT-116 S6) — `0049_carts_manager_cancelled_held` ([GATED],
 * owner-approved 2026-10-12): the `carts` rebuild that adds
 * `manager_cancelled_held` to `cancellation_reason`. On the full stack:
 *   • the number right after 0048, and only it;
 *   • the new reason is accepted, an unknown one still refused;
 *   • rows written before it survive the rebuild unchanged;
 *   • every index is re-created (0008's three and 0046's owner-key index).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  MIGRATIONS_DIR,
  freshGrantDb,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0049_carts_manager_cancelled_held';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const NOW = '2026-10-13T09:00:00.000Z';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  db = freshGrantDb();
});

afterEach(() => {
  db.close();
});

function insert(cart_id: string, reason: string | null): void {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at,
       cancelled_at, cancellation_reason, last_action_id)
     VALUES (?, 't', 'b', 'term', 'op', 's', ?, 100, ?, ?, ?, ?, 'a')`,
    [
      cart_id,
      reason === null ? 'editing' : 'cancelled',
      NOW,
      NOW,
      reason === null ? null : NOW,
      reason,
    ],
  );
}

const value = (sql: string): unknown => db.exec(sql)[0]?.values[0]?.[0];

describe('0049 — carts.cancellation_reason gains manager_cancelled_held', () => {
  it('takes the number right after 0048, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0048_manager_approvals.sql');
    expect(names.filter((n) => n.startsWith('0049_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('accepts the new reason and still refuses an unknown one', () => {
    insert('c-1', 'manager_cancelled_held');
    expect(value(`SELECT cancellation_reason FROM carts WHERE cart_id = 'c-1'`)).toBe(
      'manager_cancelled_held',
    );
    expect(() => {
      insert('c-2', 'made_up');
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps every row through a rebuild, and re-creates the indexes', () => {
    insert('c-old', 'cashier_voided');
    insert('c-open', null);
    db.exec(SQL_TEXT); // a second rebuild over existing rows
    expect(value('SELECT COUNT(*) FROM carts')).toBe(2);
    expect(value(`SELECT cancellation_reason FROM carts WHERE cart_id = 'c-old'`)).toBe(
      'cashier_voided',
    );
    const indexes = db
      .exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'carts'`)[0]
      ?.values.map((v) => v[0]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_carts_tenant_branch',
        'idx_carts_owning_operator',
        'idx_carts_state',
        'idx_carts_owner_key',
      ]),
    );
  });
});
