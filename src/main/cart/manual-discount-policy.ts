/**
 * RT-854 (RT-699 I1; doc 28 §3, §4, §7) — main's rules for a manual line
 * discount, kept out of `cart-bridge.ts`:
 *
 * - `resolveDiscountAdd`: the add's token and reason, checked before any
 *   write. A non-canonical token, an amount above the line gross, an unsafe
 *   intermediate, or a reason outside the closed list is `invalid_payload`. A
 *   manager / admin add must carry the reason (§4.2); a cashier's add may
 *   restate the approval's (§4.1 step 5). A line that already holds a discount
 *   is `discount_already_applied` (OD-28-6).
 * - `lineHasDiscount`: the quantity of a discounted line is frozen
 *   (`line_discounted`, OD-28-7).
 * - `isSameDiscountAddReplay`: the token and the reason are part of the
 *   add's replay identity, read from the outbox row so a removed placeholder
 *   does not widen it.
 * - the outbox and audit payloads. The audit keys stay inside Backend-Core's
 *   closed `cart.discount.manager_authorized` set (RT-740 DEP-2).
 */
import type { CartDiscountPlaceholdersAddRequest } from '../../shared/cart/bridge-types.js';
import type { CartRefusalReason } from '../../shared/cart/refusal.js';
import {
  computeManualDiscount,
  isManualDiscountReasonCode,
  parseManualDiscountToken,
  type ManualDiscount,
  type ManualDiscountReasonCode,
} from '../../shared/cart/manual-discount.js';
import type { CartDiscountManagerAuthorizedPayload } from '../../shared/audit/payload-schemas.js';
import type { CartLineRow, CartStore, DiscountPlaceholderRow, OutboxRow } from './cart-store.js';

/** The audit payload as RT-854 writes it: the value fields are always present. */
export type DiscountAuditPayload = CartDiscountManagerAuthorizedPayload &
  Required<Pick<CartDiscountManagerAuthorizedPayload, 'kind' | 'value' | 'amount_minor'>>;

/** The add as main will apply it: the parsed value and the amount on the line gross. */
export interface ResolvedDiscountAdd {
  readonly discount: ManualDiscount;
  readonly amountMinor: number;
  /** The reason the request carries (required on the direct path). */
  readonly reasonCode: ManualDiscountReasonCode | undefined;
}

export function lineHasDiscount(
  store: Pick<CartStore, 'getDiscountPlaceholdersForCart'>,
  cartId: string,
  lineId: string,
): boolean {
  return store.getDiscountPlaceholdersForCart(cartId).some((p) => p.line_id === lineId);
}

/** The request's reason: absent, or a code from the closed list; anything else is null. */
function requestReason(
  req: CartDiscountPlaceholdersAddRequest,
  required: boolean,
): { code: ManualDiscountReasonCode | undefined } | null {
  const raw: unknown = req.reason_code;
  if (raw === undefined) return required ? null : { code: undefined };
  return isManualDiscountReasonCode(raw) ? { code: raw } : null;
}

/** The parsed token and its amount on the line's gross, or null when refused. */
function valueOnLine(
  token: string,
  line: CartLineRow,
): { discount: ManualDiscount; amountMinor: number } | null {
  const discount = parseManualDiscountToken(token);
  if (discount === null) return null;
  const result = computeManualDiscount(line.line_subtotal_minor, discount);
  return result === null ? null : { discount, amountMinor: result.amount_minor };
}

/**
 * The add's value and reason, or why it is refused. The line is a live line of
 * the cart (the caller checks that first).
 */
export function resolveDiscountAdd(input: {
  store: Pick<CartStore, 'getDiscountPlaceholdersForCart'>;
  req: CartDiscountPlaceholdersAddRequest;
  line: CartLineRow;
  isManager: boolean;
}): ResolvedDiscountAdd | { refusal: CartRefusalReason } {
  const { store, req, line, isManager } = input;
  const reason = requestReason(req, isManager);
  const value = valueOnLine(req.placeholder_kind, line);
  if (reason === null || value === null) return { refusal: 'invalid_payload' };
  if (lineHasDiscount(store, req.cart_id, req.line_id)) {
    return { refusal: 'discount_already_applied' };
  }
  return { ...value, reasonCode: reason.code };
}

function parsedPayload(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A key already used is an exact replay only when it was this add: the same
 * cart, line and token, and the same reason. Only a cashier's retry may omit
 * the reason (its approval carries it); a manager / admin retry must state it,
 * as the direct path requires (§4.2). A row written before RT-854 has no token
 * in its payload; the placeholder (while it exists) stands in for it, as it
 * did under RT-608.
 */
export function isSameDiscountAddReplay(
  replay: OutboxRow,
  placeholder: DiscountPlaceholderRow | undefined,
  req: CartDiscountPlaceholdersAddRequest,
  isManager: boolean,
): boolean {
  if (replay.action_kind !== 'cart.discount_placeholder.add') return false;
  if (replay.cart_id !== req.cart_id || replay.line_id !== req.line_id) return false;
  const payload = parsedPayload(replay.payload_json) ?? {};
  const token = payload['placeholder_kind'] ?? placeholder?.placeholder_kind;
  if (token !== undefined && token !== req.placeholder_kind) return false;
  if (req.reason_code === undefined) return !isManager;
  return payload['reason_code'] === req.reason_code;
}

/** The add's outbox payload: ids, the token and the resolved reason. No amount, no approver. */
export function discountOutboxPayload(
  req: CartDiscountPlaceholdersAddRequest,
  reasonCode: ManualDiscountReasonCode | undefined,
): Record<string, unknown> {
  return {
    cart_id: req.cart_id,
    cart_line_id: req.line_id,
    placeholder_kind: req.placeholder_kind,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
  };
}

/**
 * The `cart.discount.manager_authorized` payload (doc 28 §7): ids, the
 * approval (cashier path), the reason, the value and the computed amount, and
 * the approver's role when main has a durable source for it — the session's
 * own role on the direct path. A cashier approval's approver role has none
 * today (`manager_approvals` and `manager_pin_records` hold no role), so it is
 * omitted rather than guessed.
 */
export function discountAuditPayload(input: {
  req: CartDiscountPlaceholdersAddRequest;
  resolved: ResolvedDiscountAdd;
  approvalId: string | undefined;
  reasonCode: ManualDiscountReasonCode | undefined;
  approverRole: 'manager' | 'admin' | undefined;
}): DiscountAuditPayload {
  const { req, resolved, approvalId, reasonCode, approverRole } = input;
  return {
    cart_id: req.cart_id,
    cart_line_id: req.line_id,
    placeholder_id: req.idempotency_key,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
    kind: resolved.discount.kind,
    value: resolved.discount.value,
    amount_minor: resolved.amountMinor,
    ...(approverRole === undefined ? {} : { approver_role: approverRole }),
  };
}
