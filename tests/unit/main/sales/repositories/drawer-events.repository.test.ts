/**
 * T083 — `drawer_events` repository tests (RED).
 *
 * Surface per tasks.md T083:
 *   - insert(row)
 *   - readBySale(sale_id) — returns the ≤1 row
 *   - findLastSuccessfulOpenForTerminal(terminal_id) — returns attempted_at
 *     or null (used by sale.drawer.failed audit payload)
 *
 * Append-only: no update / no delete (migration 0023 triggers).
 * UNIQUE(sale_id): at most one drawer event per sale (FR-053).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindDrawerEventsRepository } from '../../../../../src/main/sales/repositories/drawer-events.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0052_drawer_events_suppression_no_drawer.sql',
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
  // Parent sale + parent print_event for FK targets.
  db.exec(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       'sale-1', 'TERM-01-2026-05-27-000001', 'TERM-01-2026-05-27-000001', 'handoff-1', 'pa-1',
       'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '[]',
       '2026-05-27T10:00:00.000Z', '2026-05-27T10:00:00.500Z', 'TRN', 'B', 'A',
       '2026-05-27'
     )`,
  );
  db.exec(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (
       'pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
       'op-abc', 'sess-1', NULL, NULL, NULL, '2026-05-27T10:00:01.000Z'
     )`,
  );
});

function buildDrawerEvent(overrides: Record<string, unknown> = {}) {
  return {
    drawer_event_id: 'de-1',
    sale_id: 'sale-1',
    outcome: 'opened' as const,
    suppression_reason: null,
    failure_reason: null,
    last_successful_open_at_for_terminal: null,
    triggering_print_event_id: 'pe-1',
    terminal_id: 'terminal-1',
    attempted_at: '2026-05-27T10:00:02.000Z',
    ...overrides,
  };
}

describe('T083 — drawer_events repository: insert + readBySale', () => {
  it('inserts and reads back a drawer event by sale_id', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildDrawerEvent());
    const row = repo.readBySale('sale-1');
    expect(row).toBeDefined();
    expect(row?.drawer_event_id).toBe('de-1');
    expect(row?.outcome).toBe('opened');
  });

  it('readBySale returns null when sale has no drawer event', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    expect(repo.readBySale('sale-1')).toBeNull();
  });

  it('UNIQUE(sale_id) prevents a second drawer event per sale', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildDrawerEvent());
    expect(() => {
      repo.insert(
        buildDrawerEvent({ drawer_event_id: 'de-2', attempted_at: '2026-05-27T10:01:00.000Z' }),
      );
    }).toThrow(/UNIQUE constraint failed/);
  });
});

describe('T083 — drawer_events repository: findLastSuccessfulOpenForTerminal', () => {
  it('returns the attempted_at of the most recent successful open for the terminal', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    // Need a second sale to host a second drawer event on the same terminal.
    db.exec(
      `INSERT INTO sales (
         sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
         envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
         selling_operator_id, selling_operator_display_name, selling_operator_session_id,
         subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
         settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
         local_calendar_day
       ) VALUES (
         'sale-2', 'TERM-01-2026-05-27-000002', 'TERM-01-2026-05-27-000002', 'handoff-2', 'pa-2',
         'cart-2', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
         'op-abc', 'Ahmed', 'sess-1',
         1500, 0, 0, '[]',
         '2026-05-27T11:00:00.000Z', '2026-05-27T11:00:00.500Z', 'TRN', 'B', 'A',
         '2026-05-27'
       )`,
    );
    db.exec(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES (
         'pe-2', 'sale-2', 'success', 'first_print', 'escpos_direct',
         'op-abc', 'sess-1', NULL, NULL, NULL, '2026-05-27T11:00:01.000Z'
       )`,
    );
    repo.insert(buildDrawerEvent({ attempted_at: '2026-05-27T10:00:02.000Z' }));
    repo.insert(
      buildDrawerEvent({
        drawer_event_id: 'de-2',
        sale_id: 'sale-2',
        triggering_print_event_id: 'pe-2',
        attempted_at: '2026-05-27T11:00:02.000Z',
      }),
    );
    expect(repo.findLastSuccessfulOpenForTerminal('terminal-1')).toBe('2026-05-27T11:00:02.000Z');
  });

  it('returns null when the terminal has never had a successful open', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    expect(repo.findLastSuccessfulOpenForTerminal('terminal-with-no-history')).toBeNull();
  });

  it('ignores failed events when computing last successful open', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildDrawerEvent({
        outcome: 'failed',
        failure_reason: 'printer_dk_failure',
      }),
    );
    expect(repo.findLastSuccessfulOpenForTerminal('terminal-1')).toBeNull();
  });

  it('ignores suppressed events when computing last successful open', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildDrawerEvent({
        outcome: 'suppressed',
        suppression_reason: 'cashless_tender_mix',
      }),
    );
    expect(repo.findLastSuccessfulOpenForTerminal('terminal-1')).toBeNull();
  });
});

describe('RT-531 — drawer_events repository: no drawer configured', () => {
  it('stores a suppressed row with reason no_drawer_configured', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildDrawerEvent({
        outcome: 'suppressed',
        suppression_reason: 'no_drawer_configured',
      }),
    );
    expect(repo.readBySale('sale-1')).toMatchObject({
      outcome: 'suppressed',
      suppression_reason: 'no_drawer_configured',
      failure_reason: null,
    });
  });

  it('a no_drawer_configured suppression is not a successful open', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildDrawerEvent({ outcome: 'suppressed', suppression_reason: 'no_drawer_configured' }),
    );
    expect(repo.findLastSuccessfulOpenForTerminal('terminal-1')).toBeNull();
  });
});

describe('T083 — drawer_events repository: append-only invariant', () => {
  it('UPDATE is denied by trigger', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildDrawerEvent());
    expect(() =>
      db.exec("UPDATE drawer_events SET terminal_id = 'tampered' WHERE drawer_event_id = 'de-1'"),
    ).toThrow(/drawer_events is append-only/);
  });

  it('DELETE is denied by trigger', () => {
    const repo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildDrawerEvent());
    expect(() => db.exec("DELETE FROM drawer_events WHERE drawer_event_id = 'de-1'")).toThrow(
      /drawer_events is append-only/,
    );
  });
});
