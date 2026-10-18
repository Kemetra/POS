import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentAttemptsRepository } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

/**
 * T111 — `payment_attempts` repository tests.
 *
 * Surface mandated by tasks.md T111:
 *   insert / update-state / read-by-id / read-by-terminal-where-started
 *   (uses the partial unique index from migration 0013).
 *
 * The repository wraps the production `DatabaseHandle` interface; tests use
 * the same sql.js adapter the cart tests use (no native better-sqlite3
 * binding required).
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
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

function buildAttempt(
  overrides: Partial<
    Parameters<ReturnType<typeof bindPaymentAttemptsRepository>['insert']>[0]
  > = {},
) {
  return {
    payment_attempt_id: 'attempt-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    started_at: '2026-05-22T10:00:00.000Z',
    last_action_id: 'action-1',
    ...overrides,
  };
}

describe('T111 — payment_attempts repository', () => {
  it('insert + read-by-id round-trips a started attempt', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    const row = repo.findById('attempt-1');
    expect(row).toBeDefined();
    expect(row?.state).toBe('started');
    expect(row?.envelope_subtotal_minor).toBe(1500);
    expect(row?.failure_reason).toBeNull();
    expect(row?.settled_at).toBeNull();
  });

  it('findById returns undefined for an unknown id', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    expect(repo.findById('nope')).toBeUndefined();
  });

  it('updateState to settled writes settled_at and clears the started timestamp slot', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    repo.updateState({
      payment_attempt_id: 'attempt-1',
      state: 'settled',
      timestamp: '2026-05-22T10:03:00.000Z',
      last_action_id: 'action-2',
    });
    const row = repo.findById('attempt-1');
    expect(row?.state).toBe('settled');
    expect(row?.settled_at).toBe('2026-05-22T10:03:00.000Z');
    expect(row?.last_action_id).toBe('action-2');
  });

  it('updateState to cancelled writes cancelled_at', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    repo.updateState({
      payment_attempt_id: 'attempt-1',
      state: 'cancelled',
      timestamp: '2026-05-22T10:04:00.000Z',
      last_action_id: 'action-2',
    });
    expect(repo.findById('attempt-1')?.cancelled_at).toBe('2026-05-22T10:04:00.000Z');
  });

  it('updateState to failed writes failed_at + failure_reason', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    repo.updateState({
      payment_attempt_id: 'attempt-1',
      state: 'failed',
      timestamp: '2026-05-22T10:05:00.000Z',
      last_action_id: 'action-2',
      failure_reason: 'tender_underpaid',
    });
    const row = repo.findById('attempt-1');
    expect(row?.state).toBe('failed');
    expect(row?.failed_at).toBe('2026-05-22T10:05:00.000Z');
    expect(row?.failure_reason).toBe('tender_underpaid');
  });

  it('updateState to force_failed writes force_failed_at + manager attribution', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    repo.updateState({
      payment_attempt_id: 'attempt-1',
      state: 'force_failed',
      timestamp: '2026-05-22T10:06:00.000Z',
      last_action_id: 'action-2',
      failure_reason: 'internal_error',
      force_fail_attribution_operator_id: 'mgr-xyz',
    });
    const row = repo.findById('attempt-1');
    expect(row?.state).toBe('force_failed');
    expect(row?.force_failed_at).toBe('2026-05-22T10:06:00.000Z');
    expect(row?.force_fail_attribution_operator_id).toBe('mgr-xyz');
  });

  it('findStartedByTerminal returns the in-flight attempt on a terminal', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt({ payment_attempt_id: 'a-1', terminal_id: 'terminal-A' }));
    repo.insert(buildAttempt({ payment_attempt_id: 'a-2', terminal_id: 'terminal-B' }));
    const found = repo.findStartedByTerminal('terminal-A');
    expect(found?.payment_attempt_id).toBe('a-1');
  });

  it('findStartedByTerminal returns undefined after the attempt settles', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt());
    repo.updateState({
      payment_attempt_id: 'attempt-1',
      state: 'settled',
      timestamp: '2026-05-22T10:03:00.000Z',
      last_action_id: 'action-2',
    });
    expect(repo.findStartedByTerminal('terminal-1')).toBeUndefined();
  });

  it('insert raises when the partial unique index is violated', () => {
    const repo = bindPaymentAttemptsRepository(makeSqlJsHandle(db));
    repo.insert(buildAttempt({ payment_attempt_id: 'a-1' }));
    expect(() => {
      repo.insert(buildAttempt({ payment_attempt_id: 'a-2' }));
    }).toThrow();
  });
});
