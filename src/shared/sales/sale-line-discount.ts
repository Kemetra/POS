/**
 * RT-856 (RT-699 I3, doc 28 §3.3) — the manual line discount as frozen on the
 * Sale.
 *
 * At finalize each discounted `sales.lines_json` element gains an optional
 * `discount` object, built from the envelope placeholder and its
 * `cart.discount.manager_authorized` audit row. It is a JSON shape in the
 * existing TEXT column: no DDL. The element keeps its gross
 * `line_subtotal_minor`; the net is `line_subtotal_minor − discount.amount_minor`.
 *
 * The receipt reads only `kind`, `value` and `amount_minor`
 * ({@link ReceiptLineDiscount}); the attribution fields stay main-side for the
 * capture (RT-858).
 */
import {
  parseManualDiscountToken,
  formatManualDiscountToken,
  type ManualDiscountKind,
  type ManualDiscountReasonCode,
} from '../cart/manual-discount.js';

/** Who authorised the discount: a consumed cashier approval, or a manager / admin session (D2). */
export type SaleLineDiscountAuthoritySource = 'cashier_approval' | 'manager_session';

export interface SaleLineDiscount {
  readonly kind: ManualDiscountKind;
  /** A whole percent 1–100, or the amount in minor units. */
  readonly value: number;
  /** The discount on the line gross, in minor units. */
  readonly amount_minor: number;
  readonly placeholder_id: string;
  readonly reason_code: ManualDiscountReasonCode;
  readonly authority_source: SaleLineDiscountAuthoritySource;
  /** Only when the audit row recorded it (RT-854 direct path, RT-861 cashier path); never invented. */
  readonly approver_role?: 'manager' | 'admin';
  /** The audit row's `approving_supervisor_id`. */
  readonly approver_operator_id: string;
}

/** The discount fields a receipt may show. No ids, reason or approver cross to the slip. */
export interface ReceiptLineDiscount {
  readonly kind: ManualDiscountKind;
  readonly value: number;
  readonly amount_minor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isKind(kind: unknown): kind is ManualDiscountKind {
  return kind === 'percent' || kind === 'amount';
}

/** A canonical discount: its token parses back to the same kind and value. */
function isCanonical(kind: unknown, value: unknown): kind is ManualDiscountKind {
  if (!isKind(kind) || typeof value !== 'number') return false;
  return parseManualDiscountToken(formatManualDiscountToken({ kind, value }))?.value === value;
}

/**
 * The receipt view of a frozen `discount`, or null when it is not a valid
 * discount: a canonical kind and value, and a safe non-negative amount.
 */
export function readReceiptLineDiscount(value: unknown): ReceiptLineDiscount | null {
  if (!isRecord(value)) return null;
  const { kind, value: magnitude, amount_minor } = value;
  if (!isCanonical(kind, magnitude) || !isSafeAmount(amount_minor)) return null;
  return { kind, value: magnitude as number, amount_minor };
}
