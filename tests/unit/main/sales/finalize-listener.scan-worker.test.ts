/**
 * T052 — AD-2 v3 scan worker test (RED).
 *
 * Per plan §AD-2 (v3 polling LOCKED) + tasks.md T052:
 *
 * The worker registers a `setInterval` (default 200 ms; configurable 100-1000 ms
 * floor/ceiling) that runs this canonical SELECT each tick:
 *
 *   SELECT ... FROM audit_events
 *    WHERE action_category = 'payment.settled'
 *      AND originating_terminal_id = ?
 *      AND NOT EXISTS (
 *        SELECT 1 FROM sales
 *         WHERE envelope_handoff_action_id = json_extract(payload, '$.handoff_action_id')
 *      )
 *    ORDER BY created_at ASC
 *    LIMIT 32
 *
 * For each returned row, dispatch AD-2 finalize with the row's handoff_action_id
 * as the idempotency key.
 *
 * Assertions:
 *   (a) No `payment.settled` row is double-finalized across concurrent worker
 *       ticks (the `NOT EXISTS` clause guarantees this).
 *   (b) A row finalized by a previous tick does NOT appear in subsequent scans.
 *   (c) The scan is bounded by `LIMIT 32` per tick.
 *   (d) The worker stops the next tick from running before the current tick's
 *       finalize work completes (single-flight per tick).
 *
 * NOT tested here (lands in T054 integration form):
 *   - Startup recovery sub-scans (print + drawer one-shot scans).
 *   - Real `setInterval` timing — we inject a manual tick driver in unit tests
 *     so vitest can advance the clock deterministically without `fakeTimers`.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFinalizeListener } from '../../../../src/main/sales/finalize-listener.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
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

/**
 * Seed a `payment.settled` audit_events row for the worker scan to pick up.
 * The handoff_action_id is encoded into payload JSON so the canonical SELECT's
 * json_extract clause can match it against sales.envelope_handoff_action_id.
 */
function seedPaymentSettled(opts: {
  event_id: string;
  handoff_action_id: string;
  terminal_id?: string;
  created_at?: string;
}): void {
  const terminal_id = opts.terminal_id ?? 'terminal-1';
  const created_at = opts.created_at ?? '2026-05-28T10:00:00.000Z';
  const payload = JSON.stringify({
    handoff_action_id: opts.handoff_action_id,
    payment_attempt_id: `pa-for-${opts.handoff_action_id}`,
    cart_id: `cart-for-${opts.handoff_action_id}`,
    settled_at: created_at,
  });
  db.exec(
    `INSERT INTO audit_events (
       event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
       session_id, action_category, created_at, payload
     ) VALUES (
       '${opts.event_id}', 'tenant-1', 'branch-1', '${terminal_id}', 'op-clerk-user-abc',
       'sess-1', 'payment.settled', '${created_at}',
       '${payload.replace(/'/g, "''")}'
     )`,
  );
}

/**
 * Seed a `sales` row marking `handoff_action_id` as already finalized. The
 * scan's NOT EXISTS clause should exclude the matching audit_events row.
 */
