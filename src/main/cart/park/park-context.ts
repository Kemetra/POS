/**
 * RT-440 (PK-2) — what the four park calls share: the admitted session and
 * terminal, the owner-key check (K3), the audit emit and the replay of a
 * recorded key (R-7).
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { ActionCategory } from '../../../shared/audit/event-shape.js';
import type { CartParkRefusal, CartParkRefusalReason } from '../../../shared/cart/park-types.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import type { CartStore } from '../cart-store.js';
import type { ParkCartRow, ParkStore } from './park-store.js';
import type { PriceLookup } from './resume-diff.js';

export interface ParkResumeDeps {
  db: DatabaseHandle;
  store: ParkStore;
  /** RT-352's empty-cart close (`cancelCartAndOutbox`), reused by resume (R-6). */
  cartStore: Pick<CartStore, 'cancelCartAndOutbox'>;
  getCurrentSession: () => OperatorSessionRecord | null;
  /** The pairing row's real terminal_id, or null when unpaired. */
  getTerminalId: () => string | null;
  auditEmitter: Pick<AuditEmitter, 'emit'>;
  prices: PriceLookup;
  clock?: () => Date;
  logger?: Pick<Logger, 'info' | 'error'>;
}

/** An unlocked session on a paired terminal. */
export interface Admitted {
  session: OperatorSessionRecord;
  terminal_id: string;
}

export const refused = (reason: CartParkRefusalReason): CartParkRefusal => ({
  kind: 'refused',
  reason,
});

/** Thrown inside a transaction to roll it back and answer `reason`. */
export class ParkRefused extends Error {
  constructor(readonly reason: CartParkRefusalReason) {
    super(reason);
    this.name = 'ParkRefused';
  }
}

export function admit(deps: ParkResumeDeps): Admitted | CartParkRefusal {
  const session = deps.getCurrentSession();
  if (session === null) return refused('no_session');
  if (session.lock_state === 'locked') return refused('session_locked');
  const terminal_id = deps.getTerminalId();
  if (terminal_id === null) return refused('no_session');
  return { session, terminal_id };
}

/** K3: the cart is the session operator's, on this terminal and store. */
export function isOwnCart(cart: ParkCartRow, at: Admitted): boolean {
  return (
    cart.tenant_id === at.session.tenant_id &&
    cart.branch_id === at.session.branch_id &&
    cart.terminal_id === at.terminal_id &&
    cart.owning_operator_id === at.session.operator_id
  );
}

export function nowOf(deps: ParkResumeDeps): Date {
  return deps.clock?.() ?? new Date();
}

export function emitAudit(
  deps: ParkResumeDeps,
  input: {
    at: Admitted;
    category: Extract<ActionCategory, 'cart.parked' | 'cart.resumed' | 'cart.park_refused'>;
    payload: Record<string, unknown>;
    when: string;
  },
): void {
  const { session, terminal_id } = input.at;
  deps.auditEmitter.emit({
    event_id: randomUUID(),
    tenant_id: session.tenant_id,
    branch_id: session.branch_id,
    originating_terminal_id: terminal_id,
    acting_operator_id: session.operator_id,
    session_id: session.id,
    shift_id: null,
    action_category: input.category,
    created_at: input.when,
    approving_supervisor_id: null,
    payload: input.payload,
  });
}

/**
 * R-7: a key already recorded. Same kind and request on the asker's own cart →
 * the recorded outcome; anything else → a refusal. Null when the key is new.
 * A key the cart bridge already used is never a park or resume key.
 */
export function replayOf<T>(
  deps: ParkResumeDeps,
  input: { at: Admitted; key: string; kind: 'cart.park' | 'cart.resume'; hash: string },
  decode: (outcome_json: string) => T,
): T | CartParkRefusal | null {
  const row = deps.store.findAction(input.key);
  if (row === undefined) {
    return deps.store.outboxHasKey(input.key) ? refused('idempotency_payload_mismatch') : null;
  }
  if (row.action_kind !== input.kind || row.request_hash !== input.hash) {
    return refused('idempotency_payload_mismatch');
  }
  const cart = deps.store.getCart(row.cart_id);
  if (cart === undefined || !isOwnCart(cart, input.at)) return refused('wrong_owner');
  return decode(row.outcome_json);
}

/** Run `work` in one transaction; a `ParkRefused` thrown inside becomes the answer. */
export function inTransaction<T>(deps: ParkResumeDeps, work: () => T): T | CartParkRefusal {
  try {
    return deps.db.transaction(work)();
  } catch (err) {
    if (err instanceof ParkRefused) return refused(err.reason);
    throw err;
  }
}
