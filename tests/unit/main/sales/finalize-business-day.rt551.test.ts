/**
 * RT-551 (RT-545 S2) — the sale-number day is the store business day
 * (Africa/Cairo) of `finalized_at`, with the Option A cutover.
 *
 * Covers the RT-551 test plan:
 *   - the number date and `sales.local_calendar_day` come from `finalized_at`
 *     in Cairo (not `settled_at`, not UTC), including a boot-recovery sale;
 *   - the embedded date always equals the counter key;
 *   - the cutover at Cairo 01:30 and 22:30, in winter and summer time, with
 *     legacy (old-build, UTC-keyed) sales already issued that night;
 *   - old build -> new build -> old build (rollback) stays unique;
 *   - a guard proving the forbidden separate Cairo counter would collide;
 *   - the one-time `sale.number_day_rule.switched` audit event.
 *
 * "Old build" sales are written exactly as the old build did: the allocator
 * keyed by the UTC date of `settled_at`, then the sales insert.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  bindFinalizeTransaction,
  type FinalizeInput,
  type FinalizeResult,
} from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import {
  createSaleAuditEmitter,
  EmitRawForbiddenCategoryError,
  type SaleAuditEvent,
  type SaleRawAuditEvent,
} from '../../../../src/main/sales/audit-emitter.js';
import { SALE_NUMBER_DAY_RULE_SWITCHED } from '../../../../src/main/sales/sale-number-day-rule.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { buildCapturePayload } from '../../../../src/main/sales-sync/capture-payload.js';
import { businessDayOf } from '../../../../src/shared/time/business-day.js';
import { SYSTEM_DEVICE_ACTOR_ID } from '../../../../src/shared/audit/event-shape.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
let handle: DatabaseHandle;
let seq = 0;

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  handle = makeSqlJsHandle(db);
  seq = 0;
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TERMINAL = 'terminal-1';
const LABEL = 'TERM-01';

/** The production sink: sale audit events land in `audit_events` (same DB). */
function auditEmitterOverDb() {
  const store = bindAuditEventsStoreDb(handle);
  let eventSeq = 0;
  return createSaleAuditEmitter({
    sink: {
      write: (evt: SaleAuditEvent) => {
        eventSeq += 1;
        store.insertIgnore({
          event_id: `evt-${String(eventSeq)}-${evt.action_category}-${evt.created_at}`,
          tenant_id: evt.tenant_id,
          branch_id: evt.branch_id,
          originating_terminal_id: evt.originating_terminal_id,
          acting_operator_id: evt.attribution_operator_id,
          session_id: evt.session_id,
          shift_id: null,
          action_category: evt.action_category,
          created_at: evt.created_at,
          approving_supervisor_id: null,
          payload: evt.payload,
        });
      },
    },
  });
}

/** A fresh finalize transaction (a "process start") whose clock reads `clock.at`. */
function newBuild(clock: { at: string }, overrides: Record<string, unknown> = {}) {
  return bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: auditEmitterOverDb(),
    now: () => clock.at,
    saleIdGenerator: () => `sale-${String(seq)}`,
    outboxRowIdGenerator: () => `ob-${String(seq)}`,
    ...overrides,
  });
}

/** A settled payment waiting to be finalized. */
interface Settled {
  n: string;
  handoff: string;
  settled_at: string;
  terminal_id: string;
}

/** Seeds a settled attempt + applied cash line for the next handoff id. */
function seedSettled(settled_at: string, terminal_id = TERMINAL): Settled {
  seq += 1;
  const n = String(seq);
  db.exec(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id,
       envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
       state, started_at, settled_at, last_action_id
     ) VALUES ('pa-${n}', 'tenant-1', 'branch-1', '${terminal_id}', 'op-1', 'sess-1',
       'handoff-${n}', 'cart-${n}', 1500, 'settled', '${settled_at}', '${settled_at}', 'a-${n}')`,
  );
  db.exec(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
       state, applied_at, attribution_operator_id, apply_order, last_action_id
     ) VALUES ('tl-${n}', 'pa-${n}', 'cash', 1500, 'applied', '${settled_at}', 'op-1', 1, 'a-${n}')`,
  );
  return { n, handoff: `handoff-${n}`, settled_at, terminal_id };
}

