import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  bindCartPaymentGuard,
  bindPaymentAttemptsRepository,
} from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

/**
 * Read-only per-cart payment lookup backing the post-handoff cancel guard:
 * true only while an attempt for the cart is `started` or `settled`.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS = [
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
});

function insertAttempt(id: string, cartId: string, terminalId = `terminal-${id}`): void {
  bindPaymentAttemptsRepository(makeSqlJsHandle(db)).insert({
    payment_attempt_id: id,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: terminalId,
    acting_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: cartId,
    envelope_subtotal_minor: 1500,
    started_at: '2026-09-25T10:00:00.000Z',
    last_action_id: `action-${id}`,
  });
}

function transition(id: string, state: 'settled' | 'cancelled' | 'failed'): void {
  bindPaymentAttemptsRepository(makeSqlJsHandle(db)).updateState(
    state === 'failed'
      ? {
          payment_attempt_id: id,
          state,
          timestamp: '2026-09-25T10:02:00.000Z',
          failure_reason: 'internal_error',
          last_action_id: `action-${id}-2`,
        }
      : {
          payment_attempt_id: id,
          state,
          timestamp: '2026-09-25T10:02:00.000Z',
          last_action_id: `action-${id}-2`,
        },
  );
}

describe('bindCartPaymentGuard', () => {
  it('is false for a cart with no payment attempt', () => {
    expect(bindCartPaymentGuard(makeSqlJsHandle(db))('cart-1')).toBe(false);
  });

  it('is true while an attempt for the cart is started', () => {
    insertAttempt('a1', 'cart-1');
    expect(bindCartPaymentGuard(makeSqlJsHandle(db))('cart-1')).toBe(true);
  });

  it('is true once an attempt for the cart has settled', () => {
    insertAttempt('a1', 'cart-1');
    transition('a1', 'settled');
    expect(bindCartPaymentGuard(makeSqlJsHandle(db))('cart-1')).toBe(true);
  });

  it.each(['cancelled', 'failed'] as const)('is false when the only attempt is %s', (state) => {
    insertAttempt('a1', 'cart-1');
    transition('a1', state);
    expect(bindCartPaymentGuard(makeSqlJsHandle(db))('cart-1')).toBe(false);
  });

  it('ignores attempts that belong to another cart', () => {
    insertAttempt('a1', 'cart-other');
    expect(bindCartPaymentGuard(makeSqlJsHandle(db))('cart-1')).toBe(false);
  });
});
