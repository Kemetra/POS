/**
 * RT-856 (RT-699 I3, doc 28 §3.3) — freeze each manual line discount onto the
 * Sale's line snapshot at finalize.
 *
 * Sources, both durable (the AD-2 worker runs without a session):
 *   • the frozen envelope placeholder: `placeholder_id`, and the canonical
 *     token (`manual_pct_<P>` / `manual_amt_<M>`) giving `kind` and `value`;
 *   • its `cart.discount.manager_authorized` audit row, scoped as the RT-614
 *     trust check scopes it (tenant, branch, placeholder, cart, line) and
 *     recording the same `amount_minor` main computes on the line gross:
 *     `reason_code`, `approval_id` (present → `cashier_approval`, absent →
 *     `manager_session`), `approver_role` when recorded, and the row's
 *     `approving_supervisor_id` as `approver_operator_id`.
 *
 * A placeholder on a removed line discounts nothing (as `envelopeDiscountTotals`
 * skips it), and a pre-RT-854 non-canonical kind carried no money effect, so
 * neither is frozen.
 *
 * Fail closed. A discount with no matching audit row, an unclosed reason, no
 * approving supervisor, or an unknown role, is `discount_unattributed`; a
 * settled amount that is not Σ gross − Σ discount is `discount_total_mismatch`.
 * RT-614's handoff check makes both unreachable in practice. The dispatch
 * refuses rather than write a discount it cannot attribute, so the settled
 * attempt stays unfinalized and the worker logs it.
 *
 * An undiscounted line is returned as the same object, so an undiscounted
 * sale's `lines_json` is byte-identical to before RT-856.
 */
import type { DatabaseHandle } from '../db/client.js';
import type {
  DiscountPlaceholderSnapshot,
  LineSnapshot,
} from '../../shared/cart/handoff-envelope.js';
import {
  isManualDiscountReasonCode,
  lineDiscountMinor,
  parseManualDiscountToken,
  type ManualDiscount,
} from '../../shared/cart/manual-discount.js';
import type { SaleLineDiscount } from '../../shared/sales/sale-line-discount.js';

/** One `sales.lines_json` element: the envelope line, plus its frozen discount. */
export type SaleLineSnapshot = LineSnapshot & { readonly discount?: SaleLineDiscount };

export type FreezeRefusalReason = 'discount_unattributed' | 'discount_total_mismatch';

export type FreezeLineDiscountsResult =
  | { kind: 'ok'; lines: readonly SaleLineSnapshot[] }
  | { kind: 'refused'; reason: FreezeRefusalReason };