function inputFor({ n, handoff, settled_at, terminal_id }: Settled): FinalizeInput {
  return {
    envelope_handoff_action_id: handoff,
    payment_attempt_id: `pa-${n}`,
    envelope_cart_id: `cart-${n}`,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    terminal_label: LABEL,
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Ahmed',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [{ tender_type: 'cash', amount_applied_minor: 1500 }],
    settled_at,
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'Maadi',
    branch_address: '12 Road 9',
    lines: [],
  };
}

/** New build: settle at `settled_at`, finalize at `finalized_at`. */
function finalizeNew(settled_at: string, finalized_at = settled_at): string {
  const result = newBuild({ at: finalized_at }).finalize(inputFor(seedSettled(settled_at)));
  return expectFinalized(result);
}

/** Old build: the allocator keyed by the UTC date of `settled_at`, then the insert. */
function finalizeLegacy(at: string): string {
  const settled = seedSettled(at);
  const day = at.slice(0, 10);
  const sale_number = bindSaleNumberAllocator(handle).allocate({
    terminal_id: TERMINAL,
    terminal_label: LABEL,
    local_calendar_day: day,
  });
  insertSaleRow(settled, { sale_number, day });
  return sale_number;
}

/** Inserts a sale row as the old build did: finalized when settled. */
function insertSaleRow(
  { n, handoff, settled_at: at }: Settled,
  { sale_number, day }: { sale_number: string; day: string },
): void {
  bindSalesRepository(handle).insert({
    sale_id: `legacy-${n}-${sale_number}`,
    sale_number,
    receipt_number: sale_number,
    envelope_handoff_action_id: handoff,
    payment_attempt_id: `pa-${n}`,
    envelope_cart_id: `cart-${n}`,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: TERMINAL,
    terminal_label: LABEL,
    selling_operator_id: 'op-1',
    selling_operator_display_name: 'Ahmed',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: '[]',
    settled_at: at,
    finalized_at: at,
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'Maadi',
    branch_address: '12 Road 9',
    local_calendar_day: day,
    lines_json: '[]',
  });
}

function expectFinalized(result: FinalizeResult): string {
  if (result.kind !== 'finalized') throw new Error(`expected finalized, got ${result.kind}`);
  return result.sale_number;
}

function all<T>(sql: string, ...params: unknown[]): T[] {
  return (handle.prepare(sql) as { all(...p: unknown[]): T[] }).all(...params);
}

interface SwitchEventRow {
  originating_terminal_id: string;
  acting_operator_id: string;
  session_id: string | null;
  payload: string;
}

function switchEvents(): SwitchEventRow[] {
  return all(
    `SELECT originating_terminal_id, acting_operator_id, session_id, payload FROM audit_events
      WHERE action_category = ? ORDER BY created_at`,
    SALE_NUMBER_DAY_RULE_SWITCHED,
  );
}

const datePart = (saleNumber: string): string => saleNumber.slice(LABEL.length + 1, -7);

// ─── Day = businessDayOf(finalized_at) ──────────────────────────────────────

