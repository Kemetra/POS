/**
 * RT-224 step 2 (Option B; coordinator decision P3, no migration) — the cashier
 * `users.id` of ONE queued sale, for Backend-Core's device-path `captureSale`
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
 * never the user id (P7). No index is added (no migration): the scan is bounded
 * by `action_category` and only runs for a sale the drain is about to route.
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

export interface SellingUserIdReaderDeps {
  db: DatabaseHandle;
  /** Told once per sale when its id cannot be proven (closed-set reason, no PII). */
  onUnresolved?: (info: SellingUserUnresolved) => void;
}

/** `(sale, drainTerminalId) → users.id | null`. */
export type SellingUserIdReader = (sale: SaleRow, terminalId: string) => string | null;

/** Backend-Core's `format: uuid` (8-4-4-4-12 hex, case-insensitive), as the capture client uses. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SettledRow {
  acting_operator_id: string;
  payload: string | null;
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

export function createSellingUserIdReader(deps: SellingUserIdReaderDeps): SellingUserIdReader {
  const reported = new Set<string>();

  function report(saleId: string, reason: SellingUserUnresolvedReason): null {
    if (!reported.has(saleId)) {
      reported.add(saleId);
      deps.onUnresolved?.({ saleId, reason });
    }
    return null;
  }

  return (sale, terminalId) => {
    // RT-221: only a sale of the drain's own terminal can be attributed here.
    if (sale.terminal_id !== terminalId) return report(sale.sale_id, 'terminal_mismatch');
    const rows = (
      deps.db.prepare(
        `SELECT acting_operator_id, payload FROM audit_events
          WHERE action_category = 'payment.settled'
            AND tenant_id = ? AND branch_id = ? AND originating_terminal_id = ?
            AND json_extract(payload, '$.handoff_action_id') = ?`,
      ) as PrepareAll<SettledRow>
    ).all(sale.tenant_id, sale.branch_id, terminalId, sale.envelope_handoff_action_id);
    const resolution = resolve(sale, rows);
    return 'unresolved' in resolution
      ? report(sale.sale_id, resolution.unresolved)
      : resolution.userId;
  };
}
