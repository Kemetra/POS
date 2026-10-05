/**
 * RT-224 step 2 (Option B; coordinator decision P3, no migration) — how each
 * queued sale is sent: the device path with its cashier's `users.id` (Backend-Core
 * `operatorUserId`), the operator envelope, or not at all for now (held).
 *
 * Source: the sale's own `payment.settled` audit payload. payments-confirm writes
 * `selling_user_id` there at confirm time, only for the admitted cashier who
 * started the attempt (`payments-confirm.ts`). `audit_events` is append-only
 * (0004: UPDATE and DELETE abort), so the value is immutable provenance — the
 * same row 008's finalize already treats as the authority for the sale's
 * attribution (`finalize-dispatch.ts`). It is NEVER derived from whoever is
 * signed in at send time.
 *
 * The sale's rows: `payment.settled` of the sale's tenant / branch, the DRAIN's
 * terminal (RT-221), its `envelope_handoff_action_id` (UNIQUE on `sales`) AND its
 * `payment_attempt_id` (rev547 F4a — another attempt's row is not this sale's).
 *
 *   exactly one row, the sale's operator, a UUID `selling_user_id` → device
 *   exactly one row, the sale's operator, NO `selling_user_id` key  → envelope,
 *       silently (a manager/admin sale, or one finalized before RT-224)
 *   no row                                                          → envelope
 *       (nothing proves a cashier) + `no_settled_event`
 *   several rows / another operator / a key that is not a UUID     → if any of
 *       the rows carries the key: HELD — a provable cashier sale is never sent
 *       under a manager's envelope (rev547 F4b); otherwise envelope. Reported:
 *       multiple_settled_events | settled_event_mismatch | malformed_selling_user_id
 *   a sale of another terminal than the drain's                     → HELD +
 *       terminal_mismatch
 *
 * Each unresolved sale is reported ONCE through `onUnresolved` with the opaque
 * local `saleId` and the closed-set reason only — never the user id (P7). A held
 * sale stays queued untouched (no attempt, no dead-letter); repair is a support
 * action.
 *
 * Cost (Codex P2 + rev547 F5). `audit_events` has no index on the category or
 * the payload (0004 indexes only `(event_id, tenant_id)`) and none is added (a
 * migration is [GATED]); no existing per-sale column can carry the id either
 * (`sales` is append-only with fixed columns; `sale_sync_outbox` /
 * `sale_sync_state` have no payload column). So:
 *   • `resolve(sales)` looks up EVERY sale not seen before in ONE single-pass
 *     query: the handoffs are bound as one JSON array (`json_each`), and a CTE
 *     extracts each in-scope `payment.settled` row's keys once. Any backlog is one
 *     scan. No LIMIT and no per-tick cap: the cost is the scan itself, not the
 *     number of handoffs, so capping would only multiply the scans.
 *   • each outcome is memoized per `sale_id` (immutable: the settled row exists
 *     before its sale is finalized, and the table is append-only) until
 *     `forget(saleId)` once the sale leaves the queue (synced / dead-lettered).
 * A tick costs at most one scan, and only when it holds a sale not seen before;
 * a retried, waiting or held sale is never looked up again. The residual cost is
 * one O(audit rows) scan per batch of new sales on the main thread.
 *
 * Failure (rev547 F6). A payload that is not valid JSON is skipped by the query
 * (`json_valid`), so one bad row never breaks the lookup. Any other failure of
 * the lookup HOLDS that batch's sales for this call (not memoized — retried on
 * the next tick) and is reported once per episode via `onLookupFailed`. A held
 * sale is never sent on the envelope path.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';

/** How one sale is sent right now. */
export type SaleRoute =
  | { kind: 'device'; operatorUserId: string }
  | { kind: 'envelope' }
  | { kind: 'hold' };

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
  /** Told once per sale when its cashier cannot be proven (closed-set reason, no PII). */
  onUnresolved?: (info: SellingUserUnresolved) => void;
  /** Told once per failure episode when the lookup itself fails. No arguments. */
  onLookupFailed?: () => void;
}

export interface SellingUserIdResolver {
  /**
   * The route of each listed sale, keyed by `sale_id`. The sales not seen before
   * are looked up in one single-pass query.
   */
  resolve(sales: readonly SaleRow[], terminalId: string): ReadonlyMap<string, SaleRoute>;
  /** Drop a sale that left the queue (synced or dead-lettered). */
  forget(saleId: string): void;
}

/** Backend-Core's `format: uuid` (8-4-4-4-12 hex, case-insensitive), as the capture client uses. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENVELOPE: SaleRoute = Object.freeze({ kind: 'envelope' });
const HOLD: SaleRoute = Object.freeze({ kind: 'hold' });

interface SettledRow {
  acting_operator_id: string;
  handoff: string;
  attempt: string | null;
  attribution: string | null;
  /** 1 when the payload has a `selling_user_id` key. */
  has_user: number;
  user_id: unknown;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

type Resolution =
  | { route: SaleRoute }
  | { route: SaleRoute; unresolved: SellingUserUnresolvedReason };

/** HOLD when any row carries the key (a cashier sale), else the envelope. */
function fallback(rows: readonly SettledRow[], reason: SellingUserUnresolvedReason): Resolution {
  return { route: rows.some((r) => r.has_user === 1) ? HOLD : ENVELOPE, unresolved: reason };
}

