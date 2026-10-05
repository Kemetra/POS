/**
 * RT-224 step 2 (Option B; coordinator decision P3, no migration) — the cashier
 * `users.id` of each queued sale, for Backend-Core's device-path `captureSale`
 * (`operatorUserId`).
 *
 * Source: the sale's own `payment.settled` audit payload. payments-confirm writes
 * `selling_user_id` there at confirm time, only for the admitted cashier who
 * started the attempt (`payments-confirm.ts`). `audit_events` is append-only
 * (0004: UPDATE and DELETE abort), so the value is immutable provenance — the
 * same row 008's finalize already treats as the authority for the sale's
 * attribution (`finalize-dispatch.ts`). It is NEVER derived from whoever is
 * signed in at send time.
 *
 * Lookup: `action_category = 'payment.settled'`, the sale's tenant / branch, the
 * DRAIN's terminal (RT-221) and the sale's `envelope_handoff_action_id` (UNIQUE
 * on `sales`, so it names one sale). Exactly one row must match, and it must also
 * carry the sale's `payment_attempt_id` and selling operator; otherwise it is
 * not provably this sale's payload.
 *
 *   one matching row with a UUID `selling_user_id` → that id (device path)
 *   one matching row without the key               → null, silently (a
 *       manager/admin sale or one finalized before RT-224: envelope path)
 *   anything else                                  → null (envelope path) and
 *       `onUnresolved` ONCE per sale: no_settled_event | multiple_settled_events
 *       | settled_event_mismatch | malformed_selling_user_id | terminal_mismatch
 *
 * The report carries the opaque local `saleId` and the closed-set reason only —
 * never the user id (P7).
 *
 * Cost (Codex P2 on #547). `audit_events` has no index on the category or the
 * payload (0004 indexes only `(event_id, tenant_id)`) and none is added (a
 * migration is [GATED]). No existing per-sale column can carry the id either:
 * `sales` is append-only with fixed columns, `sale_sync_outbox` /
 * `sale_sync_state` have no payload column. So the lookup is BATCHED and
 * MEMOIZED instead of per sale:
 *   • `resolve(sales)` looks up every sale not seen before in ONE single-pass
 *     query (a full scan of `audit_events`, `json_extract` only on the in-scope
 *     `payment.settled` rows), chunked at {@link LOOKUP_CHUNK} sales;
 *   • each outcome is memoized per `sale_id` — immutable, since the settled row is
 *     written before its sale is finalized and the table is append-only — until
 *     `forget(saleId)` once the sale leaves the queue (synced / dead-lettered).
 * So a tick costs at most one scan, and only when it holds a sale not seen
 * before (a new sale, or the whole queue once after a restart); a retried sale
 * or a sale waiting for an envelope is never looked up again. The residual cost
 * is one O(audit rows) scan per batch of new sales on the main thread.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';

export type SellingUserUnresolvedReason =
  | 'no_settled_event'
  | 'multiple_settled_events'
  | 'settled_event_mismatch'
  | 'malformed_selling_user_id'
  | 'terminal_mismatch';

export interface SellingUserUnresolved {
  saleId: string;
  reason: SellingUserUnresolvedReason;
}

export interface SellingUserIdResolverDeps {
  db: DatabaseHandle;
  /** Told once per sale when its id cannot be proven (closed-set reason, no PII). */
  onUnresolved?: (info: SellingUserUnresolved) => void;
}

export interface SellingUserIdResolver {
  /**
   * The `users.id` of each listed sale, keyed by `sale_id` (null = envelope
   * path). The sales not seen before are looked up in one single-pass query.
   */
  resolve(sales: readonly SaleRow[], terminalId: string): ReadonlyMap<string, string | null>;
  /** Drop a sale that left the queue (synced or dead-lettered). */
  forget(saleId: string): void;
}

/** Sales per lookup query (bounded bind-parameter count). */
export const LOOKUP_CHUNK = 500;

/** Backend-Core's `format: uuid` (8-4-4-4-12 hex, case-insensitive), as the capture client uses. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SettledRow {
  acting_operator_id: string;
  payload: string | null;
  handoff: string;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

type Resolution = { userId: string | null } | { unresolved: SellingUserUnresolvedReason };

/** Exactly one row may describe a sale; 0 or more than 1 is unresolved. */
function countProblem(rows: readonly SettledRow[]): SellingUserUnresolvedReason | null {
  if (rows.length === 0) return 'no_settled_event';
  return rows.length > 1 ? 'multiple_settled_events' : null;
}

/**
 * The row's payload. It matched `json_extract(payload, '$.handoff_action_id') = ?`,
 * which only a JSON object can, so it is a well-formed object here.
 */
