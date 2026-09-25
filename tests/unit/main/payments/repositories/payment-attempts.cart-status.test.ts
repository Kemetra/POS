import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
} from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

/**
 * Read-only per-cart payment status, the single source for the post-handoff
 * cancel guard, the snapshot "paid" flag and the payments.start re-pay check.
 * Precedence: settled > started > force_failed > none. Cancelled and failed
 * attempts are history, not a live payment.
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

function insertAttempt(id: string, cartId: string): void {
  bindPaymentAttemptsRepository(makeSqlJsHandle(db)).insert({
    payment_attempt_id: id,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: `terminal-${id}`,
    acting_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: cartId,
    envelope_subtotal_minor: 1500,
    started_at: '2026-09-25T10:00:00.000Z',
    last_action_id: `action-${id}`,
  });
}

function transition(id: string, state: 'settled' | 'cancelled' | 'failed' | 'force_failed'): void {
  const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
  const base = {
    payment_attempt_id: id,
    timestamp: '2026-09-25T10:02:00.000Z',
    last_action_id: `action-${id}-2`,
  };
  if (state === 'failed') repo.updateState({ ...base, state, failure_reason: 'internal_error' });
  else if (state === 'force_failed')
    repo.updateState({
      ...base,
      state,
      failure_reason: 'internal_error',
      force_fail_attribution_operator_id: 'mgr-1',
    });
  else repo.updateState({ ...base, state });
}

const status = (cartId = 'cart-1'): string => bindCartPaymentStatus(makeSqlJsHandle(db))(cartId);

describe('bindCartPaymentStatus', () => {
  it('is none for a cart with no payment attempt', () => {
    expect(status()).toBe('none');
  });

  it('is started while an attempt for the cart is in progress', () => {
    insertAttempt('a1', 'cart-1');
    expect(status()).toBe('started');
  });

  it('is settled once an attempt for the cart has settled', () => {
    insertAttempt('a1', 'cart-1');
    transition('a1', 'settled');
    expect(status()).toBe('settled');
  });

  it('is force_failed when a stuck attempt was force-failed by a manager', () => {
    insertAttempt('a1', 'cart-1');
    transition('a1', 'force_failed');
    expect(status()).toBe('force_failed');
  });

  it.each(['cancelled', 'failed'] as const)('is none when the only attempt is %s', (state) => {
    insertAttempt('a1', 'cart-1');
    transition(state === 'cancelled' ? 'a1' : 'a1', state);
    expect(status()).toBe('none');
  });

  it('reports settled over an earlier force-failed attempt for the same cart', () => {
    insertAttempt('a1', 'cart-1');
    transition('a1', 'force_failed');
    insertAttempt('a2', 'cart-1');
    transition('a2', 'settled');
    expect(status()).toBe('settled');
  });

  it('ignores attempts that belong to another cart', () => {
    insertAttempt('a1', 'cart-other');
    transition('a1', 'settled');
    expect(status()).toBe('none');
  });
});