/** The single row is THIS sale's: same selling operator in the payload and the row. */
function belongsToSale(sale: SaleRow, row: SettledRow): boolean {
  return (
    row.attribution === sale.selling_operator_id &&
    row.acting_operator_id === sale.selling_operator_id
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Judge one sale's own rows. Pure. */
function judge(sale: SaleRow, rows: readonly SettledRow[]): Resolution {
  if (rows.length === 0) return { route: ENVELOPE, unresolved: 'no_settled_event' };
  if (rows.length > 1) return fallback(rows, 'multiple_settled_events');
  const row = rows[0] as SettledRow;
  if (!belongsToSale(sale, row)) return fallback(rows, 'settled_event_mismatch');
  if (row.has_user !== 1) return { route: ENVELOPE };
  return isUuid(row.user_id)
    ? { route: { kind: 'device', operatorUserId: row.user_id } }
    : { route: HOLD, unresolved: 'malformed_selling_user_id' };
}

/**
 * ONE scan: the in-scope `payment.settled` rows whose handoff is in the bound JSON
 * array. `json_valid` guards every extraction (CASE short-circuits), so a
 * malformed payload is skipped instead of failing the statement.
 */
const LOOKUP_SQL = `
  WITH settled AS (
    SELECT acting_operator_id,
           CASE WHEN json_valid(payload) THEN json_extract(payload, '$.handoff_action_id') END AS handoff,
           CASE WHEN json_valid(payload) THEN json_extract(payload, '$.payment_attempt_id') END AS attempt,
           CASE WHEN json_valid(payload) THEN json_extract(payload, '$.attribution_operator_id') END AS attribution,
           CASE WHEN json_valid(payload) THEN json_type(payload, '$.selling_user_id') IS NOT NULL ELSE 0 END AS has_user,
           CASE WHEN json_valid(payload) THEN json_extract(payload, '$.selling_user_id') END AS user_id
      FROM audit_events
     WHERE action_category = 'payment.settled'
       AND tenant_id = ? AND branch_id = ? AND originating_terminal_id = ?
  )
  SELECT acting_operator_id, handoff, attempt, attribution, has_user, user_id
    FROM settled
   WHERE handoff IN (SELECT value FROM json_each(?))`;

export function createSellingUserIdResolver(
  deps: SellingUserIdResolverDeps,
): SellingUserIdResolver {
  const reported = new Set<string>();
  const known = new Map<string, SaleRoute>();
  let lookupFailing = false;

  function report(saleId: string, reason: SellingUserUnresolvedReason): void {
    if (reported.has(saleId)) return;
    reported.add(saleId);
    deps.onUnresolved?.({ saleId, reason });
  }

  function reportLookupFailure(): void {
    if (lookupFailing) return;
    lookupFailing = true;
    try {
      deps.onLookupFailed?.();
    } catch {
      // A failing log sink must not escape the resolver.
    }
  }

  /** The rows of one tenant / branch group, keyed by `handoff|attempt`. */
  function settledRows(group: readonly SaleRow[], terminalId: string): Map<string, SettledRow[]> {
    const first = group[0] as SaleRow;
    const rows = (deps.db.prepare(LOOKUP_SQL) as PrepareAll<SettledRow>).all(
      first.tenant_id,
      first.branch_id,
      terminalId,
      JSON.stringify(group.map((sale) => sale.envelope_handoff_action_id)),
    );
    const byKey = new Map<string, SettledRow[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.handoff, row.attempt]);
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    return byKey;
  }

  /** Look up the unseen sales, one query per tenant / branch (in practice one). */
  function lookUp(unseen: readonly SaleRow[], terminalId: string): void {
    const groups = new Map<string, SaleRow[]>();
    for (const sale of unseen) {
      const key = JSON.stringify([sale.tenant_id, sale.branch_id]);
      groups.set(key, [...(groups.get(key) ?? []), sale]);
    }
    for (const group of groups.values()) {
      const byKey = settledRows(group, terminalId);
      lookupFailing = false;
      for (const sale of group) {
        const own = byKey.get(
          JSON.stringify([sale.envelope_handoff_action_id, sale.payment_attempt_id]),
        );
        const resolution = judge(sale, own ?? []);
        if ('unresolved' in resolution) report(sale.sale_id, resolution.unresolved);
        known.set(sale.sale_id, resolution.route);
      }
    }
  }

  /** rev547 F6: a failing lookup holds this batch (not memoized); the next call retries. */
  function lookUpSafely(unseen: readonly SaleRow[], terminalId: string): void {
    try {
      lookUp(unseen, terminalId);
    } catch {
      reportLookupFailure();
    }
  }

  /** RT-221: only a sale of the drain's own terminal can be attributed here. */
  function routeOf(sale: SaleRow, terminalId: string): SaleRoute {
    if (sale.terminal_id !== terminalId) {
      report(sale.sale_id, 'terminal_mismatch');
      return HOLD;
    }
    return known.get(sale.sale_id) ?? HOLD;
  }

  return {
    resolve(sales, terminalId) {
      const unseen = sales.filter(
        (sale) => sale.terminal_id === terminalId && !known.has(sale.sale_id),
      );
      lookUpSafely(unseen, terminalId);
      return new Map(sales.map((sale) => [sale.sale_id, routeOf(sale, terminalId)]));
    },
    forget(saleId) {
      known.delete(saleId);
    },
  };
}