function seedSale(handoff_action_id: string, sale_id: string): void {
  db.exec(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       '${sale_id}', '${sale_id}-num', '${sale_id}-num', '${handoff_action_id}', 'pa-1',
       'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '[]',
       '2026-05-28T10:00:00.000Z', '2026-05-28T10:00:00.500Z', 'TRN', 'B', 'A',
       '2026-05-28'
     )`,
  );
}

describe('T052 — AD-2 v3 scan worker: canonical SELECT', () => {
  it('dispatches finalize for each pending payment.settled row', () => {
    seedPaymentSettled({ event_id: 'evt-1', handoff_action_id: 'handoff-1' });
    seedPaymentSettled({ event_id: 'evt-2', handoff_action_id: 'handoff-2' });

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
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();

    expect(dispatched).toEqual(['handoff-1', 'handoff-2']);
  });

  it('excludes audit_events rows whose handoff_action_id already has a sales row', () => {
    seedPaymentSettled({ event_id: 'evt-1', handoff_action_id: 'handoff-1' });
    seedPaymentSettled({ event_id: 'evt-2', handoff_action_id: 'handoff-2' });
    seedSale('handoff-1', 'sale-1'); // handoff-1 already finalized

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
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();

    expect(dispatched).toEqual(['handoff-2']);
  });

  it('excludes audit_events rows from other terminals', () => {
    seedPaymentSettled({
      event_id: 'evt-1',
      handoff_action_id: 'handoff-1',
      terminal_id: 'terminal-1',
    });
    seedPaymentSettled({
      event_id: 'evt-other',
      handoff_action_id: 'handoff-other',
      terminal_id: 'terminal-OTHER',
    });

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
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();

    expect(dispatched).toEqual(['handoff-1']);
  });

  it('returns rows ordered by created_at ASC (oldest first)', () => {
    seedPaymentSettled({
      event_id: 'evt-newer',
      handoff_action_id: 'handoff-newer',
      created_at: '2026-05-28T10:05:00.000Z',
    });
    seedPaymentSettled({
      event_id: 'evt-older',
      handoff_action_id: 'handoff-older',
      created_at: '2026-05-28T10:01:00.000Z',
    });

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
      now: () => '2026-05-28T10:06:00.000Z',
    });
    listener.runTickOnce();

    expect(dispatched).toEqual(['handoff-older', 'handoff-newer']);
  });

  it('is bounded by LIMIT 32 per tick', () => {
    for (let i = 0; i < 50; i += 1) {
      seedPaymentSettled({
        event_id: `evt-${String(i)}`,
        handoff_action_id: `handoff-${String(i).padStart(3, '0')}`,
        created_at: `2026-05-28T10:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }

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
      now: () => '2026-05-28T11:00:00.000Z',
    });
    listener.runTickOnce();

    expect(dispatched).toHaveLength(32);
    // Oldest 32 should be picked (ORDER BY created_at ASC).
    expect(dispatched[0]).toBe('handoff-000');
    expect(dispatched[31]).toBe('handoff-031');
  });

  it('a row picked up by a previous tick does NOT appear on the next tick after finalize', () => {
    seedPaymentSettled({ event_id: 'evt-1', handoff_action_id: 'handoff-1' });

    const dispatched: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: (handoff_action_id) => {
        dispatched.push(handoff_action_id);
        // Simulate the real finalize transaction inserting a sales row.
        seedSale(handoff_action_id, `sale-for-${handoff_action_id}`);
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();
    expect(dispatched).toEqual(['handoff-1']);

    // Second tick: same audit_events row, but now sales row exists → NOT EXISTS excludes it.
    listener.runTickOnce();
    expect(dispatched).toEqual(['handoff-1']); // unchanged
  });
});

describe('T052 — AD-2 v3 scan worker: single-flight per tick', () => {
  it('does not start a new tick while the previous tick is still running', () => {
    seedPaymentSettled({ event_id: 'evt-1', handoff_action_id: 'handoff-1' });

    let dispatchInFlight = 0;
    let maxConcurrentDispatch = 0;
    const dispatchOrder: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      dispatch: (handoff_action_id) => {
        dispatchInFlight += 1;
        if (dispatchInFlight > maxConcurrentDispatch) {
          maxConcurrentDispatch = dispatchInFlight;
        }
        dispatchOrder.push(handoff_action_id);
        // Mark this in-flight dispatch as still-running by NOT inserting the sale.
        // Next-tick attempt while this is running must be rejected.
        listener.runTickOnce(); // re-entrant attempt during dispatch — must short-circuit
        dispatchInFlight -= 1;
      },
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();

    // Single-flight guarantee: the re-entrant runTickOnce() inside dispatch must
    // not have driven a parallel scan. maxConcurrentDispatch stays at 1.
    expect(maxConcurrentDispatch).toBe(1);
    // Only the original tick dispatched a row.
    expect(dispatchOrder).toEqual(['handoff-1']);
  });
});

describe('T052 — AD-2 v3 scan worker: tickIntervalMs validation', () => {
  it('accepts the default 200ms', () => {
    expect(() =>
      createFinalizeListener({
        db: makeSqlJsHandle(db),
        terminal_id: 'terminal-1',
        dispatch: () => {},
        tickIntervalMs: 200,
        now: () => '2026-05-28T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('accepts the floor 100ms', () => {
    expect(() =>
      createFinalizeListener({
        db: makeSqlJsHandle(db),
        terminal_id: 'terminal-1',
        dispatch: () => {},
        tickIntervalMs: 100,
        now: () => '2026-05-28T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('accepts the ceiling 1000ms', () => {
    expect(() =>
      createFinalizeListener({
        db: makeSqlJsHandle(db),
        terminal_id: 'terminal-1',
        dispatch: () => {},
        tickIntervalMs: 1000,
        now: () => '2026-05-28T10:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('refuses tickIntervalMs below 100ms floor', () => {
    expect(() =>
      createFinalizeListener({
        db: makeSqlJsHandle(db),
        terminal_id: 'terminal-1',
        dispatch: () => {},
        tickIntervalMs: 50,
        now: () => '2026-05-28T10:00:00.000Z',
      }),
    ).toThrow(/tickIntervalMs must be between 100 and 1000/);
  });

  it('refuses tickIntervalMs above 1000ms ceiling', () => {
    expect(() =>
      createFinalizeListener({
        db: makeSqlJsHandle(db),
        terminal_id: 'terminal-1',
        dispatch: () => {},
        tickIntervalMs: 5000,
        now: () => '2026-05-28T10:00:00.000Z',
      }),
    ).toThrow(/tickIntervalMs must be between 100 and 1000/);
  });
});
