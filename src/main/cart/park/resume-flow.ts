/**
 * RT-440 (PK-2, spec 024 §3.4) — `cart.resume`.
 *
 * Order: admit → replay (R-7) → the parked cart is the asker's (K3) → the
 * current sale (I-13: an empty one is closed, a non-empty one is parked or
 * refused) → the diff is recomputed and must be the one accepted → one
 * transaction: close / park the current, unpark, reprice, soft-remove,
 * totals, the idempotency row and `cart.resumed`.
 *
 * R-3: every line write gets its own fresh action id (never derived from the
 * resume key: a renderer-chosen cart key could equal a derived one and turn a
 * resume into a primary-key failure), and the cart's `last_action_id` is set
 * to the resume key LAST, so no Undo reaches across the resume (the key is in
 * no outbox row).
 */
import { randomUUID } from 'node:crypto';

import type { CartResumeRequest, CartResumeResponse } from '../../../shared/cart/park-types.js';
import {
  admit,
  emitAudit,
  inTransaction,
  ParkRefused,
  refused,
  replayOf,
  type Admitted,
  type ParkResumeDeps,
} from './park-context.js';
import { hashRequest } from './park-rules.js';
import { diffFor, hasRoom, ownParkedCart, parkOne } from './park-service.js';
import type { ParkCartRow } from './park-store.js';
import { isAcceptedDiff, type ResumeDiff } from './resume-diff.js';

type Draft = ParkCartRow & { line_count: number };

/** The current sale, split: empty drafts close, non-empty ones conflict. */
interface CurrentSale {
  empty: Draft[];
  open: Draft[];
}

function currentSale(deps: ParkResumeDeps, at: Admitted): CurrentSale {
  const drafts = deps.store.sessionDrafts(at.session.id);
  const isEmpty = (d: Draft): boolean =>
    d.line_count === 0 && d.state !== 'discount_pending_attribution';
  return { empty: drafts.filter(isEmpty), open: drafts.filter((d) => !isEmpty(d)) };
}

/** I-13 / VN-R10: `park` swaps a non-empty current sale out, `keep` refuses. */
function openSaleRefusal(
  deps: ParkResumeDeps,
  at: Admitted,
  open: readonly Draft[],
  req: CartResumeRequest,
): CartResumeResponse | null {
  if (req.current_cart === 'keep') return refused('current_cart_active');
  if (open.some((d) => d.state !== 'editing')) return refused('not_parkable');
  // The selected sale leaves the parked set first, so a full terminal can swap.
  return hasRoom(deps, at, open.length, 1) ? null : refused('park_limit_reached');
}

/** What the current sale allows, as a refusal or null. */
function conflictRefusal(
  deps: ParkResumeDeps,
  at: Admitted,
  current: CurrentSale,
  req: CartResumeRequest,
): CartResumeResponse | null {
  if (deps.store.sessionInCheckout(at.session.id)) return refused('checkout_in_progress');
  return current.open.length === 0 ? null : openSaleRefusal(deps, at, current.open, req);
}

/** R-6: RT-352's empty-cart close — cancel + outbox row, no audit. */
function closeEmpty(deps: ParkResumeDeps, cart: Draft, operator_id: string, when: string): void {
  const action_id = randomUUID();
  deps.cartStore.cancelCartAndOutbox(
    {
      cart_id: cart.cart_id,
      cancelled_at: when,
      cancellation_reason: 'session_ended',
      last_action_id: action_id,
      updated_at: when,
    },
    {
      action_id,
      cart_id: cart.cart_id,
      line_id: null,
      action_kind: 'cart.discarded_on_session_end',
      acting_operator_id: operator_id,
      attribution_operator_id: null,
      operator_session_id: cart.operator_session_id,
      payload_json: JSON.stringify({
        cart_id: cart.cart_id,
        operator_session_id: cart.operator_session_id,
      }),
      applied_at: when,
    },
  );
}

