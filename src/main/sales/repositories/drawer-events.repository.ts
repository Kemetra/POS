/**
 * T083 — `drawer_events` repository.
 *
 * Owns SQL access for the `drawer_events` table (008 Slice 1c). Wraps the
 * production `DatabaseHandle` interface so tests can inject sql.js.
 *
 * Surface per tasks.md T083:
 *   - insert(row)
 *   - readBySale(sale_id) — returns the ≤1 row (UNIQUE(sale_id) per
 *     migration 0023; FR-053 double-kick suppression at schema layer)
 *   - findLastSuccessfulOpenForTerminal(terminal_id) — returns the
 *     attempted_at of the most recent outcome='opened' event on the
 *     terminal, or null. Used by `sale.drawer.failed` audit payload per
 *     Constitution Principle IV (capture last-known-good state for
 *     incident reconstruction).
 *
 * No update / no delete — append-only at the SQL layer (migration 0023
 * triggers).
 */

import type { DatabaseHandle } from '../../db/client.js';

interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

// ── Closed enums (mirror data-model.md §"Entity: DrawerEvent" + migration 0023) ──

export type DrawerEventOutcome = 'opened' | 'suppressed' | 'failed';
export type DrawerEventSuppressionReason = 'cashless_tender_mix' | 'no_drawer_configured';
/**
 * `no_drawer_configured` stays in the failure union for the historical rows the
 * pre-RT-531 stub wrote (the table is append-only). It is also what the transport
 * answers for a terminal with no drawer; the dispatcher turns THAT answer into a
 * `suppressed` row (RT-531), so a new `failed` row never carries it.
 */
export type DrawerEventFailureReason = 'printer_dk_failure' | 'os_error' | 'no_drawer_configured';

export interface DrawerEventRow {
  drawer_event_id: string;
  sale_id: string;
  outcome: DrawerEventOutcome;
  suppression_reason: DrawerEventSuppressionReason | null;
  failure_reason: DrawerEventFailureReason | null;
  last_successful_open_at_for_terminal: string | null;
  triggering_print_event_id: string;
  terminal_id: string;
  attempted_at: string;
}

export type InsertDrawerEventInput = DrawerEventRow;

export interface DrawerEventsRepository {
  insert(row: InsertDrawerEventInput): void;
  readBySale(sale_id: string): DrawerEventRow | null;
  findLastSuccessfulOpenForTerminal(terminal_id: string): string | null;
}

export function bindDrawerEventsRepository(db: DatabaseHandle): DrawerEventsRepository {
  const insertStmt = db.prepare(
    `INSERT INTO drawer_events (
       drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
       last_successful_open_at_for_terminal, triggering_print_event_id,
       terminal_id, attempted_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?,
       ?, ?
     )`,
  ) as PrepareRun;

  const readBySaleStmt = db.prepare(
    `SELECT * FROM drawer_events WHERE sale_id = ?`,
  ) as PrepareGet<DrawerEventRow>;

  const findLastOpenStmt = db.prepare(
    `SELECT attempted_at FROM drawer_events
      WHERE terminal_id = ? AND outcome = 'opened'
      ORDER BY attempted_at DESC
      LIMIT 1`,
  ) as PrepareGet<{ attempted_at: string }>;

  return {
    insert(row: InsertDrawerEventInput): void {
      insertStmt.run(
        row.drawer_event_id,
        row.sale_id,
        row.outcome,
        row.suppression_reason,
        row.failure_reason,
        row.last_successful_open_at_for_terminal,
        row.triggering_print_event_id,
        row.terminal_id,
        row.attempted_at,
      );
    },

    readBySale(sale_id: string): DrawerEventRow | null {
      const row = readBySaleStmt.get(sale_id);
      return row ?? null;
    },

    findLastSuccessfulOpenForTerminal(terminal_id: string): string | null {
      const row = findLastOpenStmt.get(terminal_id);
      return row?.attempted_at ?? null;
    },
  };
}
