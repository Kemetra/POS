/**
 * 005-sales-cart S2 — Cart persistence layer.
 *
 * Owns all SQL access for the four cart tables (`carts`, `cart_action_outbox`,
 * `cart_lines`, `cart_line_discount_placeholders`). The cart-bridge handlers
 * call into this module; this module never reads the operator session and
 * never decides authorisation — that is `requireOperatorSession`'s job.
 *
 * Wraps `DatabaseHandle` (better-sqlite3) so tests can inject a stub. The
 * production wiring lives in `src/main/index.ts`.
 *
 * SECURITY:
 * - No payload values are logged or returned to the renderer beyond the
 *   contract-specified shapes.
 * - `payload_json` is canonicalised JSON of the cart-action input; the
 *   bridge handler is responsible for stripping forbidden field names
 *   (NFR-006) before passing it here.
 * - No FK constraints exist in SQL (mirrors 004 precedent); this module
 *   enforces ownership / tenant / version integrity in code.
 */

import type { DatabaseHandle } from '../db/client.js';

// ── Narrow better-sqlite3 surfaces (R1: no native binding required at test time) ──

interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

// ── Row shapes ────────────────────────────────────────────────────────────

export interface CartRow {
  cart_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  owning_operator_id: string;
  operator_session_id: string;
  state: string;
  cart_subtotal_minor: number;
  created_at: string;
  updated_at: string;
  frozen_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  handoff_envelope_json: string | null;
  last_action_id: string | null;
}

