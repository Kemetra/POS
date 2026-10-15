/**
 * Banner-state projector (008 follow-up slice — sales.subscribe banner_state).
 *
 * Computes the terminal's `BannerState` PER-SALE. The load-bearing test is the
 * silent-failure guard (coordination §S3c projection rule): a newer sale's
 * SUCCESS must NOT clear an older sale's unresolved FAILURE.
 *
 * `print_events`/`drawer_events` are sale-scoped (no terminal_id), so the
 * projector JOINs to `sales` on the session (tenant, branch, terminal) triple.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindBannerStateProjector } from '../../../../src/main/sales/banner-state-projector.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0028_extend_sales_with_lines_json.sql',
  '0052_drawer_events_suppression_no_drawer.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

function seedSale(
  db: SqlJsDatabase,
  sale_id: string,
  finalized_at: string,
  over: Partial<{ tenant_id: string; branch_id: string; terminal_id: string }> = {},
): void {
  const t = over.tenant_id ?? 'tenant-1';
  const b = over.branch_id ?? 'branch-1';
  const term = over.terminal_id ?? 'terminal-1';
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (
       ?, ?, ?, 'h-'||?, 'pa-'||?, 'cart-'||?, ?, ?, ?, 'TERM-01',
       'op-abc','Mohamed','sess-1', 5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500}]',
       ?, ?, 'TRN-100','Maadi','12 Road 9', '2026-05-27','[]'
     )`,
    [sale_id, sale_id, sale_id, sale_id, sale_id, sale_id, t, b, term, finalized_at, finalized_at],
  );
}

function printEvent(
  db: SqlJsDatabase,
  id: string,
  sale_id: string,
  outcome: string,
  printed_at: string,
): void {
  const renderPath = outcome === 'manual_override' ? null : 'escpos_direct';
  const failureReason = outcome === 'failure' ? 'printer_offline' : null;
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, ?, ?, 'first_print', ?, 'op-abc','sess-1', NULL, ?, NULL, ?)`,
    [id, sale_id, outcome, renderPath, failureReason, printed_at],
  );
}

function projector(db: SqlJsDatabase) {
  return bindBannerStateProjector(makeSqlJsHandle(db));
}

describe('banner-state projector — per-sale, no silent masking', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
  });

  it('returns both-null when there are no print/drawer events', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    expect(projector(db).projectBannerState(SCOPE)).toEqual({
      printer_failure: null,
      drawer_failure: null,
    });
  });

  it('returns printer_failure for a sale whose latest print event is a failure', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'failure', '2026-05-27T10:00:05.000Z');
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.printer_failure).not.toBeNull();
    expect(state.printer_failure?.sale_id).toBe('sale-1');
    expect(state.printer_failure?.failure_reason).toBe('printer_offline');
    expect(state.printer_failure?.has_successful_print).toBe(false);
    expect(state.drawer_failure).toBeNull();
  });

  it('clears (printer_failure:null) when a later SUCCESS exists on the SAME sale', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'failure', '2026-05-27T10:00:05.000Z');
    printEvent(db, 'pe-2', 'sale-1', 'success', '2026-05-27T10:00:09.000Z');
    expect(projector(db).projectBannerState(SCOPE).printer_failure).toBeNull();
  });

  it('clears when a later manual_override exists on the same sale', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'failure', '2026-05-27T10:00:05.000Z');
    printEvent(db, 'pe-2', 'sale-1', 'manual_override', '2026-05-27T10:00:09.000Z');
    expect(projector(db).projectBannerState(SCOPE).printer_failure).toBeNull();
  });

  it('SILENT-FAILURE GUARD: a newer sale SUCCESS does NOT clear an older sale FAILURE', () => {
    // Sale A fails at 10:00; Sale B (later) succeeds at 10:05. A is still
    // unresolved — the banner MUST surface A, not clear because B succeeded.
    seedSale(db, 'sale-A', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-A', 'sale-A', 'failure', '2026-05-27T10:00:02.000Z');
    seedSale(db, 'sale-B', '2026-05-27T10:05:00.000Z');
    printEvent(db, 'pe-B', 'sale-B', 'success', '2026-05-27T10:05:02.000Z');
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.printer_failure?.sale_id).toBe('sale-A');
  });

  it('with two unresolved failures, surfaces the most-recently-finalized one', () => {
    seedSale(db, 'sale-A', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-A', 'sale-A', 'failure', '2026-05-27T10:00:02.000Z');
    seedSale(db, 'sale-B', '2026-05-27T10:05:00.000Z');
    printEvent(db, 'pe-B', 'sale-B', 'failure', '2026-05-27T10:05:02.000Z');
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.printer_failure?.sale_id).toBe('sale-B');
  });

  it('reports has_successful_print=true when the sale had an earlier success (AD-10)', () => {
    // A reprint that later failed — the sale DID print successfully once.
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    printEvent(db, 'pe-2', 'sale-1', 'failure', '2026-05-27T10:10:00.000Z');
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.printer_failure).not.toBeNull();
    expect(state.printer_failure?.has_successful_print).toBe(true);
  });

  it('tenant-isolation: a failure on another terminal/tenant is NOT surfaced', () => {
    seedSale(db, 'sale-other', '2026-05-27T10:00:00.000Z', { terminal_id: 'terminal-2' });
    printEvent(db, 'pe-o', 'sale-other', 'failure', '2026-05-27T10:00:05.000Z');
    expect(projector(db).projectBannerState(SCOPE)).toEqual({
      printer_failure: null,
      drawer_failure: null,
    });
  });

  it('returns drawer_failure when a sale has a failed drawer event and no printer failure', () => {
    // A successful print + a failed drawer kick (Slice-4 scenario: receipt
    // printed, drawer didn't open). drawer_events FK → print_events.
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.drawer_failure).not.toBeNull();
    expect(state.drawer_failure?.sale_id).toBe('sale-1');
    expect(state.printer_failure).toBeNull();
  });

  it('drawer_failure carries last_successful_open_at from the failed row', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         '2026-05-27T08:30:00.000Z', 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.drawer_failure?.last_successful_open_at).toBe('2026-05-27T08:30:00.000Z');
  });

  it('COEXISTENCE: a printer failure and a concurrent drawer failure are BOTH surfaced', () => {
    // Slice-4 decision (Ahmed 2026-05-29): the two banners coexist. A
    // single-kind union could only ever report one — the drawer failure would
    // be silently hidden behind the printer failure. The record reports both.
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    // A second sale with an unresolved print failure.
    seedSale(db, 'sale-2', '2026-05-27T10:10:00.000Z');
    printEvent(db, 'pe-2', 'sale-2', 'failure', '2026-05-27T10:10:05.000Z');
    const state = projector(db).projectBannerState(SCOPE);
    expect(state.printer_failure?.sale_id).toBe('sale-2');
    expect(state.drawer_failure?.sale_id).toBe('sale-1');
  });

  it('CLEAR-PATH: a later "opened" drawer event on the SAME terminal clears the failed banner', () => {
    // Hardware-recovery (Slice-4 clear-path, Ahmed 2026-05-30): the drawer
    // banner is a terminal hardware-state signal. Sale-1's drawer fails at
    // 10:00; sale-2's drawer OPENS at 10:10 on the same terminal → the drawer
    // recovered → the banner clears (no per-sale success is possible — FR-053).
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    seedSale(db, 'sale-2', '2026-05-27T10:10:00.000Z');
    printEvent(db, 'pe-2', 'sale-2', 'success', '2026-05-27T10:10:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-2', 'sale-2', 'opened', NULL, NULL,
         NULL, 'pe-2', 'terminal-1', '2026-05-27T10:10:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure).toBeNull();
  });

  it('CLEAR-PATH: an EARLIER "opened" event does NOT clear a later failure (still faulting)', () => {
    // The drawer opened at 09:00, then FAILED at 10:00 with no recovery since →
    // the banner must still show (an earlier success is not recovery).
    seedSale(db, 'sale-0', '2026-05-27T09:00:00.000Z');
    printEvent(db, 'pe-0', 'sale-0', 'success', '2026-05-27T09:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-0', 'sale-0', 'opened', NULL, NULL,
         NULL, 'pe-0', 'terminal-1', '2026-05-27T09:00:06.000Z')`,
    );
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure?.sale_id).toBe('sale-1');
  });

  it('CLEAR-PATH: a later "opened" on a DIFFERENT terminal does NOT clear this terminal’s failure', () => {
    // Recovery is per-terminal: another terminal's drawer opening proves nothing
    // about THIS terminal's hardware.
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    // A later 'opened' on terminal-2 (FK needs a sale + print event there).
    seedSale(db, 'sale-x', '2026-05-27T10:10:00.000Z', { terminal_id: 'terminal-2' });
    printEvent(db, 'pe-x', 'sale-x', 'success', '2026-05-27T10:10:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-x', 'sale-x', 'opened', NULL, NULL,
         NULL, 'pe-x', 'terminal-2', '2026-05-27T10:10:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure?.sale_id).toBe('sale-1');
  });

  it('RT-531: a suppressed/no_drawer_configured row (no drawer) raises NO drawer_failure', () => {
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'suppressed', 'no_drawer_configured', NULL,
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure).toBeNull();
  });

  it('RT-531: a LEGACY failed/no_drawer_configured row (stub era) never shows the notice', () => {
    // Before RT-531 the stub wrote `failed` for every cash sale on a terminal
    // with no drawer. drawer_events is append-only, and a drawerless terminal
    // never produces the later `opened` that clears it, so the projector must
    // not surface those historical rows after the upgrade.
    seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
    printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'no_drawer_configured',
         NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure).toBeNull();
  });

  it.each(['printer_dk_failure', 'os_error'] as const)(
    'RT-531: a configured drawer failing (%s) is still surfaced, over an older legacy row',
    (failure_reason) => {
      seedSale(db, 'sale-1', '2026-05-27T10:00:00.000Z');
      printEvent(db, 'pe-1', 'sale-1', 'success', '2026-05-27T10:00:05.000Z');
      db.run(
        `INSERT INTO drawer_events (
           drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
           last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
         ) VALUES ('de-1', 'sale-1', 'failed', NULL, 'no_drawer_configured',
           NULL, 'pe-1', 'terminal-1', '2026-05-27T10:00:06.000Z')`,
      );
      seedSale(db, 'sale-2', '2026-05-27T10:10:00.000Z');
      printEvent(db, 'pe-2', 'sale-2', 'success', '2026-05-27T10:10:05.000Z');
      db.run(
        `INSERT INTO drawer_events (
           drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
           last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
         ) VALUES ('de-2', 'sale-2', 'failed', NULL, ?,
           NULL, 'pe-2', 'terminal-1', '2026-05-27T10:10:06.000Z')`,
        [failure_reason],
      );
      expect(projector(db).projectBannerState(SCOPE).drawer_failure?.sale_id).toBe('sale-2');
    },
  );

  it('tenant-isolation: a drawer failure on another terminal is NOT surfaced', () => {
    seedSale(db, 'sale-other', '2026-05-27T10:00:00.000Z', { terminal_id: 'terminal-2' });
    printEvent(db, 'pe-o', 'sale-other', 'success', '2026-05-27T10:00:05.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-o', 'sale-other', 'failed', NULL, 'printer_dk_failure',
         NULL, 'pe-o', 'terminal-2', '2026-05-27T10:00:06.000Z')`,
    );
    expect(projector(db).projectBannerState(SCOPE).drawer_failure).toBeNull();
  });
});

describe('banner-state projector — recent-sale snapshot', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
  });

  it('returns null when no sales are finalized for the terminal', () => {
    expect(projector(db).projectRecentSale(SCOPE)).toBeNull();
  });

  it('returns the most-recently-finalized sale summary (sale_id, sale_number, finalized_at)', () => {
    seedSale(db, 'sale-A', '2026-05-27T10:00:00.000Z');
    seedSale(db, 'sale-B', '2026-05-27T10:05:00.000Z');
    const recent = projector(db).projectRecentSale(SCOPE);
    expect(recent).not.toBeNull();
    expect(recent?.sale_id).toBe('sale-B');
    expect(recent?.sale_number).toBe('sale-B');
    expect(recent?.finalized_at).toBe('2026-05-27T10:05:00.000Z');
  });

  it('tenant-isolation: a sale on another terminal is NOT returned', () => {
    seedSale(db, 'sale-other', '2026-05-27T10:00:00.000Z', { terminal_id: 'terminal-2' });
    expect(projector(db).projectRecentSale(SCOPE)).toBeNull();
  });
});
