/**
 * RT-17 slice 3 part 3 — shared fixture for the shift cash-up service, status
 * and calculator tests: a service composed over the real repository on the
 * full migration stack (sql.js), with a mutable flag, session and clock, and
 * seeders for the cash-up's sources (finalized sales, refund payouts) and for
 * drawer activity still in flight (settled payments not finalized yet) on any
 * terminal.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  handleFor,
  seedSale,
} from '../../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { composeShiftCashupService, type ShiftCashupSession } from '../../compose-shift-cashup.js';
import type { ShiftCashupService } from '../../shift-cashup-service.js';
import type { ShiftScope } from '../../shift-cashup-repo.js';
import { SCOPE, USER } from './shift-sync-fixture.js';

export const OPENED_AT = '2026-10-05T08:00:00.000Z';
export const CLOSED_AT = '2026-10-05T16:00:00.000Z';
export const MANAGER = '0190f5a2-3b4c-7d8e-9f01-23456789abce';

/** One millisecond before / after an instant. */
export function msBefore(iso: string): string {
  return new Date(Date.parse(iso) - 1).toISOString();
}
export function msAfter(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString();
}

export function cashierSession(scope: ShiftScope = SCOPE): ShiftCashupSession {
  return {
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    terminal_id: scope.terminalId,
    user_id: USER,
  };
}

export interface ServiceHarness {
  service: ShiftCashupService;
  /** Mutable inputs the service reads on every call. */
  state: {
    enabled: boolean;
    session: ShiftCashupSession | null;
    locked: boolean;
    pairedScope: ShiftScope | null;
    clock: string;
  };
}

/** The service over `db`, flag ON, a cashier signed in on `SCOPE`, clock at `OPENED_AT`. */
export function serviceHarness(db: SqlJsDatabase): ServiceHarness {
  const state: ServiceHarness['state'] = {
    enabled: true,
    session: cashierSession(),
    locked: false,
    pairedScope: SCOPE,
    clock: OPENED_AT,
  };
  let ids = 0;
  const service = composeShiftCashupService({
    db: handleFor(db),
    isEnabled: () => state.enabled,
    getSession: () => state.session,
    isSessionLocked: () => state.locked,
    pairedScope: () => Promise.resolve(state.pairedScope),
    now: () => state.clock,
    newId: () => {
      ids += 1;
      return `0192f5a2-3b4c-7d8e-9f01-${ids.toString(16).padStart(12, '0')}`;
    },
  });
  return { service, state };
}

/** One cash tender line: `applied` handed over, `change` given back. */
export function cashLine(applied: number, change = 0): Record<string, unknown> {
  return { tender_type: 'cash', amount_applied_minor: applied, change_due_minor: change };
}

export function cardLine(applied: number): Record<string, unknown> {
  return { tender_type: 'external_card_terminal', amount_applied_minor: applied };
}

export interface SeedShiftSaleInput {
  saleId: string;
  finalizedAt: string;
  lines: ReadonlyArray<Record<string, unknown>>;
  scope?: ShiftScope;
}

/** A finalized sale with its frozen tender summary. */
export function seedShiftSale(db: SqlJsDatabase, input: SeedShiftSaleInput): void {
  const scope = input.scope ?? SCOPE;
  seedSale(db, {
    sale_id: input.saleId,
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    terminal_id: scope.terminalId,
    finalized_at: input.finalizedAt,
    tender_lines_summary_json: JSON.stringify(input.lines),
  });
}

export interface SeedRefundInput {
  returnId: string;
  returnRef: string;
  amountMinor: number;
  paidAt: string | null;
  scope?: ShiftScope;
  currencyCode?: string;
}

const SERVER_SALE_REF = '0192f5a2-3b4c-7d8e-9f01-5a1e00000001';

/**
 * A confirmed return of a seeded sale, with its payout started and — unless
 * `paidAt` is null — completed (`manual`) and the journal `paid_out`, as the
 * RT-15 payout writes them.
 */
export function seedRefund(db: SqlJsDatabase, input: SeedRefundInput): void {
  const scope = input.scope ?? SCOPE;
  const saleId = `sale-of-${input.returnId}`;
  seedShiftSale(db, { saleId, finalizedAt: '2026-10-01T10:00:00.000Z', lines: [], scope });
  const at = '2026-10-05T07:00:00.000Z';
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id, currency_code,
       quoted_total_minor, request_body_json, state, return_ref, return_total_minor, confirmed_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'op-1', 'sess-1', ?, ?, '{}', 'confirmed', ?, ?, ?, ?, ?)`,
    [
      input.returnId,
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      saleId,
      `SN-${saleId}`,
      SERVER_SALE_REF,
      `pos-pulse-return:${input.returnRef}`,
      input.currencyCode ?? 'EGP',
      input.amountMinor,
      input.returnRef,
      input.amountMinor,
      at,
      at,
      at,
    ],
  );
  db.run(
    `INSERT INTO return_payouts (return_id, started_operator_id, started_session_id, started_at)
     VALUES (?, 'op-1', 'sess-1', ?)`,
    [input.returnId, at],
  );
  if (input.paidAt === null) return;
  db.run(
    `UPDATE return_payouts SET paid_operator_id = 'op-1', paid_operator_name = 'Op',
       paid_session_id = 'sess-1', paid_at = ?, method = 'manual' WHERE return_id = ?`,
    [input.paidAt, input.returnId],
  );
  db.run(`UPDATE return_journal SET state = 'paid_out', paid_out_at = ? WHERE return_id = ?`, [
    input.paidAt,
    input.returnId,
  ]);
}

/**
 * A `payment.settled` audit on `scope`'s terminal, as 006 writes it, for the
 * sale `saleId` would finalize (`seedSale`'s default `handoff-<saleId>`): a
 * settlement the finalize listener has not turned into a sale until that sale
 * is seeded.
 */
export function seedSettlement(
  db: SqlJsDatabase,
  input: { saleId: string; scope?: ShiftScope },
): void {
  const scope = input.scope ?? SCOPE;
  const handoff = `handoff-${input.saleId}`;
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, action_category, created_at, payload)
     VALUES (?, ?, ?, ?, 'op-1', 'sess-1', 'payment.settled', ?, ?)`,
    [
      `evt-${handoff}`,
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      OPENED_AT,
      JSON.stringify({ handoff_action_id: handoff }),
    ],
  );
}

/** How many rows of each cash-up table exist. */
export function factCounts(db: SqlJsDatabase): Record<string, unknown> {
  const tables = [
    'shift_cashup_opens',
    'shift_cashup_movements',
    'shift_cashup_closes',
    'shift_sync_outbox',
  ];
  return Object.fromEntries(
    tables.map((table) => [table, db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]]),
  );
}

/** The stored outbox body of `seq`, parsed. */
export function storedBody(db: SqlJsDatabase, seq: number): Record<string, unknown> {
  const raw = db.exec(`SELECT request_body FROM shift_sync_outbox WHERE seq = ${String(seq)}`)[0]
    ?.values[0]?.[0];
  if (typeof raw !== 'string') throw new Error(`fixture: no outbox row ${String(seq)}`);
  return JSON.parse(raw) as Record<string, unknown>;
}