function payloadOf(row: SettledRow): Record<string, unknown> {
  return JSON.parse(row.payload ?? '{}') as Record<string, unknown>;
}

/** The single row is THIS sale's: same payment attempt and same selling operator. */
function belongsToSale(sale: SaleRow, row: SettledRow, payload: Record<string, unknown>): boolean {
  const sameAttempt = payload['payment_attempt_id'] === sale.payment_attempt_id;
  const sameOperator = payload['attribution_operator_id'] === sale.selling_operator_id;
  const sameActor = row.acting_operator_id === sale.selling_operator_id;
  return [sameAttempt, sameOperator, sameActor].every(Boolean);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** No key → null (envelope path); a key that is not a UUID → unresolved. */
function sellingUserIdIn(payload: Record<string, unknown>): Resolution {
  if (!('selling_user_id' in payload)) return { userId: null };
  const userId = payload['selling_user_id'];
  return isUuid(userId) ? { userId } : { unresolved: 'malformed_selling_user_id' };
}

/** Judge the matched rows for one sale. Pure. */
function resolve(sale: SaleRow, rows: readonly SettledRow[]): Resolution {
  const problem = countProblem(rows);
  if (problem !== null) return { unresolved: problem };
  const row = rows[0] as SettledRow;
  const payload = payloadOf(row);
  if (!belongsToSale(sale, row, payload)) return { unresolved: 'settled_event_mismatch' };
  return sellingUserIdIn(payload);
}

/** Split `items` into chunks of at most `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createSellingUserIdResolver(
  deps: SellingUserIdResolverDeps,
): SellingUserIdResolver {
  const reported = new Set<string>();
  const known = new Map<string, string | null>();

  function report(saleId: string, reason: SellingUserUnresolvedReason): null {
    if (!reported.has(saleId)) {
      reported.add(saleId);
      deps.onUnresolved?.({ saleId, reason });
    }
    return null;
  }

  /** ONE single-pass query for up to LOOKUP_CHUNK sales of one tenant / branch. */
  function settledRowsByHandoff(
    batch: readonly SaleRow[],
    terminalId: string,
  ): Map<string, SettledRow[]> {
    const first = batch[0] as SaleRow;
    const marks = batch.map(() => '?').join(', ');
    const rows = (
      deps.db.prepare(
        `SELECT acting_operator_id, payload,
                json_extract(payload, '$.handoff_action_id') AS handoff
           FROM audit_events
          WHERE action_category = 'payment.settled'
            AND tenant_id = ? AND branch_id = ? AND originating_terminal_id = ?
            AND json_extract(payload, '$.handoff_action_id') IN (${marks})`,
      ) as PrepareAll<SettledRow>
    ).all(
      first.tenant_id,
      first.branch_id,
      terminalId,
      ...batch.map((sale) => sale.envelope_handoff_action_id),
    );
    const byHandoff = new Map<string, SettledRow[]>();
    for (const row of rows)
      byHandoff.set(row.handoff, [...(byHandoff.get(row.handoff) ?? []), row]);
    return byHandoff;
  }

  /** Look up the unseen sales (grouped by tenant / branch, chunked) and memoize. */
  function lookUp(unseen: readonly SaleRow[], terminalId: string): void {
    const groups = new Map<string, SaleRow[]>();
    for (const sale of unseen) {
      const key = JSON.stringify([sale.tenant_id, sale.branch_id]);
      groups.set(key, [...(groups.get(key) ?? []), sale]);
    }
    for (const batch of [...groups.values()].flatMap((g) => chunks(g, LOOKUP_CHUNK))) {
      const byHandoff = settledRowsByHandoff(batch, terminalId);
      for (const sale of batch) {
        const resolution = resolve(sale, byHandoff.get(sale.envelope_handoff_action_id) ?? []);
        known.set(
          sale.sale_id,
          'unresolved' in resolution
            ? report(sale.sale_id, resolution.unresolved)
            : resolution.userId,
        );
      }
    }
  }

  return {
    resolve(sales, terminalId) {
      // RT-221: only a sale of the drain's own terminal can be attributed here.
      const own = sales.filter((sale) => sale.terminal_id === terminalId);
      for (const sale of sales) {
        if (sale.terminal_id !== terminalId) report(sale.sale_id, 'terminal_mismatch');
      }
      lookUp(
        own.filter((sale) => !known.has(sale.sale_id)),
        terminalId,
      );
      return new Map(sales.map((sale) => [sale.sale_id, known.get(sale.sale_id) ?? null]));
    },
    forget(saleId) {
      known.delete(saleId);
    },
  };
}
