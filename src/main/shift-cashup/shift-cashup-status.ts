/**
 * RT-17 slice 3 part 3 — the read-only shift cash-up status (for the slice 4
 * UI and support):
 *
 *   • `openShift` — the current pairing's open shift with its float and
 *     movement totals. Never the expected cash: the cashier's count is blind
 *     (10920 decision 2).
 *   • `queue` — the current terminal's UNSETTLED outbox rows (pending or
 *     dead-lettered; synced and superseded rows are history), by row state:
 *       pending          a device-path row due now;
 *       waiting          a device-path row in backoff (`next_retry_at` > now);
 *       blocked          a dead-lettered row — the drain stops at it, so every
 *                        row behind it waits too (part 1, decision 1);
 *       envelopePending  a manager-envelope repair, waiting for the envelope
 *                        client (a later part of RT-17).
 *   • `stranded` — carried item (b): unsettled facts and open shifts OUTSIDE
 *     the current pairing's scope (tenant, branch, terminal): those of an
 *     earlier pairing after a re-pair, or every one while unpaired. The drain
 *     never sends them (RT-221: no replay under a new device identity); the
 *     count makes them visible for a support action.
 *   • `pendingDrawerActivity` — review P2-2: the current pairing's drawer
 *     cash still in flight (refund payouts started, not completed; settled
 *     payments not finalized into a sale yet; see `shift-cashup-sources.ts`).
 *     While either is non-zero the service refuses an open, the close and
 *     every pay-out (`drawer_activity_pending`); slice 4 shows why. Zero
 *     while unpaired.
 *
 * Instants are compared as instants, never as strings. Counts only: no body,
 * id or user id leaves this module.
 */
import type { DatabaseHandle } from '../db/client.js';
import { createShiftCashupRepo, type OpenShiftView, type ShiftScope } from './shift-cashup-repo.js';
import { createShiftCashupSources, type PendingDrawerActivity } from './shift-cashup-sources.js';

export interface ShiftQueueCounts {
  pending: number;
  waiting: number;
  blocked: number;
  envelopePending: number;
}

export interface ShiftStrandedCounts {
  unsyncedFacts: number;
  openShifts: number;
}

export interface ShiftCashupStatus {
  openShift: OpenShiftView | null;
  queue: ShiftQueueCounts;
  stranded: ShiftStrandedCounts;
  pendingDrawerActivity: PendingDrawerActivity;
}

export interface ShiftStatusQuery {
  /** The current pairing's scope; null while unpaired. */
  scope: ShiftScope | null;
  /** A canonical ISO instant. */
  now: string;
}

export interface ShiftCashupStatusReader {
  read(query: ShiftStatusQuery): ShiftCashupStatus;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}
/** A `COUNT(*)` always yields its one row. */
interface PrepareCount {
  get(...params: unknown[]): { n: number };
}

interface UnsettledRow {
  authPath: 'device' | 'envelope';
  syncStatus: 'pending' | 'dead_letter';
  nextRetryAt: string | null;
  inScope: 0 | 1;
}

/**
 * The row of `alias` is in the current pairing's scope. `IS`, so a null
 * (unpaired) scope matches no row: every row is then outside it.
 */
function inScope(alias: string): string {
  return `(${alias}.tenant_id IS ? AND ${alias}.branch_id IS ? AND ${alias}.terminal_id IS ?)`;
}

const UNSETTLED_SQL = `
  SELECT o.auth_path AS authPath, s.sync_status AS syncStatus, s.next_retry_at AS nextRetryAt,
         ${inScope('o')} AS inScope
  FROM shift_sync_state s CROSS JOIN shift_sync_outbox o ON o.seq = s.seq
  WHERE s.sync_status IN ('pending', 'dead_letter')`;

const FOREIGN_OPEN_SHIFTS_SQL = `
  SELECT COUNT(*) AS n FROM shift_cashup_opens o
  WHERE NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = o.shift_id)
    AND NOT ${inScope('o')}`;

const NO_DRAWER_ACTIVITY: PendingDrawerActivity = Object.freeze({
  refundPayouts: 0,
  unfinalizedSales: 0,
});

type QueueBucket = keyof ShiftQueueCounts;

function bucketOf(row: UnsettledRow, nowMs: number): QueueBucket {
  if (row.syncStatus === 'dead_letter') return 'blocked';
  if (row.authPath === 'envelope') return 'envelopePending';
  const retryMs = row.nextRetryAt === null ? Number.NaN : Date.parse(row.nextRetryAt);
  return retryMs > nowMs ? 'waiting' : 'pending';
}

function countQueue(rows: readonly UnsettledRow[], now: string): ShiftQueueCounts {
  const counts: ShiftQueueCounts = { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 };
  const nowMs = Date.parse(now);
  for (const row of rows) counts[bucketOf(row, nowMs)] += 1;
  return counts;
}

export function createShiftCashupStatusReader(db: DatabaseHandle): ShiftCashupStatusReader {
  const repo = createShiftCashupRepo(db);
  const sources = createShiftCashupSources(db);

  function scopeParams(scope: ShiftScope | null): (string | null)[] {
    return [scope?.tenantId ?? null, scope?.branchId ?? null, scope?.terminalId ?? null];
  }

  return {
    read({ scope, now }) {
      const params = scopeParams(scope);
      const rows = (db.prepare(UNSETTLED_SQL) as PrepareAll<UnsettledRow>).all(...params);
      const foreignOpen = (db.prepare(FOREIGN_OPEN_SHIFTS_SQL) as PrepareCount).get(...params);
      return {
        openShift: scope === null ? null : repo.findOpenShift(scope),
        queue: countQueue(
          rows.filter((row) => row.inScope === 1),
          now,
        ),
        stranded: {
          unsyncedFacts: rows.filter((row) => row.inScope !== 1).length,
          openShifts: foreignOpen.n,
        },
        pendingDrawerActivity:
          scope === null ? NO_DRAWER_ACTIVITY : sources.pendingDrawerActivity(scope),
      };
    },
  };
}
