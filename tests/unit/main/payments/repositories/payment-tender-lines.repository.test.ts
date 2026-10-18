import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentAttemptsRepository } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

/**
 * T112 — `payment_tender_lines` repository tests.
 *
 * Surface mandated by tasks.md T112:
 *   insert / update-state / read-by-attempt / settlement-sum query
 *   (the canonical invariant SQL from data-model §"Invariant 5").
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
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
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

function seedAttempt(handle = makeSqlJsHandle(db), envelopeSubtotalMinor = 1500): void {
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
    envelope_subtotal_minor: envelopeSubtotalMinor,
    started_at: '2026-05-22T10:00:00.000Z',
    last_action_id: 'action-0',
  });
}

function baseLine(
  overrides: Partial<
    Parameters<ReturnType<typeof bindPaymentTenderLinesRepository>['insert']>[0]
  > = {},
) {
  return {
    tender_line_id: 'line-1',
    payment_attempt_id: 'attempt-1',
    tender_type: 'cash' as const,
    amount_applied_minor: 1500,
    state: 'applied' as const,
    change_due_minor: null,
    external_reference: null,
    voucher_redemption_intent_token: null,
    voucher_authority_redemption_id: null,
    applied_at: '2026-05-22T10:00:01.000Z',
    refused_at: null,
    reversed_at: null,
    reversal_pending_since: null,
    refusal_reason: null,
    attribution_operator_id: 'op-abc',
    apply_order: 1,
    last_action_id: 'action-1',
    ...overrides,
  };
}

describe('T112 — payment_tender_lines repository', () => {
  it('insert + findByAttempt round-trips one cash line', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    const rows = repo.findByAttempt('attempt-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].tender_type).toBe('cash');
    expect(rows[0].amount_applied_minor).toBe(1500);
  });

  it('findByAttempt returns rows in apply_order ascending', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle, 2500);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine({ tender_line_id: 'line-2', amount_applied_minor: 1000, apply_order: 2 }));
    repo.insert(baseLine({ tender_line_id: 'line-1', amount_applied_minor: 1500, apply_order: 1 }));
    const rows = repo.findByAttempt('attempt-1');
    expect(rows.map((r) => r.tender_line_id)).toEqual(['line-1', 'line-2']);
  });

  it('updateState transitions applying → applied with applied_at', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine({ state: 'applying', applied_at: null }));
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'applied',
      timestamp: '2026-05-22T10:00:02.000Z',
      last_action_id: 'action-2',
    });
    const row = repo.findByAttempt('attempt-1')[0];
    expect(row.state).toBe('applied');
    expect(row.applied_at).toBe('2026-05-22T10:00:02.000Z');
    expect(row.last_action_id).toBe('action-2');
  });

  it('updateState transitions applied → reversed with reversed_at', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'reversed',
      timestamp: '2026-05-22T10:05:00.000Z',
      last_action_id: 'action-3',
    });
    const row = repo.findByAttempt('attempt-1')[0];
    expect(row.state).toBe('reversed');
    expect(row.reversed_at).toBe('2026-05-22T10:05:00.000Z');
  });

  it('updateState transitions applied → reversal_pending with reversal_pending_since', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'reversal_pending',
      timestamp: '2026-05-22T10:05:00.000Z',
      last_action_id: 'action-3',
    });
    const row = repo.findByAttempt('attempt-1')[0];
    expect(row.state).toBe('reversal_pending');
    expect(row.reversal_pending_since).toBe('2026-05-22T10:05:00.000Z');
  });

  it('updateState reversal_pending → reversed clears reversal_pending_since', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'reversal_pending',
      timestamp: '2026-05-22T10:05:00.000Z',
      last_action_id: 'action-3',
    });
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'reversed',
      timestamp: '2026-05-22T10:06:00.000Z',
      last_action_id: 'action-4',
    });
    const row = repo.findByAttempt('attempt-1')[0];
    expect(row.state).toBe('reversed');
    expect(row.reversed_at).toBe('2026-05-22T10:06:00.000Z');
    expect(row.reversal_pending_since).toBeNull();
  });

  it('updateState to refused writes refused_at + refusal_reason', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine({ state: 'applying', applied_at: null }));
    repo.updateState({
      tender_line_id: 'line-1',
      state: 'refused',
      timestamp: '2026-05-22T10:00:03.000Z',
      last_action_id: 'action-2',
      refusal_reason: 'tender_underpaid',
    });
    const row = repo.findByAttempt('attempt-1')[0];
    expect(row.state).toBe('refused');
    expect(row.refused_at).toBe('2026-05-22T10:00:03.000Z');
    expect(row.refusal_reason).toBe('tender_underpaid');
  });

  it('settlementSumMinor returns the canonical invariant value (cash exact)', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    expect(repo.settlementSumMinor('attempt-1')).toBe(1500);
  });

  it('settlementSumMinor subtracts cash change_due (canonical formula)', () => {
    // data-model.md §Invariant 5: Σ (amount_applied − COALESCE(change_due, 0))
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine({ amount_applied_minor: 2000, change_due_minor: 500 }));
    expect(repo.settlementSumMinor('attempt-1')).toBe(1500);
  });

  it('settlementSumMinor sums multiple applied lines and ignores non-applied lines', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle, 2500);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine({ tender_line_id: 'line-1', amount_applied_minor: 1500, apply_order: 1 }));
    repo.insert(
      baseLine({
        tender_line_id: 'line-2',
        tender_type: 'external_card_terminal',
        amount_applied_minor: 1000,
        apply_order: 2,
      }),
    );
    repo.insert(
      baseLine({
        tender_line_id: 'line-3',
        amount_applied_minor: 999,
        apply_order: 3,
        state: 'refused',
        applied_at: null,
        refused_at: '2026-05-22T10:00:05.000Z',
        refusal_reason: 'tender_underpaid',
      }),
    );
    expect(repo.settlementSumMinor('attempt-1')).toBe(2500);
  });

  it('settlementSumMinor returns 0 for an attempt with no applied lines', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    expect(repo.settlementSumMinor('attempt-1')).toBe(0);
  });

  it('insert rejects a line whose parent attempt does not exist (FK)', () => {
    const handle = makeSqlJsHandle(db);
    const repo = bindPaymentTenderLinesRepository(handle);
    expect(() => {
      repo.insert(baseLine({ payment_attempt_id: 'nope' }));
    }).toThrow();
  });

  it('insert preserves external_reference for external_card_terminal lines', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(
      baseLine({
        tender_type: 'external_card_terminal',
        external_reference: 'AB12XY',
      }),
    );
    expect(repo.findByAttempt('attempt-1')[0].external_reference).toBe('AB12XY');
  });

  it('settlementSumMinor throws when the SUM exceeds MAX_SAFE_INTEGER (defence-in-depth)', () => {
    // The per-line CHECKs make this unreachable in practice, but a corrupted
    // migration or a future schema change could violate the invariant. The
    // guard fires at the aggregate boundary so S3b's settlement comparison
    // cannot proceed against an unsafe sum (Constitution §II).
    const stub = {
      pragma: () => null,
      exec: () => undefined,
      transaction: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
      close: () => undefined,
      prepare() {
        return {
          run() {
            return { changes: 0, lastInsertRowid: 0 };
          },
          get() {
            return { settlement_sum_minor: Number.MAX_SAFE_INTEGER + 100 };
          },
          all(): unknown[] {
            return [];
          },
        };
      },
    };
    const repo = bindPaymentTenderLinesRepository(stub);
    expect(() => repo.settlementSumMinor('attempt-x')).toThrow(TypeError);
  });

  // ── F-005 — findByLineId(tender_line_id) ──────────────────────────────────
  //
  // Added in S3c to support tender.read + tender.reverse bridge handlers,
  // whose request shapes carry only `tender_line_id`. PK equality lookup
  // against the migration-0014 primary key; both the hit + miss branches
  // are exercised here for full coverage.

  it('findByLineId returns the row when the id exists', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    const row = repo.findByLineId('line-1');
    expect(row).toBeDefined();
    expect(row?.tender_line_id).toBe('line-1');
    expect(row?.tender_type).toBe('cash');
    expect(row?.amount_applied_minor).toBe(1500);
  });

  it('findByLineId returns undefined when the id is unknown', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    expect(repo.findByLineId('line-NOT-EXIST')).toBeUndefined();
  });

  // ── T270 — findReversalPendingLines ──────────────────────────────────────

  it('findReversalPendingLines returns only state=reversal_pending rows, oldest first', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    // Insert: one applied (filtered out), two reversal_pending (ordered by since ASC),
    // one reversed (filtered out).
    repo.insert(baseLine({ tender_line_id: 'line-applied', apply_order: 1 }));
    repo.insert(
      baseLine({
        tender_line_id: 'line-pending-newer',
        state: 'reversal_pending',
        apply_order: 2,
        applied_at: null,
        reversal_pending_since: '2026-05-22T11:00:00.000Z',
      }),
    );
    repo.insert(
      baseLine({
        tender_line_id: 'line-pending-older',
        state: 'reversal_pending',
        apply_order: 3,
        applied_at: null,
        reversal_pending_since: '2026-05-22T10:30:00.000Z',
      }),
    );
    repo.insert(
      baseLine({
        tender_line_id: 'line-reversed',
        state: 'reversed',
        apply_order: 4,
        applied_at: null,
        reversed_at: '2026-05-22T10:45:00.000Z',
      }),
    );
    const pending = repo.findReversalPendingLines();
    expect(pending.map((r) => r.tender_line_id)).toEqual([
      'line-pending-older',
      'line-pending-newer',
    ]);
  });

  it('findReversalPendingLines returns an empty array when no pending lines exist', () => {
    const handle = makeSqlJsHandle(db);
    seedAttempt(handle);
    const repo = bindPaymentTenderLinesRepository(handle);
    repo.insert(baseLine());
    expect(repo.findReversalPendingLines()).toEqual([]);
  });
});