export interface CartLineRow {
  line_id: string;
  cart_id: string;
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  note: string | null;
  version: number;
  last_action_id: string;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

export interface OutboxRow {
  action_id: string;
  cart_id: string;
  line_id: string | null;
  action_kind: string;
  acting_operator_id: string;
  attribution_operator_id: string | null;
  operator_session_id: string;
  payload_json: string;
  applied_at: string;
  synced_at: string | null;
}

export interface InsertCartInput {
  cart_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  owning_operator_id: string;
  operator_session_id: string;
  state: string;
  created_at: string;
  /** Outbox row id for the `cart.create` action. */
  last_action_id: string;
}

export interface InsertOutboxInput {
  action_id: string;
  cart_id: string;
  line_id: string | null;
  action_kind: string;
  acting_operator_id: string;
  attribution_operator_id: string | null;
  operator_session_id: string;
  /** Canonicalised JSON, post-redaction. */
  payload_json: string;
  applied_at: string;
}

export interface InsertCartLineInput {
  line_id: string;
  cart_id: string;
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  note: string | null;
  last_action_id: string;
  created_at: string;
}

export interface UpdateCartLineQtyInput {
  line_id: string;
  quantity: number;
  line_subtotal_minor: number;
  last_action_id: string;
  updated_at: string;
}

export interface UpdateCartLineNoteInput {
  line_id: string;
  note: string | null;
  last_action_id: string;
  updated_at: string;
}

export interface SoftRemoveCartLineInput {
  line_id: string;
  removed_at: string;
  last_action_id: string;
}

export interface CancelCartInput {
  cart_id: string;
  cancelled_at: string;
  cancellation_reason: 'cashier_voided' | 'manager_voided_post_handoff' | 'session_ended';
  last_action_id: string;
  updated_at: string;
}

export interface HandoffCartInput {
  cart_id: string;
  frozen_at: string;
  /** JSON-serialised PaymentIntentEnvelope v1. */
  handoff_envelope_json: string;
  last_action_id: string;
  updated_at: string;
}

export interface InsertDiscountPlaceholderInput {
  placeholder_id: string;
  cart_id: string;
  line_id: string;
  placeholder_kind: string;
  requires_manager_attribution: 0 | 1;
  attribution_operator_id: string | null;
  created_at: string;
}

export interface DiscountPlaceholderRow {
  placeholder_id: string;
  cart_id: string;
  line_id: string;
  placeholder_kind: string;
  requires_manager_attribution: number;
  attribution_operator_id: string | null;
  created_at: string;
}

// ── CartStore ────────────────────────────────────────────────────────────

export interface CartStore {
  insertCartAndOutbox(cart: InsertCartInput, outbox: InsertOutboxInput): void;
  insertLineAndOutbox(line: InsertCartLineInput, outbox: InsertOutboxInput): void;
  mergeLineAndOutbox(update: UpdateCartLineQtyInput, outbox: InsertOutboxInput): void;
  updateLineQuantityAndOutbox(update: UpdateCartLineQtyInput, outbox: InsertOutboxInput): void;
  setLineNoteAndOutbox(update: UpdateCartLineNoteInput, outbox: InsertOutboxInput): void;
  softRemoveLineAndOutbox(remove: SoftRemoveCartLineInput, outbox: InsertOutboxInput): void;
  /**
   * Atomically writes the discount placeholder row + outbox row, then calls
   * `onInserted` (if provided) inside the same transaction — same audit-atomic
   * pattern as `cancelCartAndOutbox`.
   */
  insertDiscountPlaceholderAndOutbox(
    placeholder: InsertDiscountPlaceholderInput,
    outbox: InsertOutboxInput,
    onInserted?: () => void,
  ): void;
  /** Hard-deletes the placeholder row and writes the outbox row atomically. */
  removeDiscountPlaceholderAndOutbox(placeholder_id: string, outbox: InsertOutboxInput): void;
  getDiscountPlaceholder(placeholder_id: string): DiscountPlaceholderRow | undefined;
  /**
   * Atomically writes the outbox row, cancels the cart, and (if provided)
   * calls `onInserted` inside the same transaction — enabling audit emission
   * to be atomic with the state change without this store knowing about audits.
   */
  cancelCartAndOutbox(
    cancel: CancelCartInput,
    outbox: InsertOutboxInput,
    onInserted?: () => void,
  ): void;
  /**
   * Post-handoff cancel as ONE transaction (§A4 review): re-read the cart
   * state, ask `isStillCancellable` (the payments record), write the outbox
   * row, then UPDATE only while the cart is still `frozen_handed_off`. If any
   * step finds the cart no longer cancellable, nothing is written (the whole
   * transaction rolls back) and `false` is returned; `onInserted` (the audit
   * emit) runs only on success, inside the transaction.
   */
  cancelFrozenCartAndOutbox(
    cancel: CancelCartInput,
    outbox: InsertOutboxInput,
    isStillCancellable: () => boolean,
    onInserted?: () => void,
  ): boolean;
  /**
   * Atomically writes the outbox row, freezes the cart (state=frozen_handed_off,
   * frozen_at, handoff_envelope_json), and calls `onInserted` inside the same
   * transaction — enabling audit emission to be atomic with the freeze.
   */
  handoffCartAndOutbox(
    handoff: HandoffCartInput,
    outbox: InsertOutboxInput,
    onInserted?: () => void,
  ): void;
  /** Returns the action_id of the most recent `cart.handoff_to_payment` outbox row. */
  findLatestHandoffActionId(cart_id: string): string | undefined;
  /** Returns the active (non-terminal) draft cart owned by the given session, if any. */
  findDraftCartBySession(operator_session_id: string): CartRow | undefined;
  /** Returns all non-removed cart lines for the given cart. */
  getActiveLines(cart_id: string): CartLineRow[];
  /** Returns all discount placeholders for the given cart. */
  getDiscountPlaceholdersForCart(cart_id: string): DiscountPlaceholderRow[];
  getCart(cart_id: string): CartRow | undefined;
  getLine(cart_id: string, line_id: string): CartLineRow | undefined;
  findActiveLineByItemRef(cart_id: string, item_ref: string): CartLineRow | undefined;
  getOutboxRow(action_id: string): OutboxRow | undefined;
}

export function bindCartStore(db: DatabaseHandle): CartStore {
  const insertCart = db.prepare(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor,
       created_at, updated_at, last_action_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ) as PrepareRun;

  const insertOutbox = db.prepare(
    `INSERT INTO cart_action_outbox (
       action_id, cart_id, line_id, action_kind,
       acting_operator_id, attribution_operator_id, operator_session_id,
       payload_json, applied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ) as PrepareRun;

  const insertLine = db.prepare(
    `INSERT INTO cart_lines (
       line_id, cart_id, item_ref, display_name,
       quantity, unit_price_minor, line_subtotal_minor,
       note, version, last_action_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ) as PrepareRun;

  const updateLineQty = db.prepare(
    `UPDATE cart_lines
       SET quantity = ?,
           line_subtotal_minor = ?,
           last_action_id = ?,
           updated_at = ?,
           version = version + 1
     WHERE line_id = ?`,
  ) as PrepareRun;

  const updateLineNote = db.prepare(
    `UPDATE cart_lines
       SET note = ?,
           last_action_id = ?,
           updated_at = ?,
           version = version + 1
     WHERE line_id = ?`,
  ) as PrepareRun;

  const softRemoveLine = db.prepare(
    `UPDATE cart_lines
       SET removed_at = ?,
           last_action_id = ?,
           version = version + 1,
           updated_at = ?
     WHERE line_id = ?`,
  ) as PrepareRun;

  const getCartStmt = db.prepare(`SELECT * FROM carts WHERE cart_id = ?`) as PrepareGet<CartRow>;
  const getLineStmt = db.prepare(
    `SELECT * FROM cart_lines WHERE cart_id = ? AND line_id = ?`,
  ) as PrepareGet<CartLineRow>;
  const findActiveLineStmt = db.prepare(
    `SELECT * FROM cart_lines WHERE cart_id = ? AND item_ref = ? AND removed_at IS NULL LIMIT 1`,
  ) as PrepareGet<CartLineRow>;
  const getOutboxStmt = db.prepare(
    `SELECT * FROM cart_action_outbox WHERE action_id = ?`,
  ) as PrepareGet<OutboxRow>;
  const subtotalStmt = db.prepare(
    `SELECT COALESCE(SUM(line_subtotal_minor), 0) AS total
       FROM cart_lines
      WHERE cart_id = ? AND removed_at IS NULL`,
  ) as PrepareGet<{ total: number }>;
  const updateCartTotal = db.prepare(
    `UPDATE carts SET cart_subtotal_minor = ?, updated_at = ?, last_action_id = ? WHERE cart_id = ?`,
  ) as PrepareRun;
  const setCartStateStmt = db.prepare(
    `UPDATE carts SET state = ?, updated_at = ?, last_action_id = ? WHERE cart_id = ?`,
  ) as PrepareRun;
  const cancelCartStmt = db.prepare(
    `UPDATE carts
        SET state = 'cancelled',
            cancelled_at = ?,
            cancellation_reason = ?,
            updated_at = ?,
            last_action_id = ?
      WHERE cart_id = ?`,
  ) as PrepareRun;
  const cartStateStmt = db.prepare(`SELECT state FROM carts WHERE cart_id = ?`) as PrepareGet<{
    state: string;
  }>;
  const cancelFrozenCartStmt = db.prepare(
    `UPDATE carts
        SET state = 'cancelled',
            cancelled_at = ?,
            cancellation_reason = ?,
            updated_at = ?,
            last_action_id = ?
      WHERE cart_id = ? AND state = 'frozen_handed_off'`,
  ) as PrepareRun;
  const findLatestHandoffStmt = db.prepare(
    `SELECT action_id FROM cart_action_outbox
      WHERE cart_id = ? AND action_kind = 'cart.handoff_to_payment'
      ORDER BY applied_at DESC LIMIT 1`,
  ) as PrepareGet<{ action_id: string }>;
  const findDraftCartBySessionStmt = db.prepare(
    `SELECT * FROM carts
      WHERE operator_session_id = ?
        AND state NOT IN ('cancelled', 'frozen_handed_off')
      ORDER BY created_at DESC LIMIT 1`,
  ) as PrepareGet<CartRow>;
  const insertDiscountPlaceholder = db.prepare(
    `INSERT INTO cart_line_discount_placeholders (
       placeholder_id, cart_id, line_id, placeholder_kind,
       requires_manager_attribution, attribution_operator_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ) as PrepareRun;
  const deleteDiscountPlaceholder = db.prepare(
    `DELETE FROM cart_line_discount_placeholders WHERE placeholder_id = ?`,
  ) as PrepareRun;
  const getDiscountPlaceholderStmt = db.prepare(
    `SELECT * FROM cart_line_discount_placeholders WHERE placeholder_id = ?`,
  ) as PrepareGet<DiscountPlaceholderRow>;
  const getActiveLinesStmt = db.prepare(
    `SELECT * FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL ORDER BY created_at ASC`,
  ) as { all(...params: unknown[]): CartLineRow[] };
  const getDiscountPlaceholdersForCartStmt = db.prepare(
    `SELECT * FROM cart_line_discount_placeholders WHERE cart_id = ? ORDER BY created_at ASC`,
  ) as { all(...params: unknown[]): DiscountPlaceholderRow[] };
  const handoffCartStmt = db.prepare(
    `UPDATE carts
        SET state = 'frozen_handed_off',
            frozen_at = ?,
            handoff_envelope_json = ?,
            updated_at = ?,
            last_action_id = ?
      WHERE cart_id = ?`,
  ) as PrepareRun;

  function writeOutbox(row: InsertOutboxInput): void {
    insertOutbox.run(
      row.action_id,
      row.cart_id,
      row.line_id,
      row.action_kind,
      row.acting_operator_id,
      row.attribution_operator_id,
      row.operator_session_id,
      row.payload_json,
      row.applied_at,
    );
  }

  function recomputeSubtotal(cart_id: string, updated_at: string, last_action_id: string): number {
    // COALESCE(SUM(...), 0) guarantees a row with a non-null total even when
    // no matching lines exist, so the get() result is always defined.
    const row = subtotalStmt.get(cart_id) as { total: number };
    updateCartTotal.run(row.total, updated_at, last_action_id, cart_id);
    return row.total;
  }

  return {
    insertCartAndOutbox(cart, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        insertCart.run(
          cart.cart_id,
          cart.tenant_id,
          cart.branch_id,
          cart.terminal_id,
          cart.owning_operator_id,
          cart.operator_session_id,
          cart.state,
          cart.created_at,
          cart.created_at,
          cart.last_action_id,
        );
      })();
    },

    insertLineAndOutbox(line, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        insertLine.run(
          line.line_id,
          line.cart_id,
          line.item_ref,
          line.display_name,
          line.quantity,
          line.unit_price_minor,
          line.line_subtotal_minor,
          line.note,
          line.last_action_id,
          line.created_at,
          line.created_at,
        );
        recomputeSubtotal(line.cart_id, line.created_at, line.last_action_id);
        // Cart transitions empty → editing on the first add. Bridge layer
        // decides this; we only ever set state when it changes.
        setCartStateStmt.run('editing', line.created_at, line.last_action_id, line.cart_id);
      })();
    },

    mergeLineAndOutbox(update, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        updateLineQty.run(
          update.quantity,
          update.line_subtotal_minor,
          update.last_action_id,
          update.updated_at,
          update.line_id,
        );
        // Caller guarantees outbox.cart_id matches the line's cart_id.
        recomputeSubtotal(outbox.cart_id, update.updated_at, update.last_action_id);
      })();
    },

    updateLineQuantityAndOutbox(update, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        updateLineQty.run(
          update.quantity,
          update.line_subtotal_minor,
          update.last_action_id,
          update.updated_at,
          update.line_id,
        );
        recomputeSubtotal(outbox.cart_id, update.updated_at, update.last_action_id);
      })();
    },

    setLineNoteAndOutbox(update, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        updateLineNote.run(update.note, update.last_action_id, update.updated_at, update.line_id);
      })();
    },

    softRemoveLineAndOutbox(remove, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        softRemoveLine.run(
          remove.removed_at,
          remove.last_action_id,
          remove.removed_at,
          remove.line_id,
        );
        recomputeSubtotal(outbox.cart_id, remove.removed_at, remove.last_action_id);
      })();
    },

    insertDiscountPlaceholderAndOutbox(placeholder, outbox, onInserted): void {
      db.transaction(() => {
        writeOutbox(outbox);
        insertDiscountPlaceholder.run(
          placeholder.placeholder_id,
          placeholder.cart_id,
          placeholder.line_id,
          placeholder.placeholder_kind,
          placeholder.requires_manager_attribution,
          placeholder.attribution_operator_id,
          placeholder.created_at,
        );
        onInserted?.();
      })();
    },

    removeDiscountPlaceholderAndOutbox(placeholder_id, outbox): void {
      db.transaction(() => {
        writeOutbox(outbox);
        deleteDiscountPlaceholder.run(placeholder_id);
      })();
    },

    getDiscountPlaceholder(placeholder_id): DiscountPlaceholderRow | undefined {
      return getDiscountPlaceholderStmt.get(placeholder_id);
    },

    cancelCartAndOutbox(cancel, outbox, onInserted): void {
      db.transaction(() => {
        writeOutbox(outbox);
        cancelCartStmt.run(
          cancel.cancelled_at,
          cancel.cancellation_reason,
          cancel.updated_at,
          cancel.last_action_id,
          cancel.cart_id,
        );
        onInserted?.();
      })();
    },

    cancelFrozenCartAndOutbox(cancel, outbox, isStillCancellable, onInserted): boolean {
      const notCancellable = new Error('cart no longer cancellable');
      try {
        return db.transaction((): boolean => {
          if (cartStateStmt.get(cancel.cart_id)?.state !== 'frozen_handed_off') return false;
          if (!isStillCancellable()) return false;
          writeOutbox(outbox);
          const result = cancelFrozenCartStmt.run(
            cancel.cancelled_at,
            cancel.cancellation_reason,
            cancel.updated_at,
            cancel.last_action_id,
            cancel.cart_id,
          );
          // The cart left `frozen_handed_off` after the check: roll back.
          if (result.changes !== 1) throw notCancellable;
          onInserted?.();
          return true;
        })();
      } catch (err) {
        if (err === notCancellable) return false;
        throw err;
      }
    },

    handoffCartAndOutbox(handoff, outbox, onInserted): void {
      db.transaction(() => {
        writeOutbox(outbox);
        handoffCartStmt.run(
          handoff.frozen_at,
          handoff.handoff_envelope_json,
          handoff.updated_at,
          handoff.last_action_id,
          handoff.cart_id,
        );
        onInserted?.();
      })();
    },

    getActiveLines(cart_id): CartLineRow[] {
      return getActiveLinesStmt.all(cart_id);
    },

    getDiscountPlaceholdersForCart(cart_id): DiscountPlaceholderRow[] {
      return getDiscountPlaceholdersForCartStmt.all(cart_id);
    },

    findLatestHandoffActionId(cart_id): string | undefined {
      return findLatestHandoffStmt.get(cart_id)?.action_id;
    },

    findDraftCartBySession(operator_session_id): CartRow | undefined {
      return findDraftCartBySessionStmt.get(operator_session_id);
    },

    getCart(cart_id): CartRow | undefined {
      return getCartStmt.get(cart_id);
    },

    getLine(cart_id, line_id): CartLineRow | undefined {
      return getLineStmt.get(cart_id, line_id);
    },

    findActiveLineByItemRef(cart_id, item_ref): CartLineRow | undefined {
      return findActiveLineStmt.get(cart_id, item_ref);
    },

    getOutboxRow(action_id): OutboxRow | undefined {
      return getOutboxStmt.get(action_id);
    },
  };
}
