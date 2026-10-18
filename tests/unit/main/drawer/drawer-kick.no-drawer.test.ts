/**
 * RT-531 — the cash drawer is optional: a cash sale on a terminal with NO drawer.
 *
 * End to end over the real migrations (sql.js), the real drawer-events
 * repository, the real dispatcher and the real banner projector, with a fake
 * transport and audit emitter:
 *
 *   • the transport answers `no_drawer_configured` (Q3, Option A: no new setting);
 *   • exactly ONE `drawer_events` row is written, `suppressed` /
 *     `no_drawer_configured` (FR-053: UNIQUE(sale_id)), never `failed`;
 *   • `sale.drawer.suppressed` is audited with the reason, no failed audit;
 *   • the banner projector raises no `drawer_failure`, so neither `DrawerNotice`
 *     nor `DrawerNoticeInline` has anything to show — every sale, and every
 *     reprint;
 *   • a configured drawer that fails (`printer_dk_failure`, `os_error`) is
 *     unchanged: a `failed` row, a `sale.drawer.failed` audit, and the projected
 *     failure the notice shows.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDrawerKickDispatcher } from '../../../../src/main/drawer/drawer-kick.js';
import type { DrawerKickResult } from '../../../../src/main/drawer/drawer-kick-transport.js';
import { bindBannerStateProjector } from '../../../../src/main/sales/banner-state-projector.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import type {
  SaleAuditEmitter,
  SaleRawAuditEvent,
} from '../../../../src/main/sales/audit-emitter.js';
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

const CASH = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 5500 }]);
const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

let SQL: SqlJsStatic;
let db: SqlJsDatabase;
let audits: SaleRawAuditEvent[];

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  audits = [];
});

function seedCashSale(sale_id: string, finalized_at: string): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (
       ?, ?, ?, 'h-'||?, 'pa-'||?, 'cart-'||?, 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-abc','Mohamed','sess-1', 5500,0,0, ?,
       ?, ?, 'TRN-100','Maadi','12 Road 9', '2026-10-15','[]'
     )`,
    [sale_id, sale_id, sale_id, sale_id, sale_id, sale_id, CASH, finalized_at, finalized_at],
  );
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, ?, 'success', 'first_print', 'escpos_direct', 'op-abc','sess-1', NULL, NULL, NULL, ?)`,
    [`pe-${sale_id}`, sale_id, finalized_at],
  );
}

function dispatcherFor(result: DrawerKickResult) {
  const handle = makeSqlJsHandle(db);
  const kick = vi.fn((): Promise<DrawerKickResult> => Promise.resolve(result));
  let seq = 0;
  let minute = 0;
  const auditEmitter: Partial<SaleAuditEmitter> = {
    emitRaw: vi.fn((event: SaleRawAuditEvent) => {
      audits.push(event);
    }),
  };
  const dispatcher = createDrawerKickDispatcher({
    drawerEventsRepo: bindDrawerEventsRepository(handle),
    transport: { kick },
    auditEmitter: auditEmitter as SaleAuditEmitter,
    now: () => `2026-10-15T10:${String((minute += 1)).padStart(2, '0')}:00.000Z`,
    newDrawerEventId: () => `de-${String((seq += 1))}`,
  });
  const dispatch = (sale_id: string): Promise<void> =>
    dispatcher.dispatchOnFirstPrintSuccess({
      sale_id,
      ...SCOPE,
      session_id: 'sess-1',
      attribution_operator_id: 'op-abc',
      tender_lines_summary_json: CASH,
      triggering_print_event_id: `pe-${sale_id}`,
    });
  return { dispatch, kick };
}

const rows = (): unknown[][] =>
  db.exec(
    `SELECT sale_id, outcome, suppression_reason, failure_reason FROM drawer_events ORDER BY sale_id`,
  )[0]?.values ?? [];

const projected = () => bindBannerStateProjector(makeSqlJsHandle(db)).projectBannerState(SCOPE);

describe('RT-531 cash sale on a terminal with no drawer', () => {
  it('writes one suppressed row, audits it, and raises no notice', async () => {
    seedCashSale('sale-1', '2026-10-15T10:00:00.000Z');
    const { dispatch, kick } = dispatcherFor({ ok: false, failure_reason: 'no_drawer_configured' });
    await dispatch('sale-1');
    expect(kick).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([['sale-1', 'suppressed', 'no_drawer_configured', null]]);
    expect(audits.map((a) => a.action_category)).toEqual(['sale.drawer.suppressed']);
    expect(audits[0]?.payload).toMatchObject({
      sale_id: 'sale-1',
      suppression_reason: 'no_drawer_configured',
    });
    expect(projected().drawer_failure).toBeNull();
  });

  it('stays one row per sale: a reprint or retry does not write or kick again', async () => {
    seedCashSale('sale-1', '2026-10-15T10:00:00.000Z');
    const { dispatch, kick } = dispatcherFor({ ok: false, failure_reason: 'no_drawer_configured' });
    await dispatch('sale-1');
    await dispatch('sale-1');
    expect(kick).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('raises no notice across a run of cash sales', async () => {
    const { dispatch } = dispatcherFor({ ok: false, failure_reason: 'no_drawer_configured' });
    for (const n of [1, 2, 3]) {
      seedCashSale(`sale-${String(n)}`, `2026-10-15T10:0${String(n)}:00.000Z`);
      await dispatch(`sale-${String(n)}`);
      expect(projected().drawer_failure).toBeNull();
    }
    expect(rows()).toHaveLength(3);
  });

  it('a legacy failed/no_drawer_configured row from before the upgrade raises no notice either', () => {
    seedCashSale('sale-old', '2026-10-14T10:00:00.000Z');
    db.run(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
       ) VALUES ('de-old', 'sale-old', 'failed', NULL, 'no_drawer_configured',
         NULL, 'pe-sale-old', 'terminal-1', '2026-10-14T10:00:01.000Z')`,
    );
    expect(projected().drawer_failure).toBeNull();
  });
});

describe('RT-531 a configured drawer that fails is unchanged', () => {
  it.each(['printer_dk_failure', 'os_error'] as const)(
    'a %s kick writes a failed row, audits it and projects the failure',
    async (failure_reason) => {
      seedCashSale('sale-1', '2026-10-15T10:00:00.000Z');
      const { dispatch } = dispatcherFor({ ok: false, failure_reason });
      await dispatch('sale-1');
      expect(rows()).toEqual([['sale-1', 'failed', null, failure_reason]]);
      expect(audits.map((a) => a.action_category)).toEqual(['sale.drawer.failed']);
      expect(projected().drawer_failure?.sale_id).toBe('sale-1');
    },
  );

  it('an opened drawer writes an opened row and no notice', async () => {
    seedCashSale('sale-1', '2026-10-15T10:00:00.000Z');
    const { dispatch } = dispatcherFor({ ok: true });
    await dispatch('sale-1');
    expect(rows()).toEqual([['sale-1', 'opened', null, null]]);
    expect(projected().drawer_failure).toBeNull();
  });
});
