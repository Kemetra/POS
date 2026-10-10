import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { ActionCategory } from '../../shared/audit/event-shape.js';
import type { ResumeStateView } from '../../shared/bridge-api.js';
import type { SessionEndCause } from '../../shared/operator/session-end-cause.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { DatabaseHandle } from '../db/client.js';
import type { OperatorSessionRecord, SessionManager } from '../operator/session-manager.js';
import type { CartStore } from './cart-store.js';

/**
 * RT-352 (RT-116 S4a, §3.1 / §3.3) — a draft cart outlives its session.
 *
 * RT-115 D3.2 superseded the 005 Q3 discard: when a session ends, its draft
 * cart is HELD for its operator on its terminal and re-attached when that
 * operator next signs in there, including after a restart. A held cart is
 * never returned to anyone else: every lookup is scoped by the owner key
 * (tenant_id, branch_id, terminal_id, owning_operator_id).
 *
 * Re-attach is the authoritative path. It runs at every admitted sign-in
 * (`onStarted`), so it also covers the ends that fire no `onEnded`, such as
 * a restart (contract §6). The `onEnded` side is best-effort: it closes an
 * empty cart and audits the hold.
 *
 * Scope: `editing` / `discount_pending_attribution` drafts. `handing_off` is
 * never persisted by main. Frozen carts are left alone: a settled sale's cart
 * also stays `frozen_handed_off`, so resuming one needs the payment check
 * that the stuck-attempt slice (S5) owns.
 *
 * Re-binding `operator_session_id` is the mechanism. The cart ownership
 * check (`cart.operator_session_id === session.id`) is unchanged.
 */

const HELD_STATES = `('editing', 'discount_pending_attribution')`;
const SESSION_END_STATES = `('empty', 'editing', 'discount_pending_attribution')`;
// `state <> 'cancelled'` matches the partial owner-key index (0046), so SQLite can use it.
const OWNER_KEY = `tenant_id = ? AND branch_id = ? AND terminal_id = ? AND owning_operator_id = ?
            AND state <> 'cancelled'`;
const NEWEST_FIRST = `ORDER BY created_at DESC, rowid DESC`;

interface CartRef {
  cart_id: string;
  state: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  operator_session_id: string;
}

type Rows<T> = { all(...params: unknown[]): T[] };
type Row<T> = { get(...params: unknown[]): T | undefined };
type Write = { run(...params: unknown[]): { changes: number } };

const CART_REF = `cart_id, state, tenant_id, branch_id, terminal_id, operator_session_id`;

export interface HeldCartsDeps {
  db: DatabaseHandle;
  cartStore: Pick<CartStore, 'cancelCartAndOutbox'>;
  auditEmitter: Pick<AuditEmitter, 'emit'>;
  /** The pairing row's real terminal_id, or null when unpaired. */
  resolveTerminalId: () => string | null;
  clock?: () => Date;
}

export interface HeldCarts {
  /** Admitted sign-in: close dead empty carts, re-attach the newest held draft. */
  reattachOnSignIn(session: OperatorSessionRecord): void;
  /** Session end: close the empty cart, audit each held draft. */
  holdOnSessionEnd(session: OperatorSessionRecord, cause: SessionEndCause | undefined): void;
  getResumeState(session: OperatorSessionRecord | null): ResumeStateView;
}

const NOTHING_TO_RESUME: ResumeStateView = {
  cart_id: null,
  payment_attempt_id: null,
  other_held_cart_count: 0,
};

function ownerKey(session: OperatorSessionRecord, terminal_id: string): string[] {
  return [session.tenant_id, session.branch_id, terminal_id, session.operator_id];
}

