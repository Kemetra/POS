/**
 * `bindAttemptHasLiveTender` — "has money touched this attempt?" (§A4 review,
 * 2026-09-26). An attempt holds live tender while any line is `applying`,
 * `applied` or `reversal_pending`. `refused` and `reversed` lines are history.
 * Real sql.js database with the production migrations.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  bindAttemptHasLiveTender,
  bindPaymentAttemptsRepository,
} from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
  bindPaymentAttemptsRepository(makeSqlJsHandle(db)).insert({
    payment_attempt_id: 'a1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 5500,
    started_at: '2026-09-26T09:01:00.000Z',
    last_action_id: 'a-action-1',
  });
});

function addTender(id: string, state: string, order: number): void {
  db.run(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor, state,
       attribution_operator_id, apply_order, last_action_id
     ) VALUES (?, 'a1', 'cash', 1000, ?, 'op-1', ?, ?)`,
    [id, state, order, `${id}-action`],
  );
}

describe('bindAttemptHasLiveTender', () => {
  it('is false for an attempt with no tender lines, and for an unknown attempt', () => {
    const has = bindAttemptHasLiveTender(makeSqlJsHandle(db));
    expect(has('a1')).toBe(false);
    expect(has('unknown')).toBe(false);
  });

  it.each(['applying', 'applied', 'reversal_pending'])('is true when a line is %s', (state) => {
    addTender('t1', 'reversed', 1);
    addTender('t2', state, 2);
    expect(bindAttemptHasLiveTender(makeSqlJsHandle(db))('a1')).toBe(true);
  });

  it('is false when every line is reversed or refused', () => {
    addTender('t1', 'reversed', 1);
    addTender('t2', 'refused', 2);
    expect(bindAttemptHasLiveTender(makeSqlJsHandle(db))('a1')).toBe(false);
  });
});
