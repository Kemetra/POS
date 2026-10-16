/**
 * RT-551 (RT-545 S2) — the sale-number day rule and its one-time switch record.
 *
 * The sale-number day is the store business day (`businessDayOf`, Africa/Cairo)
 * of `finalized_at`. The old build dated a sale by the UTC date of
 * `settled_at`. Option A cutover (RT-545 decision 12085 item 1): the new rule
 * applies from each terminal's first sale finalized on the new build, and that
 * moment is recorded once per terminal by `sale.number_day_rule.switched`.
 *
 * Both rules share one counter row per date `(terminal_id, 'YYYY-MM-DD')`, and
 * the embedded date is always that key, so a switch, a rollback to the old
 * build or a clock step can never issue the same number twice. A separate
 * counter for Cairo days is forbidden: it would restart at 000001 on a date
 * the UTC run already used and hit `UNIQUE (terminal_id, sale_number)`.
 *
 * The once-only marker is the audit row itself (no new column or table, no
 * migration). It is checked and written inside the finalize transaction, so
 * it commits or rolls back with the sale. Only a row with the system actor and
 * no session counts, and the renderer's audit IPC refuses this category, so a
 * forged row can neither stand in for the switch nor suppress it.
 */

import type { DatabaseHandle } from '../db/client.js';
import { STORE_TIME_ZONE, businessDayOf } from '../../shared/time/business-day.js';
import { SYSTEM_DEVICE_ACTOR_ID } from '../../shared/audit/event-shape.js';
import type { SaleAuditEmitter } from './audit-emitter.js';

export const SALE_NUMBER_DAY_RULE_SWITCHED = 'sale.number_day_rule.switched';

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

/** The day a sale finalized at `finalized_at` is numbered under. */
export function saleNumberDayOf(finalized_at: string): string {
  return businessDayOf(finalized_at);
}

/** The first new-build sale of a terminal, as written by the finalize transaction. */
export interface DayRuleSwitchSale {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  sale_id: string;
  sale_number: string;
  finalized_at: string;
  business_day: string;
}

export interface SaleNumberDayRuleSwitch {
  /**
   * Inside the finalize transaction, after the sale insert: writes
   * `sale.number_day_rule.switched` when this terminal has none yet.
   */
  recordIfFirst(sale: DayRuleSwitchSale): void;
  /**
   * After the finalize transaction committed a sale for this terminal: its
   * switch row is committed too (found or written), so later finalizes of this
   * process skip the `audit_events` lookup.
   */
  noteCommitted(tenant_id: string, terminal_id: string): void;
}

export interface SaleNumberDayRuleSwitchDeps {
  db: DatabaseHandle;
  auditEmitter: SaleAuditEmitter;
}

export function bindSaleNumberDayRuleSwitch(
  deps: SaleNumberDayRuleSwitchDeps,
): SaleNumberDayRuleSwitch {
  const { db, auditEmitter } = deps;
  // Terminals whose switch row is known to be committed. A row written inside
  // the transaction is remembered only after the commit (`noteCommitted`): it
  // can still roll back with its sale, and the next finalize must rewrite it.
  // A row the query finds is already committed, because the finalize
  // transaction is top-level (no outer transaction or savepoint).
  const committed = new Set<string>();
  // `audit_events` has no index on the category (0004) and RT-551 adds no
  // migration, so the lookup scans the table (about 5 ms per 50k rows under
  // sql.js). With the memo it runs once per terminal per process, on its
  // first sale.
  let findStmt: PrepareGet<{ found: number }> | null = null;
  const keyOf = (tenant_id: string, terminal_id: string): string =>
    `${tenant_id}\u0000${terminal_id}`;

  function hasSwitched(tenant_id: string, terminal_id: string): boolean {
    const key = keyOf(tenant_id, terminal_id);
    if (committed.has(key)) return true;
    findStmt ??= db.prepare(
      `SELECT 1 AS found FROM audit_events
        WHERE action_category = ? AND tenant_id = ? AND originating_terminal_id = ?
          AND acting_operator_id = ? AND session_id IS NULL
        LIMIT 1`,
    ) as PrepareGet<{ found: number }>;
    const row = findStmt.get(
      SALE_NUMBER_DAY_RULE_SWITCHED,
      tenant_id,
      terminal_id,
      SYSTEM_DEVICE_ACTOR_ID,
    );
    if (row === undefined) return false;
    committed.add(key);
    return true;
  }

  return {
    recordIfFirst(sale: DayRuleSwitchSale): void {
      if (hasSwitched(sale.tenant_id, sale.terminal_id)) return;
      auditEmitter.emitSaleNumberDayRuleSwitched({
        ...sale,
        time_zone: STORE_TIME_ZONE,
      });
    },
    noteCommitted(tenant_id: string, terminal_id: string): void {
      committed.add(keyOf(tenant_id, terminal_id));
    },
  };
}