describe('RT-551 — the sale-number day is the Cairo day of finalized_at', () => {
  it('dates a sale finalized at Cairo 00:30 (winter) by the Cairo day, not the UTC day', () => {
    // 2026-01-15T22:30Z = 2026-01-16 00:30 in Cairo (UTC+2).
    const number = finalizeNew('2026-01-15T22:30:00.000Z');
    expect(number).toBe('TERM-01-2026-01-16-000001');
  });

  it('dates a sale finalized at Cairo 02:30 (summer time) by the Cairo day', () => {
    // 2026-07-14T23:30Z = 2026-07-15 02:30 in Cairo (UTC+3).
    expect(finalizeNew('2026-07-14T23:30:00.000Z')).toBe('TERM-01-2026-07-15-000001');
  });

  it('stores local_calendar_day equal to the embedded date', () => {
    finalizeNew('2026-01-15T22:30:00.000Z');
    const [row] = all<{ sale_number: string; local_calendar_day: string }>(
      'SELECT sale_number, local_calendar_day FROM sales',
    );
    expect(row?.local_calendar_day).toBe('2026-01-16');
    expect(datePart(row?.sale_number ?? '')).toBe('2026-01-16');
  });

  it('boot recovery: settled 23:50 Cairo on D, finalized 08:00 on D+1 -> D+1 everywhere', () => {
    // Winter: 23:50 Cairo on 2026-01-15 = 21:50Z; 08:00 Cairo on 01-16 = 06:00Z.
    const number = finalizeNew('2026-01-15T21:50:00.000Z', '2026-01-16T06:00:00.000Z');
    expect(datePart(number)).toBe('2026-01-16');
    const sale = bindSalesRepository(handle).findByHandoffActionId('handoff-1');
    expect(sale?.local_calendar_day).toBe('2026-01-16');
    if (sale === null) throw new Error('sale missing');
    expect(businessDayOf(buildCapturePayload(sale).occurredAt)).toBe('2026-01-16');
  });

  it('starts a new sequence at Cairo midnight, not at UTC midnight', () => {
    // Winter: Cairo 23:59 on 01-15 (21:59Z), then Cairo 00:01 on 01-16 (22:01Z).
    expect(finalizeNew('2026-01-15T21:59:00.000Z')).toBe('TERM-01-2026-01-15-000001');
    expect(finalizeNew('2026-01-15T22:01:00.000Z')).toBe('TERM-01-2026-01-16-000001');
    // UTC midnight (Cairo 02:00) does not reset the Cairo day's sequence.
    expect(finalizeNew('2026-01-16T00:01:00.000Z')).toBe('TERM-01-2026-01-16-000002');
  });

  it('maps both occurrences of the repeated hour at the summer-time end to the same day', () => {
    // Egypt summer time ends at 24:00 on Thu 2026-10-29: 23:00-24:00 repeats.
    // First 23:30 (UTC+3) = 20:30Z; second 23:30 (UTC+2) = 21:30Z.
    expect(finalizeNew('2026-10-29T20:30:00.000Z')).toBe('TERM-01-2026-10-29-000001');
    expect(finalizeNew('2026-10-29T21:30:00.000Z')).toBe('TERM-01-2026-10-29-000002');
    expect(finalizeNew('2026-10-29T22:30:00.000Z')).toBe('TERM-01-2026-10-30-000001');
  });
});

// ─── Invariant: embedded date === counter key ───────────────────────────────

describe('RT-551 — the embedded date is always the counter key', () => {
  it('holds for every sale across a mixed legacy/new history', () => {
    finalizeLegacy('2026-01-15T10:00:00.000Z');
    finalizeLegacy('2026-01-15T23:00:00.000Z'); // Cairo 01:00 on 01-16, UTC key 01-15
    finalizeNew('2026-01-15T23:30:00.000Z');
    finalizeNew('2026-01-16T09:00:00.000Z');
    finalizeLegacy('2026-01-16T10:00:00.000Z');

    const sales = all<{ sale_number: string; local_calendar_day: string }>(
      'SELECT sale_number, local_calendar_day FROM sales',
    );
    const keys = new Map(
      all<{ calendar_day_local: string; next_sequence: number }>(
        `SELECT calendar_day_local, next_sequence FROM sale_number_sequences WHERE terminal_id = ?`,
        TERMINAL,
      ).map((r) => [r.calendar_day_local, r.next_sequence]),
    );
    expect(sales).toHaveLength(5);
    for (const sale of sales) {
      const day = datePart(sale.sale_number);
      expect(day).toBe(sale.local_calendar_day);
      expect(keys.has(day)).toBe(true);
      expect(Number(sale.sale_number.slice(-6))).toBeLessThan(keys.get(day) ?? 0);
    }
  });
});