export function createHeldCarts(deps: HeldCartsDeps): HeldCarts {
  const { db, cartStore, auditEmitter, resolveTerminalId } = deps;
  const now = (): string => (deps.clock?.() ?? new Date()).toISOString();

  const ownerCarts = (session: OperatorSessionRecord, terminal_id: string): CartRef[] =>
    (
      db.prepare(
        `SELECT ${CART_REF} FROM carts
          WHERE ${OWNER_KEY} AND operator_session_id <> ? AND state IN ${SESSION_END_STATES}
          ${NEWEST_FIRST}`,
      ) as Rows<CartRef>
    ).all(...ownerKey(session, terminal_id), session.id);

  const sessionCarts = (session_id: string): CartRef[] =>
    (
      db.prepare(
        `SELECT ${CART_REF} FROM carts
          WHERE operator_session_id = ? AND state IN ${SESSION_END_STATES}`,
      ) as Rows<CartRef>
    ).all(session_id);

  function audit(
    cart: CartRef,
    session: OperatorSessionRecord,
    action_category: ActionCategory,
    payload: Record<string, unknown>,
  ): void {
    auditEmitter.emit({
      event_id: randomUUID(),
      tenant_id: cart.tenant_id,
      branch_id: cart.branch_id,
      originating_terminal_id: cart.terminal_id,
      acting_operator_id: session.operator_id,
      session_id: session.id,
      shift_id: null,
      action_category,
      created_at: now(),
      approving_supervisor_id: null,
      payload,
    });
  }

  /** An empty cart has nothing to lose: cancel it, with the outbox row and no audit. */
  function closeEmpty(cart: CartRef, operator_id: string): void {
    const at = now();
    const action_id = randomUUID();
    cartStore.cancelCartAndOutbox(
      {
        cart_id: cart.cart_id,
        cancelled_at: at,
        cancellation_reason: 'session_ended',
        last_action_id: action_id,
        updated_at: at,
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
        applied_at: at,
      },
    );
  }

  function reattach(cart: CartRef, session: OperatorSessionRecord): void {
    const { changes } = (
      db.prepare(
        `UPDATE carts SET operator_session_id = ?, updated_at = ?
          WHERE cart_id = ? AND operator_session_id = ? AND state IN ${HELD_STATES}`,
      ) as Write
    ).run(session.id, now(), cart.cart_id, cart.operator_session_id);
    if (changes !== 1) return;
    audit(cart, session, 'cart.reattached', {
      cart_id: cart.cart_id,
      from_operator_session_id: cart.operator_session_id,
      to_operator_session_id: session.id,
    });
  }

  function reattachOnSignIn(session: OperatorSessionRecord): void {
    const terminal_id = resolveTerminalId();
    if (terminal_id === null) return;
    db.transaction(() => {
      const carts = ownerCarts(session, terminal_id);
      for (const cart of carts.filter((c) => c.state === 'empty')) {
        closeEmpty(cart, session.operator_id);
      }
      const newest = carts.find((c) => c.state !== 'empty');
      if (newest !== undefined) reattach(newest, session);
    })();
  }

  function holdOnSessionEnd(
    session: OperatorSessionRecord,
    cause: SessionEndCause | undefined,
  ): void {
    db.transaction(() => {
      for (const cart of sessionCarts(session.id)) {
        if (cart.state === 'empty') {
          closeEmpty(cart, session.operator_id);
          continue;
        }
        audit(cart, session, 'cart.held_on_session_end', {
          cart_id: cart.cart_id,
          operator_session_id: session.id,
          end_cause: cause ?? null,
        });
      }
    })();
  }

  const currentDraft = (session_id: string): { cart_id: string } | undefined =>
    (
      db.prepare(
        `SELECT cart_id FROM carts
          WHERE operator_session_id = ? AND state IN ${HELD_STATES} ${NEWEST_FIRST} LIMIT 1`,
      ) as Row<{ cart_id: string }>
    ).get(session_id);

  function otherHeldCount(session: OperatorSessionRecord): number {
    const terminal_id = resolveTerminalId();
    if (terminal_id === null) return 0;
    const row = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM carts
          WHERE ${OWNER_KEY} AND operator_session_id <> ? AND state IN ${HELD_STATES}`,
      ) as Row<{ n: number }>
    ).get(...ownerKey(session, terminal_id), session.id);
    return row?.n ?? 0;
  }

  function getResumeState(session: OperatorSessionRecord | null): ResumeStateView {
    if (session === null) return NOTHING_TO_RESUME;
    return {
      cart_id: currentDraft(session.id)?.cart_id ?? null,
      payment_attempt_id: null,
      other_held_cart_count: otherHeldCount(session),
    };
  }

  return { reattachOnSignIn, holdOnSessionEnd, getResumeState };
}

export interface HeldCartLifecycleDeps {
  sessionManager: Pick<SessionManager, 'onStarted' | 'onEnded'>;
  heldCarts: HeldCarts;
  logger?: Pick<Logger, 'error'>;
}

/**
 * Wires sign-in → re-attach and session end → hold. A failure is logged and
 * never breaks sign-in or sign-out: the cart stays held and re-attaches at
 * the next admitted sign-in.
 */
export function registerHeldCartLifecycle(deps: HeldCartLifecycleDeps): void {
  const { sessionManager, heldCarts, logger } = deps;
  const guarded = (step: 'reattach' | 'hold', run: () => void): void => {
    try {
      run();
    } catch (err) {
      logger?.error({ err, event: `held_cart.${step}.failed` }, 'held cart step failed');
    }
  };
  sessionManager.onStarted((session) => {
    guarded('reattach', () => {
      heldCarts.reattachOnSignIn(session);
    });
  });
  sessionManager.onEnded((session, cause) => {
    guarded('hold', () => {
      heldCarts.holdOnSessionEnd(session, cause);
    });
  });
}
