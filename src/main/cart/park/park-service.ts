/**
 * RT-440 (PK-2, spec 024 §3.1–§3.3) — `cart.park`, `cart.listParked` and
 * `cart.previewResume`. `cart.resume` is `resume-flow.ts`.
 *
 * Ownership is the RT-116 §3.1 owner key for every role (K3): a manager or
 * admin never lists, previews or resumes another operator's parked sale here;
 * that is manager recovery (RT-441). Only `park` also requires the cart to be
 * the current session's (`operator_session_id`, the M4 check).
 */
import {
  PARK_LIMIT_PER_TERMINAL,
  type CartListParkedResponse,
  type CartParkRefusal,
  type CartParkRequest,
  type CartParkResponse,
  type CartPreviewResumeRequest,
  type CartPreviewResumeResponse,
  type ParkedSaleView,
} from '../../../shared/cart/park-types.js';
import type { CartParkRefusedPayload } from '../../../shared/audit/payload-schemas.js';
import {
  admit,
  emitAudit,
  inTransaction,
  isOwnCart,
  nowOf,
  ParkRefused,
  refused,
  replayOf,
  type Admitted,
  type ParkResumeDeps,
} from './park-context.js';
import { hashRequest, isStale, normalizeLabel } from './park-rules.js';
import type { ParkCartRow } from './park-store.js';
import { computeResumeDiff, type ResumeDiffResult } from './resume-diff.js';

type AuditedRefusal = CartParkRefusedPayload['reason'];

/** K2: why this cart cannot be parked by this session, or null. */
export function parkRefusal(
  deps: ParkResumeDeps,
  cart: ParkCartRow | undefined,
  at: Admitted,
): AuditedRefusal | null {
  if (cart === undefined || !isOwnCart(cart, at)) return 'wrong_owner';
  if (cart.operator_session_id !== at.session.id) return 'wrong_owner';
  if (cart.state !== 'editing' || cart.parked_at !== null) return 'not_parkable';
  if (deps.store.activeLineCount(cart.cart_id) === 0) return 'not_parkable';
  return deps.store.hasOpenPayment(cart.cart_id) ? 'not_parkable' : null;
}

/** K2: room for `adding` more parked sales once `leaving` have left. */
export function hasRoom(deps: ParkResumeDeps, at: Admitted, adding: number, leaving = 0): boolean {
  const scope = {
    tenant_id: at.session.tenant_id,
    branch_id: at.session.branch_id,
    terminal_id: at.terminal_id,
  };
  return deps.store.countParked(scope) - leaving + adding <= PARK_LIMIT_PER_TERMINAL;
}

/** Mark one cart parked and audit it; throws to roll back if it moved. */
export function parkOne(
  deps: ParkResumeDeps,
  input: { at: Admitted; cart_id: string; label: string | null; key: string; when: string },
): void {
  const { at, cart_id, label, key, when } = input;
  const lines = deps.store.activeLineCount(cart_id);
  const marked = deps.store.markParked({
    cart_id,
    operator_session_id: at.session.id,
    label,
    key,
    at: when,
  });
  if (!marked) throw new ParkRefused('not_parkable');
  const total = deps.store.getCart(cart_id)?.cart_subtotal_minor ?? 0;
  emitAudit(deps, {
    at,
    category: 'cart.parked',
    payload: { cart_id, line_count: lines, total_minor: total, has_label: label !== null },
    when,
  });
}

function refuseAudited(
  deps: ParkResumeDeps,
  at: Admitted,
  reason: AuditedRefusal,
): CartParkRefusal {
  emitAudit(deps, {
    at,
    category: 'cart.park_refused',
    payload: { reason },
    when: nowOf(deps).toISOString(),
  });
  return refused(reason);
}

export function park(deps: ParkResumeDeps, req: CartParkRequest): CartParkResponse {
  const at = admit(deps);
  if ('kind' in at) return at;
  const label = normalizeLabel(req.label);
  const hash = hashRequest({
    cart_id: req.cart_id,
    label: label.ok ? label.label : (req.label ?? null),
  });
  const replay = replayOf(
    deps,
    { at, key: req.idempotency_key, kind: 'cart.park', hash },
    (json) => JSON.parse(json) as CartParkResponse,
  );
  if (replay !== null) return replay;
  if (!label.ok) return refuseAudited(deps, at, 'invalid_label');
  const why = parkRefusal(deps, deps.store.getCart(req.cart_id), at);
  if (why !== null) return refuseAudited(deps, at, why);
  if (!hasRoom(deps, at, 1)) return refuseAudited(deps, at, 'park_limit_reached');
  const when = nowOf(deps).toISOString();
  const outcome: CartParkResponse = { kind: 'parked' };
  return inTransaction(deps, () => {
    parkOne(deps, {
      at,
      cart_id: req.cart_id,
      label: label.label,
      key: req.idempotency_key,
      when,
    });
    deps.store.recordAction({
      idempotency_key: req.idempotency_key,
      cart_id: req.cart_id,
      action_kind: 'cart.park',
      request_hash: hash,
      outcome_json: JSON.stringify(outcome),
      applied_at: when,
    });
    return outcome;
  });
}

export function listParked(deps: ParkResumeDeps): CartListParkedResponse {
  const at = admit(deps);
  if ('kind' in at) return at;
  const now = nowOf(deps);
  const items: ParkedSaleView[] = deps.store
    .listParked({
      tenant_id: at.session.tenant_id,
      branch_id: at.session.branch_id,
      terminal_id: at.terminal_id,
      owning_operator_id: at.session.operator_id,
    })
    .map((row) => ({
      cart_id: row.cart_id,
      label: row.park_label,
      line_count: row.line_count,
      total_minor: row.cart_subtotal_minor,
      parked_at: row.parked_at,
      stale: isStale(row.parked_at, now),
    }));
  return { kind: 'parked_sales', items };
}

/** The owner's parked cart, or the refusal (§3.3 / §3.4). */
export function ownParkedCart(
  deps: ParkResumeDeps,
  at: Admitted,
  cart_id: string,
): ParkCartRow | CartParkRefusal {
  const cart = deps.store.getCart(cart_id);
  if (cart === undefined) return refused('not_parked');
  if (!isOwnCart(cart, at)) return refused('wrong_owner');
  if (cart.state !== 'editing' || cart.parked_at === null) return refused('not_parked');
  return cart;
}

export function diffFor(deps: ParkResumeDeps, at: Admitted, cart_id: string): ResumeDiffResult {
  return computeResumeDiff(at.session.tenant_id, deps.store.parkedLines(cart_id), deps.prices);
}

export function previewResume(
  deps: ParkResumeDeps,
  req: CartPreviewResumeRequest,
): CartPreviewResumeResponse {
  const at = admit(deps);
  if ('kind' in at) return at;
  const cart = ownParkedCart(deps, at, req.cart_id);
  if ('kind' in cart) return cart;
  const result = diffFor(deps, at, cart.cart_id);
  if (result.kind === 'catalogue_unavailable') return refused('catalogue_unavailable');
  const { changes, unavailable, diff_token } = result.diff;
  return {
    kind: 'preview',
    changes: changes.map(({ line_id, old_unit_minor, new_unit_minor }) => ({
      line_id,
      old_unit_minor,
      new_unit_minor,
    })),
    unavailable,
    diff_token,
  };
}