// ─── Cutover (Option A) ─────────────────────────────────────────────────────

describe('RT-551 — Option A cutover on the switch day', () => {
  it.each([
    // [season, legacy instants earlier that night, new-build instant, expected number]
    // Winter (UTC+2). Install at Cairo 01:30 on 01-16 = 23:30Z on 01-15.
    [
      'winter, 01:30 Cairo',
      ['2026-01-15T10:00:00.000Z', '2026-01-15T22:30:00.000Z'],
      '2026-01-15T23:30:00.000Z',
      'TERM-01-2026-01-16-000001',
    ],
    // Winter, install at Cairo 22:30 on 01-15 = 20:30Z: UTC and Cairo keys agree.
    [
      'winter, 22:30 Cairo',
      ['2026-01-15T10:00:00.000Z', '2026-01-15T15:00:00.000Z'],
      '2026-01-15T20:30:00.000Z',
      'TERM-01-2026-01-15-000003',
    ],
    // Summer (UTC+3). Install at Cairo 01:30 on 07-15 = 22:30Z on 07-14.
    [
      'summer, 01:30 Cairo',
      ['2026-07-14T10:00:00.000Z', '2026-07-14T21:30:00.000Z'],
      '2026-07-14T22:30:00.000Z',
      'TERM-01-2026-07-15-000001',
    ],
    // Summer, install at Cairo 22:30 on 07-14 = 19:30Z.
    [
      'summer, 22:30 Cairo',
      ['2026-07-14T10:00:00.000Z', '2026-07-14T15:00:00.000Z'],
      '2026-07-14T19:30:00.000Z',
      'TERM-01-2026-07-14-000003',
    ],
  ])('%s: numbering starts or continues without a collision', (_s, legacy, at, expected) => {
    const legacyNumbers = legacy.map(finalizeLegacy);
    const number = finalizeNew(at);
    expect(number).toBe(expected);
    expect(legacyNumbers).not.toContain(number);
    // The rest of that Cairo day continues the same counter.
    const next = finalizeNew(new Date(Date.parse(at) + 60_000).toISOString());
    expect(Number(next.slice(-6))).toBe(Number(number.slice(-6)) + 1);
  });

  it('never renumbers or rewrites an already-issued legacy number', () => {
    const legacy = finalizeLegacy('2026-01-15T23:00:00.000Z');
    finalizeNew('2026-01-15T23:30:00.000Z');
    const stored = all<{ sale_number: string; local_calendar_day: string }>(
      'SELECT sale_number, local_calendar_day FROM sales WHERE sale_number = ?',
      legacy,
    );
    expect(stored).toEqual([{ sale_number: legacy, local_calendar_day: '2026-01-15' }]);
    expect(bindSalesRepository(handle).findByHandoffActionId('handoff-1')?.sale_number).toBe(
      legacy,
    );
  });

  it('old build -> new build -> old build (rollback) keeps every number unique', () => {
    // All on Cairo day 2026-01-16 / UTC day 2026-01-16 where they overlap.
    const issued = [
      finalizeLegacy('2026-01-16T08:00:00.000Z'), // old: key 01-16
      finalizeNew('2026-01-16T09:00:00.000Z'), // new: key 01-16
      finalizeNew('2026-01-16T22:30:00.000Z'), // new: Cairo 00:30 on 01-17
      finalizeLegacy('2026-01-16T23:00:00.000Z'), // rolled back: UTC key 01-16
      finalizeLegacy('2026-01-17T00:30:00.000Z'), // rolled back: UTC key 01-17
    ];
    expect(new Set(issued).size).toBe(issued.length);
    expect(issued).toEqual([
      'TERM-01-2026-01-16-000001',
      'TERM-01-2026-01-16-000002',
      'TERM-01-2026-01-17-000001',
      'TERM-01-2026-01-16-000003',
      'TERM-01-2026-01-17-000002',
    ]);
  });

  it('guard: a separate Cairo counter restarting at 000001 would collide and refuse', () => {
    const legacy = finalizeLegacy('2026-01-16T08:00:00.000Z'); // TERM-01-2026-01-16-000001
    const settled = seedSettled('2026-01-16T09:00:00.000Z');
    // The forbidden design: a fresh namespace for Cairo days, embedded date unchanged.
    const fresh = bindSaleNumberAllocator(handle).allocate({
      terminal_id: `cairo:${TERMINAL}`,
      terminal_label: LABEL,
      local_calendar_day: '2026-01-16',
    });
    expect(fresh).toBe(legacy);
    expect(() => {
      insertSaleRow(settled, { sale_number: fresh, day: '2026-01-16' });
    }).toThrow(/UNIQUE/);
    // The shared counter used by the new build continues instead.
    expect(finalizeNew('2026-01-16T09:30:00.000Z')).toBe('TERM-01-2026-01-16-000002');
  });
});

