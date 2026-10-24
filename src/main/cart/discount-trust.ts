/**
 * RT-614 (RT-608 item 6, option B; spec 005 FR-023, handoff-envelope steps
 * 3a / 3b) — the runtime trust check for manual-discount placeholders.
 *
 * A placeholder is trusted only when a `cart.discount.manager_authorized`
 * audit row names it: the same `placeholder_id`, cart and line, in the same
 * tenant and branch. RT-608's add writes that row in the add's own
 * transaction, and `audit_events` is append-only, so a placeholder written by
 * any other path (pre-RT-28, a direct insert) has none, whatever its
 * `attribution_operator_id` says. No schema change: the audit row is the
 * provenance marker.
 *
 * RT-854 (doc 28 §3.1, OD-28-7): when the caller passes the amount the
 * placeholder gives on its line now, the audit row must have recorded that
 * same `amount_minor`. A line whose gross moved since the approval (an
 * accepted resume price change) no longer matches, so the discount must be
 * removed and authorised again: the approved amount stays the applied one.
 */
import type { DatabaseHandle } from '../db/client.js';

/** The placeholder as the trust check sees it, scoped to its cart. */
export interface DiscountPlaceholderRef {
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly cart_id: string;
  readonly line_id: string;
  readonly placeholder_id: string;
  /** RT-854: the discount amount on the line as it stands; omitted, the amount is not checked. */
  readonly amount_minor?: number;
}

export type IsDiscountPlaceholderTrusted = (ref: DiscountPlaceholderRef) => boolean;

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

const MANAGER_AUTHORIZED_SQL = `SELECT 1 AS ok FROM audit_events
    WHERE tenant_id = ? AND branch_id = ?
      AND action_category = 'cart.discount.manager_authorized'
      AND json_extract(payload, '$.placeholder_id') = ?
      AND json_extract(payload, '$.cart_id') = ?
      AND json_extract(payload, '$.cart_line_id') = ?
      AND (? IS NULL OR json_extract(payload, '$.amount_minor') = ?)
    LIMIT 1`;

/**
 * The predicate over `audit_events`. Prepared lazily, on the first
 * placeholder checked, so a cart with no placeholders never touches the table.
 */
export function bindDiscountPlaceholderTrust(db: DatabaseHandle): IsDiscountPlaceholderTrusted {
  let stmt: PrepareGet<{ ok: number }> | null = null;
  return (ref) => {
    stmt ??= db.prepare(MANAGER_AUTHORIZED_SQL) as PrepareGet<{ ok: number }>;
    const amount = ref.amount_minor ?? null;
    return (
      stmt.get(
        ref.tenant_id,
        ref.branch_id,
        ref.placeholder_id,
        ref.cart_id,
        ref.line_id,
        amount,
        amount,
      ) !== undefined
    );
  };
}
