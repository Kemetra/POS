import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentAttemptsRepository } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import {
  bindPaymentActionOutboxRepository,
  computeActionPayloadHash,
} from '../../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

/**
 * T113 — `payment_action_outbox` repository tests.
 *
 * Surface mandated by tasks.md T113:
 *   insert / lookup-by-action-id; computes `action_payload_hash`
 *   over redacted canonical payload (research §R-10).
 *
 * The hash function MUST be deterministic on a canonical-form payload so
 * S3b's idempotency replay can compare identical-payload retries (no-op)
 * against payload-mismatch retries (refuse).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS = [
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
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

function seedAttempt(handle = makeSqlJsHandle(db)): void {
  const repo = bindPaymentAttemptsRepository(handle);
  repo.insert({
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
  });
}

describe('T113 — payment_action_outbox repository', () => {
  it('insert + findByActionId round-trips an attempt-level row', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentActionOutboxRepository(handle);
    repo.insert({
      action_id: 'action-1',
      payment_attempt_id: 'attempt-1',
      tender_line_id: null,
      action_kind: 'payment.attempt.start',
      action_payload_hash: 'a'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:00.000Z',
    });
    const row = repo.findByActionId('action-1');
    expect(row).toBeDefined();
    expect(row?.action_kind).toBe('payment.attempt.start');
    expect(row?.tender_line_id).toBeNull();
  });

  it('findByActionId returns undefined for an unknown action_id', () => {
    const repo = bindPaymentActionOutboxRepository(makeSqlJsHandle(db));
    expect(repo.findByActionId('nope')).toBeUndefined();
  });

  it('insert rejects a duplicate action_id (idempotency key clash)', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentActionOutboxRepository(handle);
    const row = {
      action_id: 'action-1',
      payment_attempt_id: 'attempt-1',
      tender_line_id: null,
      action_kind: 'payment.attempt.start' as const,
      action_payload_hash: 'a'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:00.000Z',
    };
    repo.insert(row);
    expect(() => {
      repo.insert(row);
    }).toThrow();
  });

  describe('computeActionPayloadHash', () => {
    it('produces a 64-character hex SHA-256 string', () => {
      const hash = computeActionPayloadHash({ idempotency_key: 'k1', amount_applied_minor: 1500 });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns identical hashes for two payloads with the same fields in different key order', () => {
      const h1 = computeActionPayloadHash({ amount_applied_minor: 1500, tender_type: 'cash' });
      const h2 = computeActionPayloadHash({ tender_type: 'cash', amount_applied_minor: 1500 });
      expect(h1).toBe(h2);
    });

    it('orders keys by code unit, not by locale, so stored hashes stay stable', () => {
      const canonical = '{"B":2,"_x":3,"a":1}';
      const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
      expect(computeActionPayloadHash({ a: 1, _x: 3, B: 2 })).toBe(expected);
    });

    it('returns different hashes when any field value changes', () => {
      const h1 = computeActionPayloadHash({ amount_applied_minor: 1500 });
      const h2 = computeActionPayloadHash({ amount_applied_minor: 1501 });
      expect(h1).not.toBe(h2);
    });

    it('handles nested objects and arrays deterministically', () => {
      const h1 = computeActionPayloadHash({
        lines: [
          { id: 'a', n: 1 },
          { id: 'b', n: 2 },
        ],
        meta: { x: 1, y: 2 },
      });
      const h2 = computeActionPayloadHash({
        meta: { y: 2, x: 1 },
        lines: [
          { n: 1, id: 'a' },
          { n: 2, id: 'b' },
        ],
      });
      expect(h1).toBe(h2);
    });

    it('throws on a cyclic object reference (stack-safety guard)', () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(() => computeActionPayloadHash(cyclic)).toThrow(/cycles/);
    });

    it('throws on a cyclic array reference (stack-safety guard)', () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => computeActionPayloadHash(arr)).toThrow(/cycles/);
    });

    it('handles the same plain object referenced twice without throwing (DAG, not cycle)', () => {
      const shared = { x: 1 };
      // Two siblings reference `shared` — that is NOT a cycle, just a DAG.
      // The seen-set logic must remove `shared` from `seen` after visiting it
      // so the second sibling re-encounter does not falsely trigger.
      const payload = { a: shared, b: shared };
      expect(() => computeActionPayloadHash(payload)).not.toThrow();
    });
  });
});