/** Steps 1–3 of §3.4 "on success": unpark, reprice, soft-remove, then totals. */
function applyResume(
  deps: ParkResumeDeps,
  input: { at: Admitted; cart_id: string; diff: ResumeDiff; key: string; when: string },
): void {
  const { at, cart_id, diff, key, when } = input;
  const base = {
    cart_id,
    acting_operator_id: at.session.operator_id,
    operator_session_id: at.session.id,
    at: when,
  };
  if (!deps.store.unpark({ cart_id, operator_session_id: at.session.id, key, at: when })) {
    throw new ParkRefused('not_parked');
  }
  for (const change of diff.changes) {
    deps.store.reprice({
      ...base,
      line_id: change.line_id,
      action_id: randomUUID(),
      unit_price_minor: change.new_unit_minor,
      subtotal_minor: change.new_subtotal_minor,
    });
  }
  for (const line_id of diff.unavailable) {
    deps.store.softRemove({ ...base, line_id, action_id: randomUUID() });
  }
  deps.store.settleTotals({ cart_id, key, at: when });
}

interface ResumePlan {
  at: Admitted;
  cart: ParkCartRow;
  current: CurrentSale;
  diff: ResumeDiff;
  hash: string;
}

function commit(
  deps: ParkResumeDeps,
  plan: ResumePlan,
  req: CartResumeRequest,
): CartResumeResponse {
  const { at, cart, current, diff, hash } = plan;
  const key = req.idempotency_key;
  const when = deps.clock?.().toISOString() ?? new Date().toISOString();
  const outcome: CartResumeResponse = { kind: 'resumed', cart_id: cart.cart_id };
  return inTransaction(deps, () => {
    for (const draft of current.empty) closeEmpty(deps, draft, at.session.operator_id, when);
    for (const draft of current.open) {
      parkOne(deps, { at, cart_id: draft.cart_id, label: null, key, when });
    }
    applyResume(deps, { at, cart_id: cart.cart_id, diff, key, when });
    deps.store.recordAction({
      idempotency_key: key,
      cart_id: cart.cart_id,
      action_kind: 'cart.resume',
      request_hash: hash,
      outcome_json: JSON.stringify(outcome),
      applied_at: when,
    });
    emitAudit(deps, {
      at,
      category: 'cart.resumed',
      payload: {
        cart_id: cart.cart_id,
        parked_for_ms: Math.max(0, Date.parse(when) - Date.parse(cart.parked_at ?? when)),
        price_changes_accepted: diff.changes.length,
        removed_unavailable: diff.unavailable.length,
        current_cart: current.open.length > 0 ? 'parked' : 'none',
      },
      when,
    });
    return outcome;
  });
}

function plan(
  deps: ParkResumeDeps,
  at: Admitted,
  req: CartResumeRequest,
  hash: string,
): ResumePlan | CartResumeResponse {
  const cart = ownParkedCart(deps, at, req.cart_id);
  if ('kind' in cart) return cart;
  const current = currentSale(deps, at);
  const conflict = conflictRefusal(deps, at, current, req);
  if (conflict !== null) return conflict;
  const result = diffFor(deps, at, cart.cart_id);
  if (result.kind === 'catalogue_unavailable') return refused('catalogue_unavailable');
  if (!isAcceptedDiff(result.diff, req)) return refused('price_changes_unaccepted');
  return { at, cart, current, diff: result.diff, hash };
}

export function resume(deps: ParkResumeDeps, req: CartResumeRequest): CartResumeResponse {
  const at = admit(deps);
  if ('kind' in at) return at;
  const hash = hashRequest({
    cart_id: req.cart_id,
    accept_changes: req.accept_changes,
    diff_token: req.diff_token,
    current_cart: req.current_cart,
  });
  const replay = replayOf(
    deps,
    { at, key: req.idempotency_key, kind: 'cart.resume', hash },
    (json) => JSON.parse(json) as CartResumeResponse,
  );
  if (replay !== null) return replay;
  // RT-113 P2: a session that lost its authority may not bring a sale back.
  if (at.session.authority_latch !== undefined) return refused('authority_conflict');
  const planned = plan(deps, at, req, hash);
  return 'kind' in planned ? planned : commit(deps, planned, req);
}
