/**
 * RT-440 (PK-2, spec 024) — the SQL of Park v1. Reads scope every lookup by
 * the RT-116 §3.1 owner key or the terminal; writes are conditional, so a
 * caller learns from `false` that the row moved under it.
 *
 * The park label is read only for the owner's own list (§3.2); no statement
 * here copies it anywhere else.
 */
import { randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../../db/client.js';

export interface ParkScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

export interface OwnerKey extends ParkScope {
  owning_operator_id: string;
}

export interface ParkCartRow extends OwnerKey {
  cart_id: string;
  operator_session_id: string;
  state: string;
  cart_subtotal_minor: number;
  parked_at: string | null;
}

export interface ParkedListRow {
  cart_id: string;
  park_label: string | null;
  line_count: number;
  cart_subtotal_minor: number;
  parked_at: string;
}

export interface ParkLineRow {
  line_id: string;
  item_ref: string;
  quantity: number;
  unit_price_minor: number;
}

export interface ParkActionRow {
  idempotency_key: string;
  cart_id: string;
  action_kind: 'cart.park' | 'cart.resume';
  request_hash: string;
  outcome_json: string;
  applied_at: string;
}

/** One line write of a resume, with the outbox row that records it. */
export interface ResumeLineWrite {
  cart_id: string;
  line_id: string;
  action_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  at: string;
}

type Get<T> = { get(...params: unknown[]): T | undefined };
type All<T> = { all(...params: unknown[]): T[] };
type Run = { run(...params: unknown[]): { changes: number } };

const CART_COLUMNS = `cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
  operator_session_id, state, cart_subtotal_minor, parked_at`;

/** A started attempt, or tender still live on any attempt (RT-116 M7). */
const OPEN_PAYMENT = `EXISTS (
    SELECT 1 FROM payment_attempts a
     WHERE a.envelope_cart_id = carts.cart_id
       AND (a.state = 'started' OR EXISTS (
             SELECT 1 FROM payment_tender_lines l
              WHERE l.payment_attempt_id = a.payment_attempt_id
                AND l.state IN ('applying', 'applied', 'reversal_pending'))))`;

const ACTIVE_LINES = `(SELECT COUNT(*) FROM cart_lines l
    WHERE l.cart_id = carts.cart_id AND l.removed_at IS NULL)`;

export interface ParkStore {
  getCart(cart_id: string): ParkCartRow | undefined;
  activeLineCount(cart_id: string): number;
  hasOpenPayment(cart_id: string): boolean;
  /** K2: parked sales on this terminal, across operators. */
  countParked(scope: ParkScope): number;
  listParked(owner: OwnerKey): ParkedListRow[];
  parkedLines(cart_id: string): ParkLineRow[];
  /** The session's non-parked drafts (I-13 conflict), newest first. */
  sessionDrafts(operator_session_id: string): (ParkCartRow & { line_count: number })[];
  /** A handed-off sale of the session not yet paid, or a started attempt. */
  sessionInCheckout(operator_session_id: string): boolean;
  findAction(key: string): ParkActionRow | undefined;
  outboxHasKey(key: string): boolean;
  markParked(input: {
    cart_id: string;
    operator_session_id: string;
    label: string | null;
    key: string;
    at: string;
  }): boolean;
  unpark(input: { cart_id: string; operator_session_id: string; key: string; at: string }): boolean;
  reprice(write: ResumeLineWrite & { unit_price_minor: number; subtotal_minor: number }): void;
  softRemove(write: ResumeLineWrite): void;
  /** Recompute the subtotal; `last_action_id` is set to `key` last (R-3). */
  settleTotals(input: { cart_id: string; key: string; at: string }): void;
  recordAction(row: ParkActionRow): void;
}

export function bindParkStore(db: DatabaseHandle): ParkStore {
  // COUNT(*) always answers one row.
  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql) as { get(...p: unknown[]): { n: number } }).get(...params).n;
  const exists = (sql: string, ...params: unknown[]): boolean =>
    (db.prepare(sql) as Get<{ hit: number }>).get(...params) !== undefined;
  const run = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql) as Run).run(...params).changes;

  function writeOutbox(write: ResumeLineWrite, kind: string, payload: object): void {
    run(
      `INSERT INTO cart_action_outbox (action_id, cart_id, line_id, action_kind,
         acting_operator_id, attribution_operator_id, operator_session_id, payload_json, applied_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      write.action_id,
      write.cart_id,
      write.line_id,
      kind,
      write.acting_operator_id,
      write.operator_session_id,
      JSON.stringify(payload),
      write.at,
    );
  }

  /**
   * A removed line takes its discount placeholders with it: the handoff
   * envelope carries every placeholder of the cart, and no Undo can bring the
   * line back across a resume (R-3), so one left behind would be an orphan.
   */
  function removeLinePlaceholders(write: ResumeLineWrite): void {
    const placeholders = (
      db.prepare(
        `SELECT placeholder_id FROM cart_line_discount_placeholders
          WHERE cart_id = ? AND line_id = ?`,
      ) as All<{ placeholder_id: string }>
    ).all(write.cart_id, write.line_id);
    for (const { placeholder_id } of placeholders) {
      run(`DELETE FROM cart_line_discount_placeholders WHERE placeholder_id = ?`, placeholder_id);
      writeOutbox({ ...write, action_id: randomUUID() }, 'cart.discount_placeholder.remove', {
        cart_id: write.cart_id,
        placeholder_id,
      });
    }
  }

  return {
    getCart: (cart_id) =>
      (db.prepare(`SELECT ${CART_COLUMNS} FROM carts WHERE cart_id = ?`) as Get<ParkCartRow>).get(
        cart_id,
      ),

    activeLineCount: (cart_id) =>
      count(
        `SELECT COUNT(*) AS n FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL`,
        cart_id,
      ),

    hasOpenPayment: (cart_id) =>
      exists(`SELECT 1 AS hit FROM carts WHERE cart_id = ? AND ${OPEN_PAYMENT}`, cart_id),

    countParked: (scope) =>
      count(
        `SELECT COUNT(*) AS n FROM carts
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
            AND parked_at IS NOT NULL AND state = 'editing'`,
        scope.tenant_id,
        scope.branch_id,
        scope.terminal_id,
      ),

    listParked: (owner) =>
      (
        db.prepare(
          `SELECT cart_id, park_label, ${ACTIVE_LINES} AS line_count, cart_subtotal_minor,
                  parked_at
             FROM carts
            WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND owning_operator_id = ?
              AND parked_at IS NOT NULL AND state = 'editing'
            ORDER BY parked_at DESC, rowid DESC`,
        ) as All<ParkedListRow>
      ).all(owner.tenant_id, owner.branch_id, owner.terminal_id, owner.owning_operator_id),

    parkedLines: (cart_id) =>
      (
        db.prepare(
          `SELECT line_id, item_ref, quantity, unit_price_minor FROM cart_lines
            WHERE cart_id = ? AND removed_at IS NULL ORDER BY created_at ASC`,
        ) as All<ParkLineRow>
      ).all(cart_id),

    sessionDrafts: (operator_session_id) =>
      (
        db.prepare(
          `SELECT ${CART_COLUMNS}, ${ACTIVE_LINES} AS line_count FROM carts
            WHERE operator_session_id = ? AND parked_at IS NULL
              AND state IN ('empty', 'editing', 'discount_pending_attribution')
            ORDER BY created_at DESC, rowid DESC`,
        ) as All<ParkCartRow & { line_count: number }>
      ).all(operator_session_id),

    sessionInCheckout: (operator_session_id) =>
      exists(
        `SELECT 1 AS hit FROM carts
          WHERE operator_session_id = ?
            AND ((state IN ('handing_off', 'frozen_handed_off') AND NOT EXISTS (
                   SELECT 1 FROM payment_attempts a
                    WHERE a.envelope_cart_id = carts.cart_id AND a.state = 'settled'))
                 OR (state <> 'cancelled' AND ${OPEN_PAYMENT}))
          LIMIT 1`,
        operator_session_id,
      ),

    findAction: (key) =>
      (
        db.prepare(
          `SELECT * FROM cart_park_actions WHERE idempotency_key = ?`,
        ) as Get<ParkActionRow>
      ).get(key),

    outboxHasKey: (key) =>
      exists(`SELECT 1 AS hit FROM cart_action_outbox WHERE action_id = ?`, key),

    markParked: (input) =>
      run(
        `UPDATE carts SET parked_at = ?, park_label = ?, last_action_id = ?, updated_at = ?
          WHERE cart_id = ? AND operator_session_id = ? AND state = 'editing'
            AND parked_at IS NULL`,
        input.at,
        input.label,
        input.key,
        input.at,
        input.cart_id,
        input.operator_session_id,
      ) === 1,

    unpark: (input) =>
      run(
        `UPDATE carts SET parked_at = NULL, park_label = NULL, operator_session_id = ?,
                last_action_id = ?, updated_at = ?
          WHERE cart_id = ? AND state = 'editing' AND parked_at IS NOT NULL`,
        input.operator_session_id,
        input.key,
        input.at,
        input.cart_id,
      ) === 1,

    reprice(write) {
      run(
        `UPDATE cart_lines
            SET unit_price_minor = ?, line_subtotal_minor = ?, last_action_id = ?,
                updated_at = ?, version = version + 1
          WHERE line_id = ? AND cart_id = ? AND removed_at IS NULL`,
        write.unit_price_minor,
        write.subtotal_minor,
        write.action_id,
        write.at,
        write.line_id,
        write.cart_id,
      );
      writeOutbox(write, 'cart.line.update', {
        op: 'reprice_on_resume',
        new_unit_price_minor: write.unit_price_minor,
      });
    },

    softRemove(write) {
      run(
        `UPDATE cart_lines
            SET removed_at = ?, last_action_id = ?, updated_at = ?, version = version + 1
          WHERE line_id = ? AND cart_id = ? AND removed_at IS NULL`,
        write.at,
        write.action_id,
        write.at,
        write.line_id,
        write.cart_id,
      );
      writeOutbox(write, 'cart.line.remove', { reason: 'unavailable_on_resume' });
      removeLinePlaceholders(write);
    },

    settleTotals(input) {
      run(
        `UPDATE carts
            SET cart_subtotal_minor = (SELECT COALESCE(SUM(line_subtotal_minor), 0)
                                         FROM cart_lines
                                        WHERE cart_id = ? AND removed_at IS NULL),
                last_action_id = ?, updated_at = ?
          WHERE cart_id = ?`,
        input.cart_id,
        input.key,
        input.at,
        input.cart_id,
      );
    },

    recordAction(row) {
      run(
        `INSERT INTO cart_park_actions (idempotency_key, cart_id, action_kind, request_hash,
           outcome_json, applied_at) VALUES (?, ?, ?, ?, ?, ?)`,
        row.idempotency_key,
        row.cart_id,
        row.action_kind,
        row.request_hash,
        row.outcome_json,
        row.applied_at,
      );
    },
  };
}
