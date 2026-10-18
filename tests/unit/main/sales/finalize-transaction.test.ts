/**
 * T091 — AD-2 atomic finalize transaction (S1c.1 unit tests, RED).
 *
 * One test file covers T050 (atomicity) + T051 (idempotency) +
 * T055/T056/T057 (refusal guard) + T060/T061/T062 (forbidden-field guard),
 * because all of these exercise the same entry point
 * `bindFinalizeTransaction(deps).finalize(input)` with the same sql.js +
 * migrations setup. Splitting into 8 test files would duplicate ~80 lines of
 * fixture setup per file.
 *
 * The kill-mid-flight test (T053) and startup-recovery test (T054) live in
 * tests/integration/ because they model process-lifecycle behaviour; they
 * land in S1c.2 with the polling worker (T090/T092).
 *
 * Reference data-model.md §"Entity: Sale" + plan §AD-2 + spec FR-001,
 * FR-005/045/046/047, FR-070-074.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindFinalizeTransaction } from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  // 006 schema needed for the refusal-guard fixtures.
  // RT-551 — the once-per-terminal switch marker is read from audit_events.
  '0004_audit_events.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  // 008 Slice 1a schema.
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  // T028a — lines_json column for byte-stable reprints.
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
let captured: Array<Record<string, unknown>>;

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  captured = [];
});

// ─── Test-fixture helpers ──────────────────────────────────────────────────

interface SeedAttemptOpts {
  attempt_id?: string;
  handoff_action_id?: string;
  state?: 'started' | 'settled' | 'cancelled' | 'failed' | 'force_failed';
  failure_reason?: string | null;
  force_fail_attribution_operator_id?: string | null;
}

function seedPaymentAttempt(opts: SeedAttemptOpts = {}): string {
  const attempt_id = opts.attempt_id ?? 'pa-1';
  const handoff_action_id = opts.handoff_action_id ?? 'handoff-1';
  const state = opts.state ?? 'settled';
  const failure_reason =
    opts.failure_reason ??
    (state === 'failed' || state === 'force_failed' ? 'internal_error' : null);
  const force_fail_attr =
    opts.force_fail_attribution_operator_id ?? (state === 'force_failed' ? 'mgr-abc' : null);
  const settled_at = state === 'settled' ? '2026-05-27T10:00:00.000Z' : null;

  db.exec(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id,
       envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
       state, started_at, settled_at, failure_reason, force_fail_attribution_operator_id,
       last_action_id
     ) VALUES (
       '${attempt_id}', 'tenant-1', 'branch-1', 'terminal-1',
       'op-clerk-user-abc', 'sess-1',
       '${handoff_action_id}', 'cart-1', 1500,
       '${state}', '2026-05-27T09:59:00.000Z',
       ${settled_at ? `'${settled_at}'` : 'NULL'},
       ${failure_reason ? `'${failure_reason}'` : 'NULL'},
       ${force_fail_attr ? `'${force_fail_attr}'` : 'NULL'},
       'action-1'
     )`,
  );
  return attempt_id;
}

interface SeedTenderLineOpts {
  tender_line_id?: string;
  payment_attempt_id?: string;
  tender_type?: 'cash' | 'external_card_terminal' | 'internal_voucher';
  amount_applied_minor?: number;
  state?: 'applying' | 'applied' | 'refused' | 'reversed' | 'reversal_pending';
  apply_order?: number;
}

function seedTenderLine(opts: SeedTenderLineOpts = {}): void {
  const id = opts.tender_line_id ?? 'tl-1';
  const attempt = opts.payment_attempt_id ?? 'pa-1';
  const type = opts.tender_type ?? 'cash';
  const amount = opts.amount_applied_minor ?? 1500;
  const state = opts.state ?? 'applied';
  const order = opts.apply_order ?? 1;

  db.exec(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
       state, applied_at, attribution_operator_id, apply_order, last_action_id
     ) VALUES (
       '${id}', '${attempt}', '${type}', ${String(amount)},
       '${state}', '2026-05-27T10:00:00.000Z', 'op-clerk-user-abc', ${String(order)}, 'action-1'
     )`,
  );
}

function buildDeps(now: string = '2026-05-27T10:00:00.500Z') {
  const handle = makeSqlJsHandle(db);
  return {
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({
      sink: {
        write: (e) => {
          captured.push(e);
        },
      },
    }),
    now: () => now,
    saleIdGenerator: () => 'sale-uuid-1',
    outboxRowIdGenerator: () => 'ob-uuid-1',
  };
}

function buildInput(
  overrides: Partial<Parameters<ReturnType<typeof bindFinalizeTransaction>['finalize']>[0]> = {},
) {
  return {
    envelope_handoff_action_id: 'handoff-1',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'TERM-01',
    selling_operator_id: 'op-clerk-user-abc',
    selling_operator_display_name: 'Ahmed',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [{ tender_type: 'cash' as const, amount_applied_minor: 1500 }],
    settled_at: '2026-05-27T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Maadi Branch',
    branch_address: '12 Road 9, Maadi',
    lines: [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 1500,
        line_subtotal_minor: 1500,
        note: null,
        version: 1,
        last_action_id: 'action-1',
      },
    ],
    ...overrides,
  };
}

// ─── T050 — AD-2 atomic finalize transaction ────────────────────────────────

describe('T050 — AD-2 atomic finalize transaction', () => {
  it('allocates sale_number, inserts sale, inserts outbox row, emits audit — all atomic', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(buildInput());

    expect(result.kind).toBe('finalized');
    if (result.kind !== 'finalized') return;
    expect(result.sale_id).toBe('sale-uuid-1');
    expect(result.sale_number).toBe('TERM-01-2026-05-27-000001');

    // sales row present.
    const saleRow = db.exec("SELECT sale_number FROM sales WHERE sale_id = 'sale-uuid-1'");
    expect(saleRow[0]?.values[0]?.[0]).toBe('TERM-01-2026-05-27-000001');

    // outbox row present.
    const outboxRow = db.exec("SELECT state FROM sale_sync_outbox WHERE sale_id = 'sale-uuid-1'");
    expect(outboxRow[0]?.values[0]?.[0]).toBe('pending');

    // audit rows emitted: the sale, then this terminal's one-time RT-551 switch.
    expect(captured.map((e) => e.action_category)).toEqual([
      'sale.finalized',
      'sale.number_day_rule.switched',
    ]);
  });

  it('writes all four rows inside one SQLite transaction (forensic check)', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());
    finalize.finalize(buildInput());

    // After commit, all four rows present together.
    const sales = db.exec('SELECT COUNT(*) FROM sales');
    const outbox = db.exec('SELECT COUNT(*) FROM sale_sync_outbox');
    const seq = db.exec('SELECT COUNT(*) FROM sale_number_sequences');
    expect(sales[0]?.values[0]?.[0]).toBe(1);
    expect(outbox[0]?.values[0]?.[0]).toBe(1);
    expect(seq[0]?.values[0]?.[0]).toBe(1);
    expect(captured.map((e) => e.action_category)).toEqual([
      'sale.finalized',
      'sale.number_day_rule.switched',
    ]);
  });

  it('persists the redacted tender_lines_summary_json in the sales row', () => {
    seedPaymentAttempt();
    seedTenderLine({ tender_type: 'external_card_terminal' });
    const finalize = bindFinalizeTransaction(buildDeps());
    finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'external_card_terminal' as const,
            amount_applied_minor: 1500,
            external_reference: 'CARD-AUTH-AB12XY',
          },
        ],
      }),
    );
    const row = db.exec(
      "SELECT tender_lines_summary_json FROM sales WHERE sale_id = 'sale-uuid-1'",
    );
    const json = row[0]?.values[0]?.[0] as string;
    // Cleartext must never reach the persisted row.
    expect(json).not.toContain('CARD-AUTH-AB12XY');
    expect(json).toContain('*****');
  });

  it('persists the cart line snapshot as lines_json in the sales row (T028a)', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());
    const input = buildInput({
      lines: [
        {
          line_id: 'line-1',
          item_ref: 'SKU-001',
          display_name: 'Paracetamol 500mg',
          quantity: 2,
          unit_price_minor: 1500,
          line_subtotal_minor: 3000,
          note: 'fridge item',
          version: 1,
          last_action_id: 'action-1',
        },
      ],
    });
    finalize.finalize(input);
    const row = db.exec("SELECT lines_json FROM sales WHERE sale_id = 'sale-uuid-1'");
    const json = row[0]?.values[0]?.[0] as string;
    // Byte-identical to JSON.stringify of the input lines (FR-015 / FR-016).
    expect(json).toBe(JSON.stringify(input.lines));
    // Spot-check a couple of fields survived the round-trip.
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(parsed[0]?.display_name).toBe('Paracetamol 500mg');
    expect(parsed[0]?.line_subtotal_minor).toBe(3000);
  });

  it('persists change_due_minor on cash tender lines', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());
    finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'cash' as const,
            amount_applied_minor: 2000,
            change_due_minor: 500,
          },
        ],
      }),
    );
    const row = db.exec(
      "SELECT tender_lines_summary_json FROM sales WHERE sale_id = 'sale-uuid-1'",
    );
    const json = row[0]?.values[0]?.[0] as string;
    expect(json).toContain('"change_due_minor":500');
  });

  it('persists voucher_authority_redemption_id on internal_voucher tender lines', () => {
    seedPaymentAttempt();
    seedTenderLine({ tender_type: 'internal_voucher' });
    const finalize = bindFinalizeTransaction(buildDeps());
    finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'internal_voucher' as const,
            amount_applied_minor: 1500,
            voucher_authority_redemption_id: 'vauth-12345',
          },
        ],
      }),
    );
    const row = db.exec(
      "SELECT tender_lines_summary_json FROM sales WHERE sale_id = 'sale-uuid-1'",
    );
    const json = row[0]?.values[0]?.[0] as string;
    expect(json).toContain('"voucher_authority_redemption_id":"vauth-12345"');
  });
});

// ─── T051 — Idempotency on duplicate handoff_action_id ─────────────────────

describe('T051 — duplicate finalize on the same envelope_handoff_action_id is a no-op', () => {
  it('returns the existing sale_id; does not write a second row anywhere', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());

    const first = finalize.finalize(buildInput());
    expect(first.kind).toBe('finalized');
    const second = finalize.finalize(buildInput());
    expect(second.kind).toBe('finalized_idempotent');
    if (second.kind !== 'finalized_idempotent') return;
    if (first.kind !== 'finalized') return;
    expect(second.sale_id).toBe(first.sale_id);

    // Exactly one row in each downstream table; one sale.finalized (plus the
    // first-sale RT-551 switch), nothing from the replay.
    const sales = db.exec('SELECT COUNT(*) FROM sales');
    const outbox = db.exec('SELECT COUNT(*) FROM sale_sync_outbox');
    expect(sales[0]?.values[0]?.[0]).toBe(1);
    expect(outbox[0]?.values[0]?.[0]).toBe(1);
    expect(captured.map((e) => e.action_category)).toEqual([
      'sale.finalized',
      'sale.number_day_rule.switched',
    ]);
  });

  it('in-transaction TOCTOU re-check fires when the fast-path read sees no row but a concurrent INSERT wins the race', () => {
    // The fast-path findByHandoffActionId returns null (no duplicate seen
    // initially), but a concurrent writer commits a sales row in between.
    // The in-txn re-check at the top of db.transaction(...) must catch
    // that and return finalized_idempotent without writing anything.
    //
    // We model this by wrapping the real repo: first call returns null,
    // subsequent calls return the seeded row. The behaviour reproduces
    // the production TOCTOU window per CR2 on PR #264.
    seedPaymentAttempt();
    seedTenderLine();
    db.exec(
      `INSERT INTO sales (
         sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
         envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
         selling_operator_id, selling_operator_display_name, selling_operator_session_id,
         subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
         settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
         local_calendar_day
       ) VALUES (
         'sale-toctou-winner', 'TERM-01-2026-05-27-000777', 'TERM-01-2026-05-27-000777',
         'handoff-1', 'pa-1',
         'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
         'op-clerk-user-abc', 'Ahmed', 'sess-1',
         1500, 0, 0, '[]',
         '2026-05-27T09:55:00.000Z', '2026-05-27T09:55:00.500Z', 'TRN', 'B', 'A',
         '2026-05-27'
       )`,
    );

    const realDeps = buildDeps();
    const realRepo = realDeps.salesRepo;
    let callCount = 0;
    const wrappedRepo: typeof realRepo = {
      ...realRepo,
      findByHandoffActionId(handoff_action_id) {
        callCount += 1;
        // First call (fast-path) returns null; subsequent calls
        // (the in-txn re-check + the post-txn re-read) return the real row.
        if (callCount === 1) return null;
        return realRepo.findByHandoffActionId(handoff_action_id);
      },
    };
    const finalize = bindFinalizeTransaction({ ...realDeps, salesRepo: wrappedRepo });

    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('finalized_idempotent');
    if (result.kind !== 'finalized_idempotent') return;
    expect(result.sale_id).toBe('sale-toctou-winner');
    expect(result.sale_number).toBe('TERM-01-2026-05-27-000777');

    // Still exactly one sales row — no second insert.
    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(1);
    // No allocator sequence row — the txn short-circuited before allocate.
    const seq = db.exec('SELECT COUNT(*) FROM sale_number_sequences');
    expect(seq[0]?.values[0]?.[0]).toBe(0);
    // No audit emitted.
    expect(captured).toHaveLength(0);
  });

  it('fast-path idempotency short-circuits before entering the transaction', () => {
    // Per CR2 on PR #264 — the in-txn re-check closes the window between
    // the fast-path read and the INSERT. We simulate it by seeding a
    // pre-existing sales row directly (the same handoff_action_id that
    // the test will then try to finalize). The finalize call must
    // return finalized_idempotent and write nothing new.
    seedPaymentAttempt();
    seedTenderLine();
    db.exec(
      `INSERT INTO sales (
         sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
         envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
         selling_operator_id, selling_operator_display_name, selling_operator_session_id,
         subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
         settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
         local_calendar_day
       ) VALUES (
         'sale-pre-existing', 'TERM-01-2026-05-27-000999', 'TERM-01-2026-05-27-000999',
         'handoff-1', 'pa-1',
         'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
         'op-clerk-user-abc', 'Ahmed', 'sess-1',
         1500, 0, 0, '[]',
         '2026-05-27T09:55:00.000Z', '2026-05-27T09:55:00.500Z', 'TRN', 'B', 'A',
         '2026-05-27'
       )`,
    );

    const finalize = bindFinalizeTransaction(buildDeps());
    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('finalized_idempotent');
    if (result.kind !== 'finalized_idempotent') return;
    expect(result.sale_id).toBe('sale-pre-existing');
    expect(result.sale_number).toBe('TERM-01-2026-05-27-000999');

    // Still exactly one sales row — no second row created.
    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(1);
    // No sale_number_sequences row should have been created either,
    // because the in-txn re-check short-circuited before allocator.allocate.
    const seq = db.exec('SELECT COUNT(*) FROM sale_number_sequences');
    expect(seq[0]?.values[0]?.[0]).toBe(0);
    // No audit emitted — idempotent return is silent.
    expect(captured).toHaveLength(0);
  });
});

// ─── T055/T056/T057 — Refusal guard ────────────────────────────────────────

describe('T055 — refuse when source attempt is force_failed', () => {
  it('emits sale.finalization_refused; no sales row created', () => {
    seedPaymentAttempt({ state: 'force_failed' });
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('force_failed_attempt');

    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.action_category).toBe('sale.finalization_refused');
    expect((captured[0]?.payload as Record<string, unknown>).refusal_reason).toBe(
      'force_failed_attempt',
    );
  });
});

describe('T056 — refuse when any tender line is in reversal_pending', () => {
  it('emits sale.finalization_refused with reversal_pending_line', () => {
    seedPaymentAttempt();
    seedTenderLine({ tender_line_id: 'tl-1', state: 'applied' });
    seedTenderLine({
      tender_line_id: 'tl-2',
      state: 'reversal_pending',
      apply_order: 2,
    });
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('reversal_pending_line');

    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
  });
});

describe('T057 — refuse when source attempt is not settled', () => {
  it('refuses with source_attempt_not_settled when the payment_attempt_id has no row at all', () => {
    // No seedPaymentAttempt — the AD-2 worker handed us a handoff_action_id
    // pointing at a payment_attempt_id that doesn't exist (e.g. legacy
    // outbox row from a feature-flag flip). Refuse rather than crash.
    const finalize = bindFinalizeTransaction(buildDeps());
    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('source_attempt_not_settled');

    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.action_category).toBe('sale.finalization_refused');
  });

  it('refuses started / cancelled / failed', () => {
    for (const state of ['started', 'cancelled', 'failed'] as const) {
      // Fresh DB per pass since beforeEach only fires once per `it`.
      db = new SQL.Database();
      db.exec('PRAGMA foreign_keys = ON;');
      for (const sql of MIGRATIONS) db.exec(sql);
      captured = [];

      seedPaymentAttempt({ state });
      const finalize = bindFinalizeTransaction(buildDeps());
      const result = finalize.finalize(buildInput());
      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') continue;
      expect(result.refusal_reason).toBe('source_attempt_not_settled');
    }
  });
});

// ─── T060/T061/T062 — Forbidden-field guard ────────────────────────────────

describe('T060 — refuse on forbidden card-data keys in tender_lines_summary', () => {
  it('refuses with forbidden_field_in_tender_summary on PAN-shaped key', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'external_card_terminal' as const,
            amount_applied_minor: 1500,
            // PAN-shaped forbidden key (FR-070). Synthetic non-numeric token
            // so the test never carries a realistic card number, even in
            // commit history (per CR3 on PR #264).
            pan: 'TEST_PAN_TOKEN_NOT_A_REAL_CARD',
          } as unknown as { tender_type: 'external_card_terminal'; amount_applied_minor: number },
        ],
      }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('forbidden_field_in_tender_summary');

    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
  });
});

describe('T061 — refuse on forbidden voucher keys', () => {
  it('refuses on voucher_code', () => {
    seedPaymentAttempt();
    seedTenderLine({ tender_type: 'internal_voucher' });
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'internal_voucher' as const,
            amount_applied_minor: 1500,
            voucher_code: 'VC-LEAK',
          } as unknown as { tender_type: 'internal_voucher'; amount_applied_minor: number },
        ],
      }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('forbidden_field_in_tender_summary');
  });

  it('refuses on voucher_redemption_intent_token', () => {
    seedPaymentAttempt();
    seedTenderLine({ tender_type: 'internal_voucher' });
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'internal_voucher' as const,
            amount_applied_minor: 1500,
            voucher_redemption_intent_token: 'TOK-LEAK',
          } as unknown as { tender_type: 'internal_voucher'; amount_applied_minor: number },
        ],
      }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('forbidden_field_in_tender_summary');
  });
});

describe('T062 — refuse on forbidden secret/envelope keys', () => {
  it('refuses on PIN key', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'cash' as const,
            amount_applied_minor: 1500,
            pin: '1234',
          } as unknown as { tender_type: 'cash'; amount_applied_minor: number },
        ],
      }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('forbidden_field_in_tender_summary');
  });

  it('refuses on envelope_payload key (raw envelope leak)', () => {
    seedPaymentAttempt();
    seedTenderLine();
    const finalize = bindFinalizeTransaction(buildDeps());

    const result = finalize.finalize(
      buildInput({
        tender_lines_summary: [
          {
            tender_type: 'cash' as const,
            amount_applied_minor: 1500,
            envelope_payload: { secret: 'leak' },
          } as unknown as { tender_type: 'cash'; amount_applied_minor: number },
        ],
      }),
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.refusal_reason).toBe('forbidden_field_in_tender_summary');
  });
});