// ─── One-time audit event ───────────────────────────────────────────────────

describe('RT-551 — sale.number_day_rule.switched is written once per terminal', () => {
  it('records the first new-build sale: terminal, number, finalized_at, day, zone', () => {
    finalizeLegacy('2026-01-15T10:00:00.000Z');
    const number = finalizeNew('2026-01-15T10:00:00.000Z', '2026-01-15T23:30:00.000Z');
    const events = switchEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.originating_terminal_id).toBe(TERMINAL);
    expect(event?.acting_operator_id).toBe(SYSTEM_DEVICE_ACTOR_ID);
    expect(event?.session_id).toBeNull();
    expect(JSON.parse(event?.payload ?? 'null')).toEqual({
      terminal_id: TERMINAL,
      sale_id: 'sale-2',
      sale_number: number,
      finalized_at: '2026-01-15T23:30:00.000Z',
      business_day: '2026-01-16',
      time_zone: 'Africa/Cairo',
    });
  });

  it('is not written again for later sales, nor after a restart', () => {
    finalizeNew('2026-01-15T10:00:00.000Z');
    finalizeNew('2026-01-15T11:00:00.000Z');
    // A restart is a fresh binding over the same database.
    const settled = seedSettled('2026-01-16T10:00:00.000Z');
    newBuild({ at: '2026-01-16T10:00:00.000Z' }).finalize(inputFor(settled));
    expect(switchEvents()).toHaveLength(1);
  });

  it('on one binding, scans for the marker once, then remembers the committed switch', () => {
    let markerQueries = 0;
    const counting: DatabaseHandle = {
      ...handle,
      prepare: (sql: string) => {
        const stmt = handle.prepare(sql) as { get(...p: unknown[]): unknown };
        if (!sql.includes('AND session_id IS NULL')) return stmt;
        return {
          ...stmt,
          get: (...p: unknown[]) => {
            markerQueries += 1;
            return stmt.get(...p);
          },
        };
      },
    };
    const clock = { at: '2026-01-15T10:00:00.000Z' };
    const txn = newBuild(clock, { db: counting });
    for (const at of [
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T11:00:00.000Z',
      '2026-01-15T12:00:00.000Z',
    ]) {
      clock.at = at;
      expectFinalized(txn.finalize(inputFor(seedSettled(at))));
    }
    expect(switchEvents()).toHaveLength(1);
    // Sale 1 finds no marker and writes it; once that commits, sales 2 and 3
    // use the memo: the audit_events scan runs once per terminal per process.
    expect(markerQueries).toBe(1);
  });

  it('does not count a row from another actor or a session as the switch', () => {
    // Defence in depth: the renderer audit IPC refuses this category, but a row
    // carrying an operator and session must still never stand in for the switch.
    db.exec(
      `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
         acting_operator_id, session_id, action_category, created_at, payload)
       VALUES ('forged-1', 'tenant-1', 'branch-1', '${TERMINAL}', 'op-1', 'sess-1',
         '${SALE_NUMBER_DAY_RULE_SWITCHED}', '2026-01-15T09:00:00.000Z', '{}')`,
    );
    finalizeNew('2026-01-15T10:00:00.000Z');
    expect(switchEvents().map((e) => e.acting_operator_id)).toEqual([
      'op-1',
      SYSTEM_DEVICE_ACTOR_ID,
    ]);
  });

  it('is not written by an idempotent replay', () => {
    const settled = seedSettled('2026-01-15T10:00:00.000Z');
    const txn = newBuild({ at: '2026-01-15T10:00:00.000Z' });
    txn.finalize(inputFor(settled));
    const replay = txn.finalize(inputFor(settled));
    expect(replay.kind).toBe('finalized_idempotent');
    expect(switchEvents()).toHaveLength(1);
  });

  it('is written once for each terminal', () => {
    finalizeNew('2026-01-15T10:00:00.000Z');
    const other = 'terminal-2';
    const settled = seedSettled('2026-01-15T10:05:00.000Z', other);
    newBuild({ at: '2026-01-15T10:05:00.000Z' }).finalize(inputFor(settled));
    expect(switchEvents().map((e) => e.originating_terminal_id)).toEqual([TERMINAL, other]);
  });

  it('rolls back with the sale, then is written once by the next successful finalize', () => {
    const at = '2026-01-15T10:00:00.000Z';
    const settled = seedSettled(at);
    const realOutbox = bindSaleSyncOutboxRepository(handle);
    const failing = newBuild(
      { at },
      {
        outboxRepo: {
          ...realOutbox,
          insert: () => {
            throw new Error('simulated outbox failure');
          },
        },
      },
    );
    expect(() => failing.finalize(inputFor(settled))).toThrow('simulated outbox failure');
    expect(all('SELECT 1 FROM sales')).toHaveLength(0);
    expect(all('SELECT 1 FROM sale_number_sequences')).toHaveLength(0);
    expect(switchEvents()).toHaveLength(0);

    // A later binding (next tick or restart) retries after the failure.
    const retry = newBuild({ at });
    expect(expectFinalized(retry.finalize(inputFor(settled)))).toBe('TERM-01-2026-01-15-000001');
    finalizeNew('2026-01-15T11:00:00.000Z');
    expect(switchEvents()).toHaveLength(1);
  });

  it('keeps writing the switch event after a failed finalize on the same binding', () => {
    const at = '2026-01-15T10:00:00.000Z';
    const settled = seedSettled(at);
    let fail = true;
    const realOutbox = bindSaleSyncOutboxRepository(handle);
    const txn = newBuild(
      { at },
      {
        outboxRepo: {
          ...realOutbox,
          insert: (row: Parameters<typeof realOutbox.insert>[0]) => {
            if (fail) throw new Error('simulated outbox failure');
            realOutbox.insert(row);
          },
        },
      },
    );
    expect(() => txn.finalize(inputFor(settled))).toThrow();
    fail = false;
    expectFinalized(txn.finalize(inputFor(settled)));
    expect(switchEvents()).toHaveLength(1);
  });

  it('cannot be forged through emitRaw', () => {
    const emitter = auditEmitterOverDb();
    const forged = {
      action_category: SALE_NUMBER_DAY_RULE_SWITCHED,
      attribution_operator_id: 'op-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      originating_terminal_id: TERMINAL,
      session_id: null,
      created_at: '2026-01-15T10:00:00.000Z',
      payload: {},
    } as unknown as SaleRawAuditEvent;
    expect(() => {
      emitter.emitRaw(forged);
    }).toThrow(EmitRawForbiddenCategoryError);
    expect(switchEvents()).toHaveLength(0);
  });
});