export interface FreezeLineDiscountsInput {
  tenant_id: string;
  branch_id: string;
  cart_id: string;
  lines: readonly LineSnapshot[];
  placeholders: readonly DiscountPlaceholderSnapshot[];
  /** The settled attempt's amount due (`envelope_subtotal_minor`, the net since RT-854). */
  amount_due_minor: number;
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface AuthorizedRow {
  payload: string | null;
  approving_supervisor_id: string | null;
}

const AUTHORIZED_ROW_SQL = `SELECT payload, approving_supervisor_id FROM audit_events
    WHERE tenant_id = ? AND branch_id = ?
      AND action_category = 'cart.discount.manager_authorized'
      AND json_extract(payload, '$.placeholder_id') = ?
      AND json_extract(payload, '$.cart_id') = ?
      AND json_extract(payload, '$.cart_line_id') = ?
      AND json_extract(payload, '$.amount_minor') = ?
    ORDER BY created_at ASC
    LIMIT 1`;

const APPROVER_ROLES: ReadonlySet<unknown> = new Set(['manager', 'admin']);

/** A placeholder this sale's money depends on: on a live line, with a canonical token. */
interface PricedPlaceholder {
  placeholder: DiscountPlaceholderSnapshot;
  discount: ManualDiscount;
  amount_minor: number | null;
}

function priced(
  placeholder: DiscountPlaceholderSnapshot,
  grossByLine: ReadonlyMap<string, number>,
): PricedPlaceholder | null {
  const gross = grossByLine.get(placeholder.line_id);
  const discount = parseManualDiscountToken(placeholder.placeholder_kind);
  if (gross === undefined || discount === null) return null;
  return {
    placeholder,
    discount,
    amount_minor: lineDiscountMinor(gross, placeholder.placeholder_kind),
  };
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

/** What an audit row attributes: its closed reason, approval, role and approver. */
interface Attribution {
  reason_code: SaleLineDiscount['reason_code'];
  authority_source: SaleLineDiscount['authority_source'];
  approver_role: SaleLineDiscount['approver_role'];
  approver_operator_id: string;
}

/** A recorded role is copied only when it is a known one; absent stays absent. */
function isRecordedRole(role: unknown): role is SaleLineDiscount['approver_role'] {
  return role === undefined || APPROVER_ROLES.has(role);
}

/** The row's payload and approver, or null when either is missing. */
function readRow(
  row: AuthorizedRow | undefined,
): { payload: Record<string, unknown>; approver: string } | null {
  const payload = parsePayload(row?.payload ?? null);
  const approver = row?.approving_supervisor_id ?? '';
  return payload === null || approver === '' ? null : { payload, approver };
}

/** The attribution a row gives, or null: no row, no approver, an unclosed reason or an unknown role. */
function attributionOf(row: AuthorizedRow | undefined): Attribution | null {
  const read = readRow(row);
  if (read === null) return null;
  const { reason_code, approval_id, approver_role } = read.payload;
  if (!isManualDiscountReasonCode(reason_code) || !isRecordedRole(approver_role)) return null;
  return {
    reason_code,
    authority_source: typeof approval_id === 'string' ? 'cashier_approval' : 'manager_session',
    approver_role,
    approver_operator_id: read.approver,
  };
}

/** The frozen discount, or null when the row cannot attribute it. */
function attribute(
  row: AuthorizedRow | undefined,
  item: PricedPlaceholder,
  amount: number,
): SaleLineDiscount | null {
  const attribution = attributionOf(row);
  if (attribution === null) return null;
  const { approver_role, ...rest } = attribution;
  return {
    kind: item.discount.kind,
    value: item.discount.value,
    amount_minor: amount,
    placeholder_id: item.placeholder.placeholder_id,
    ...rest,
    // Only when the row recorded it: never invented (RT-861 adds it on the cashier path).
    ...(approver_role === undefined ? {} : { approver_role }),
  };
}

/**
 * The sale's line snapshot with each discount frozen, or a refusal. Prepares
 * the audit query only when a discount is present.
 */
export function freezeLineDiscounts(
  db: DatabaseHandle,
  input: FreezeLineDiscountsInput,
): FreezeLineDiscountsResult {
  const grossByLine = new Map(input.lines.map((line) => [line.line_id, line.line_subtotal_minor]));
  const items = input.placeholders
    .map((placeholder) => priced(placeholder, grossByLine))
    .filter((item): item is PricedPlaceholder => item !== null);
  if (items.length === 0) return { kind: 'ok', lines: input.lines };

  const stmt = db.prepare(AUTHORIZED_ROW_SQL) as PrepareGet<AuthorizedRow>;
  const byLine = new Map<string, SaleLineDiscount>();
  for (const item of items) {
    const { placeholder, amount_minor } = item;
    // One manual discount per line (OD-28-6); a second one is not the settled sale.
    if (amount_minor === null || byLine.has(placeholder.line_id)) {
      return { kind: 'refused', reason: 'discount_unattributed' };
    }
    const row = stmt.get(
      input.tenant_id,
      input.branch_id,
      placeholder.placeholder_id,
      input.cart_id,
      placeholder.line_id,
      amount_minor,
    );
    const discount = attribute(row, item, amount_minor);
    if (discount === null) return { kind: 'refused', reason: 'discount_unattributed' };
    byLine.set(placeholder.line_id, discount);
  }

  const gross = input.lines.reduce((sum, line) => sum + line.line_subtotal_minor, 0);
  const discounted = [...byLine.values()].reduce((sum, d) => sum + d.amount_minor, 0);
  if (gross - discounted !== input.amount_due_minor) {
    return { kind: 'refused', reason: 'discount_total_mismatch' };
  }
  return {
    kind: 'ok',
    lines: input.lines.map((line) => {
      const discount = byLine.get(line.line_id);
      return discount === undefined ? line : { ...line, discount };
    }),
  };
}
