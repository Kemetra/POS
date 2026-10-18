/**
 * T054 + T092 — AD-2 startup recovery integration test (RED).
 *
 * Per tasks.md T054 + T092 + research §R-15 v3:
 *
 *   T054 (AD-2 audit-events recovery):
 *     On listener startup, the steady-state scan worker's FIRST tick
 *     automatically picks up any `payment.settled` rows whose
 *     handoff_action_id has no matching sales row. AD-2 v3 makes startup
 *     recovery identical to the first tick — there is no separate
 *     audit-events recovery sub-scan.
 *
 *   T092 (print + drawer one-shot recovery sub-scans):
 *     In addition to the steady-state worker, the listener runs TWO
 *     one-shot sub-scans at startup:
 *       (1) Print recovery — scan `sales` for any sale whose
 *           `print_events` table has no `outcome='success'` row AND no
 *           `outcome='manual_override'` row; dispatch a fresh print
 *           attempt per match.
 *       (2) Drawer recovery — scan `sales` for any cash-inclusive sale
 *           (tender_lines_summary_json contains an applied `cash` line)
 *           whose `drawer_events` table has no row; dispatch a fresh
 *           drawer-kick attempt per match.
 *     Both scoped to the current terminal's (tenant_id, branch_id,
 *     terminal_id) triple. Both complete in a single pass and do not
 *     re-run.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFinalizeListener } from '../../../src/main/sales/finalize-listener.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
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

function seedSale(opts: {
  sale_id: string;
  handoff_action_id?: string;
  cash_inclusive?: boolean;
  tenant_id?: string;
  branch_id?: string;
  terminal_id?: string;
}): void {
  const handoff_action_id = opts.handoff_action_id ?? `handoff-${opts.sale_id}`;
  const tenant_id = opts.tenant_id ?? 'tenant-1';
  const branch_id = opts.branch_id ?? 'branch-1';
  const terminal_id = opts.terminal_id ?? 'terminal-1';
  const tender_lines_summary_json = opts.cash_inclusive
    ? '[{"tender_type":"cash","amount_applied_minor":1500}]'
    : '[{"tender_type":"external_card_terminal","amount_applied_minor":1500}]';
  db.exec(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       '${opts.sale_id}', '${opts.sale_id}-num', '${opts.sale_id}-num',
       '${handoff_action_id}', 'pa-${opts.sale_id}',
       'cart-${opts.sale_id}', '${tenant_id}', '${branch_id}', '${terminal_id}', 'TERM-01',
       'op-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '${tender_lines_summary_json}',
       '2026-05-28T10:00:00.000Z', '2026-05-28T10:00:00.500Z', 'TRN', 'B', 'A',
       '2026-05-28'
     )`,
  );
}

function seedPrintEvent(opts: {
  print_event_id: string;
  sale_id: string;
  outcome: 'success' | 'failure' | 'manual_override';
}): void {
  const render_path = opts.outcome === 'manual_override' ? null : "'escpos_direct'";
  const failure_reason = opts.outcome === 'failure' ? "'printer_offline'" : null;
  db.exec(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (
       '${opts.print_event_id}', '${opts.sale_id}', '${opts.outcome}', 'first_print', ${render_path ?? 'NULL'},
       'op-abc', 'sess-1', NULL,
       ${failure_reason ?? 'NULL'}, NULL, '2026-05-28T10:00:01.000Z'
     )`,
  );
}

function seedDrawerEvent(opts: { drawer_event_id: string; sale_id: string }): void {
  // Need a parent print_event for the FK first.
  seedPrintEvent({
    print_event_id: `pe-${opts.drawer_event_id}`,
    sale_id: opts.sale_id,
    outcome: 'success',
  });
  db.exec(
    `INSERT INTO drawer_events (
       drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
       last_successful_open_at_for_terminal, triggering_print_event_id,
       terminal_id, attempted_at
     ) VALUES (
       '${opts.drawer_event_id}', '${opts.sale_id}', 'opened', NULL, NULL,
       NULL, 'pe-${opts.drawer_event_id}',
       'terminal-1', '2026-05-28T10:00:02.000Z'
     )`,
  );
}

describe('T054 — AD-2 audit-events recovery on first tick', () => {
  it('first tick picks up unfinalized payment.settled rows from before listener startup', () => {
    // Simulate a kill-mid-flight: payment.settled row exists in audit_events
    // but no matching sales row was ever written.
    db.exec(
      `INSERT INTO audit_events (
         event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
         session_id, action_category, created_at, payload
       ) VALUES (
         'evt-orphan', 'tenant-1', 'branch-1', 'terminal-1', 'op-abc',
         'sess-1', 'payment.settled', '2026-05-28T09:55:00.000Z',
         '{"handoff_action_id":"handoff-orphan","payment_attempt_id":"pa-orphan"}'
       )`,
    );

    const dispatched: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: (handoff_action_id) => {
        dispatched.push(handoff_action_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    // First tick = startup recovery (per AD-2 v3 design).
    listener.runTickOnce();

    expect(dispatched).toEqual(['handoff-orphan']);
  });
});

describe('T092 — print recovery one-shot sub-scan at startup', () => {
  it('dispatches print recovery for sales with no success and no manual_override print event', () => {
    seedSale({ sale_id: 'sale-no-prints' });
    seedSale({ sale_id: 'sale-with-failure' });
    seedPrintEvent({
      print_event_id: 'pe-failed',
      sale_id: 'sale-with-failure',
      outcome: 'failure',
    });
    seedSale({ sale_id: 'sale-with-success' });
    seedPrintEvent({
      print_event_id: 'pe-success',
      sale_id: 'sale-with-success',
      outcome: 'success',
    });
    seedSale({ sale_id: 'sale-with-manual' });
    seedPrintEvent({
      print_event_id: 'pe-manual',
      sale_id: 'sale-with-manual',
      outcome: 'manual_override',
    });

    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    // sale-no-prints (no events) and sale-with-failure (only failure) need recovery.
    // sale-with-success and sale-with-manual do NOT need recovery.
    expect(dispatchedPrint.sort()).toEqual(['sale-no-prints', 'sale-with-failure']);
  });

  it('print recovery is scoped to the current terminal', () => {
    seedSale({ sale_id: 'sale-this-term', terminal_id: 'terminal-1' });
    seedSale({ sale_id: 'sale-other-term', terminal_id: 'terminal-OTHER' });

    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    expect(dispatchedPrint).toEqual(['sale-this-term']);
  });

  it('print recovery is scoped to the current tenant (cross-tenant isolation, CR1 on PR #266)', () => {
    seedSale({ sale_id: 'sale-this-tenant', tenant_id: 'tenant-1' });
    seedSale({ sale_id: 'sale-other-tenant', tenant_id: 'tenant-OTHER' });

    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    expect(dispatchedPrint).toEqual(['sale-this-tenant']);
  });

  it('print recovery is scoped to the current branch (cross-branch isolation, CR1 on PR #266)', () => {
    seedSale({ sale_id: 'sale-this-branch', branch_id: 'branch-1' });
    seedSale({ sale_id: 'sale-other-branch', branch_id: 'branch-OTHER' });

    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    expect(dispatchedPrint).toEqual(['sale-this-branch']);
  });

  it('per-sale drawer cache prevents duplicate dispatch when a later sale in the same scan throws (CR7 branch coverage)', () => {
    // Two cash-inclusive sales; drawer dispatch succeeds for sale-1 then
    // throws for sale-2. Retry — sale-1 hit by cache, sale-2 fires fresh.
    // Covers the completedDrawerRecoverySaleIds.has() === true branch.
    seedSale({ sale_id: 'sale-1', cash_inclusive: true });
    seedSale({ sale_id: 'sale-2', cash_inclusive: true });

    let throwOnceOnSecond = true;
    const dispatchedDrawer: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchDrawerRecovery: (sale_id) => {
        if (sale_id === 'sale-2' && throwOnceOnSecond) {
          throwOnceOnSecond = false;
          throw new Error('simulated drawer failure for sale-2');
        }
        dispatchedDrawer.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });

    expect(() => {
      listener.runStartupRecovery();
    }).toThrow(/simulated drawer failure for sale-2/);
    expect(dispatchedDrawer).toEqual(['sale-1']); // sale-1 succeeded before throw

    // Retry — sale-1 cache-skipped, sale-2 fires fresh and succeeds.
    listener.runStartupRecovery();
    expect(dispatchedDrawer).toEqual(['sale-1', 'sale-2']);
  });

  it('successful runs cache per-sale completions so a manual second call after success is fully idempotent (CR7 branch coverage)', () => {
    // After a successful runStartupRecovery the fired-flag is true and a
    // second call short-circuits at the top — that's the "completed Set
    // has(sale_id) returns true" branch we need for ≥95% coverage on
    // finalize-listener.ts. Calls dispatch sets that DO complete fully,
    // then asserts second invocation is fully silent.
    seedSale({ sale_id: 'sale-A', cash_inclusive: true });

    const dispatchedPrint: string[] = [];
    const dispatchedDrawer: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      dispatchDrawerRecovery: (sale_id) => {
        dispatchedDrawer.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });

    listener.runStartupRecovery();
    expect(dispatchedPrint).toEqual(['sale-A']);
    expect(dispatchedDrawer).toEqual(['sale-A']);

    // Second call: fired-flag is true, returns immediately, no duplicates.
    listener.runStartupRecovery();
    expect(dispatchedPrint).toEqual(['sale-A']); // unchanged
    expect(dispatchedDrawer).toEqual(['sale-A']); // unchanged
  });

  it('successful print dispatches are NOT replayed when a later drawer dispatch throws (CR7 on PR #266)', () => {
    // Regression for CR7 — without per-sale completion caches, a print
    // recovery that succeeds followed by a drawer recovery that throws
    // would re-dispatch the print on the next runStartupRecovery() call.
    seedSale({ sale_id: 'sale-needs-print', cash_inclusive: true });

    let throwOnceOnDrawer = true;
    const dispatchedPrint: string[] = [];
    const dispatchedDrawer: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      dispatchDrawerRecovery: (sale_id) => {
        if (throwOnceOnDrawer) {
          throwOnceOnDrawer = false;
          throw new Error('simulated transient drawer dispatch failure');
        }
        dispatchedDrawer.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });

    // First attempt — print succeeds, drawer throws.
    expect(() => {
      listener.runStartupRecovery();
    }).toThrow(/simulated transient drawer dispatch failure/);
    expect(dispatchedPrint).toEqual(['sale-needs-print']);
    expect(dispatchedDrawer).toEqual([]);

    // Retry — print MUST NOT re-dispatch (already cached as completed);
    // drawer MUST dispatch (was not cached because the throw happened
    // before the success-set add).
    listener.runStartupRecovery();
    expect(dispatchedPrint).toEqual(['sale-needs-print']); // unchanged — no duplicate
    expect(dispatchedDrawer).toEqual(['sale-needs-print']); // now succeeds
  });

  it('runStartupRecovery DOES NOT flip its fired flag if a dispatch throws (CR2 on PR #266)', () => {
    seedSale({ sale_id: 'sale-needs-print' });

    let throwOnce = true;
    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('simulated transient print dispatch failure');
        }
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });

    // First attempt throws — flag must stay false so a retry can succeed.
    expect(() => {
      listener.runStartupRecovery();
    }).toThrow(/simulated transient print dispatch failure/);
    expect(dispatchedPrint).toEqual([]);

    // Retry — succeeds + the flag now flips so a third call is a no-op.
    listener.runStartupRecovery();
    expect(dispatchedPrint).toEqual(['sale-needs-print']);

    // Third call: flag is now true → no-op (the sale-needs-print row still
    // matches the WHERE clause but the gate short-circuits before query).
    listener.runStartupRecovery();
    expect(dispatchedPrint).toEqual(['sale-needs-print']);
  });

  it('print recovery does not re-run on subsequent startup-recovery invocations', () => {
    seedSale({ sale_id: 'sale-needs-print' });

    const dispatchedPrint: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchPrintRecovery: (sale_id) => {
        dispatchedPrint.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();
    listener.runStartupRecovery(); // second call — must be a no-op
    expect(dispatchedPrint).toEqual(['sale-needs-print']);
  });
});

describe('T092 — drawer recovery one-shot sub-scan at startup', () => {
  it('dispatches drawer recovery for cash-inclusive sales with no drawer_events row', () => {
    seedSale({ sale_id: 'sale-cash-no-drawer', cash_inclusive: true });
    seedSale({ sale_id: 'sale-card-no-drawer', cash_inclusive: false });
    seedSale({ sale_id: 'sale-cash-with-drawer', cash_inclusive: true });
    seedDrawerEvent({
      drawer_event_id: 'de-1',
      sale_id: 'sale-cash-with-drawer',
    });

    const dispatchedDrawer: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchDrawerRecovery: (sale_id) => {
        dispatchedDrawer.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    // sale-cash-no-drawer needs drawer recovery.
    // sale-card-no-drawer does NOT (no cash line → no drawer kick expected).
    // sale-cash-with-drawer does NOT (already has a drawer event).
    expect(dispatchedDrawer).toEqual(['sale-cash-no-drawer']);
  });

  it('drawer recovery is scoped to the current terminal', () => {
    seedSale({
      sale_id: 'sale-this-cash',
      cash_inclusive: true,
      terminal_id: 'terminal-1',
    });
    seedSale({
      sale_id: 'sale-other-cash',
      cash_inclusive: true,
      terminal_id: 'terminal-OTHER',
    });

    const dispatchedDrawer: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: () => {},
      dispatchDrawerRecovery: (sale_id) => {
        dispatchedDrawer.push(sale_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();

    expect(dispatchedDrawer).toEqual(['sale-this-cash']);
  });
});

describe('T092 — startup recovery is decoupled from the steady-state tick', () => {
  it('runStartupRecovery does not consume payment.settled audit_events rows', () => {
    db.exec(
      `INSERT INTO audit_events (
         event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
         session_id, action_category, created_at, payload
       ) VALUES (
         'evt-orphan', 'tenant-1', 'branch-1', 'terminal-1', 'op-abc',
         'sess-1', 'payment.settled', '2026-05-28T09:55:00.000Z',
         '{"handoff_action_id":"handoff-orphan"}'
       )`,
    );

    const dispatched: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: (handoff_action_id) => {
        dispatched.push(handoff_action_id);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:00.000Z',
    });
    listener.runStartupRecovery();
    // Startup recovery is only print + drawer; the audit-events recovery is
    // the first steady-state tick (T054). So dispatched stays empty.
    expect(dispatched).toEqual([]);
  });
});
