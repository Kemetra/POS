import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type {
  CartCreateRequest,
  CartCreateResponse,
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersAddResponse,
  CartDiscountPlaceholdersRemoveRequest,
  CartDiscountPlaceholdersRemoveResponse,
  CartHandoffRequest,
  CartHandoffResponse,
  CartLinesAddRequest,
  CartLinesAddResponse,
  CartLinesRemoveRequest,
  CartLinesRemoveResponse,
  CartLinesSetNoteRequest,
  CartLinesSetNoteResponse,
  CartLinesUpdateRequest,
  CartLinesUpdateResponse,
  CartSnapshotRequest,
  CartSnapshotResponse,
  CartSubscribeRequest,
  CartSubscribeResponse,
  CartVoidRequest,
  CartVoidResponse,
} from '../../shared/cart/bridge-types.js';
import { CartState } from '../../shared/cart/cart-state.js';
import type { CartRefusalReason } from '../../shared/cart/refusal.js';
import { computeLineSubtotal, LineSubtotalError } from './line-subtotal.js';
import { requireOperatorSession } from './require-operator-session.js';
import type { CartStore, InsertDiscountPlaceholderInput } from './cart-store.js';
import { AuditEmitter } from '../audit/audit-emitter.js';
import { buildPaymentIntentEnvelope } from './handoff-envelope-builder.js';
import { freezeEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { CartPaymentStatus } from '../payments/repositories/payment-attempts.repository.js';

/**
 * 005-sales-cart S2 — `cart.*` bridge handlers (T025/T026 from S1 +
 * T045–T048 added in S2).
 *
 * Every handler is gated by `requireOperatorSession` as its FIRST trust
 * boundary (AD-1). All cart mutations go through this class.
 *
 * Persistence:
 * - When a `CartStore` is supplied via `deps.cartStore`, the handlers
 *   write to SQLite via the four cart tables (§A2-cleared schema).
 * - When `deps.cartStore` is omitted, the handlers fall back to an
 *   in-memory `Map<cart_id, CartRecord>` — used by S1 unit tests for
 *   pure role-gate coverage. Production wiring (in `src/main/index.ts`)
 *   always supplies a `CartStore`.
 *
 * SECURITY:
 * - `requireOperatorSession` runs first; persistence/business logic
 *   never short-circuits ahead of the gate.
 * - Refusals are generic — no factor-distinguishing detail leaks.
 * - No payload values (note content, attribution identity, secrets)
 *   are logged here.
 * - Q4 merge uniqueness is application-layer only; no SQL UNIQUE.
 */

interface InMemoryCartRecord {
  readonly cart_id: string;
  readonly operator_session_id: string;
  readonly owning_operator_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  state: CartState;
}

/**
 * R7 seam — resolve a catalogue item-ref into the snapshot fields
 * cart_lines persists at add-time (FR-011 / FR-013).
 *
 * S2 ships a stubbed default resolver that refuses generically; tests
 * inject a fixture resolver. A production resolver lands when the
 * future item-catalogue feature ships (T053).
 */
export type ItemRefResolver = (
  item_ref: string,
) => Promise<
  | { kind: 'ok'; display_name: string; unit_price_minor: number }
  | { kind: 'refused'; reason: 'unknown_item' | 'disabled' | 'no_connection' | 'generic' }
>;

const DEFAULT_ITEM_REF_RESOLVER: ItemRefResolver = () =>
  Promise.resolve({ kind: 'refused', reason: 'generic' });

/**
 * Forbidden-pattern check for `cart.lines.setNote` (NFR-006 / FR-021).
 *
 * Minimal S2 list — refuses notes that contain credential-like fragments.
 * The full allowlist + regex catalogue lands in T054 (pino redaction
 * extension is the load-bearing layer; this is the bridge-side gate).
 */
const FORBIDDEN_NOTE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:pin|password|passwd|secret|token|jwt|credential|authorization)\b/i,
  /\b\d{13,19}\b/, // bare card-number-shaped sequences
  /-----BEGIN/i, // PEM key headers
];

function noteHasForbiddenPattern(note: string): boolean {
  return FORBIDDEN_NOTE_PATTERNS.some((re) => re.test(note));
}

/**
 * Strip forbidden payload-field NAMES from a payload tree before it is
 * serialised into `cart_action_outbox.payload_json`. This is the cart-
 * layer mirror of `src/main/audit/audit-emitter.ts`'s `findForbiddenKey`.
 * S2 inlines a minimal version; T054 may extend it.
 */
const FORBIDDEN_PAYLOAD_FIELD_NAMES: ReadonlySet<string> = new Set([
  'pin',
  'pin_hash',
  'password',
  'password_hash',
  'clerk_jwt',
  'clerk_session_token',
  'device_token',
  'device_token_attestation',
  'pairing_code',
  'token',
  'secret',
  'credential',
]);

function scrubPayloadForOutbox(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_FIELD_NAMES.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface CartBridgeHandlersDeps {
  /** Returns the currently-authenticated operator session, or null. */
  getCurrentSession: () => OperatorSessionRecord | null;
  /**
   * #380 (F-007) — returns the pairing row's REAL terminal_id, or null when
   * unpaired. The cart row's `terminal_id` (carts.terminal_id, NOT NULL) is
   * stamped from this, NOT from `session.branch_id` (the retired F-007
   * shortcut). Required so a dropped wiring can't silently revert to the bug
   * (a branch_id fallback would be F-007 in disguise). Sourced in production
   * from `pairingStore.getCurrentTerminalId()` (sync, no token path).
   */
  getTerminalId: () => string | null;
  /**
   * Optional shared state — when set, this instance reuses the cart
   * store of the provided instance. Used by tests that swap sessions
   * mid-test while continuing to operate on the same cart store.
   */
  shareStateWith?: CartBridgeHandlers;
  /** Optional logger. Cart payload values are NEVER logged. */
  logger?: Logger;
  /**
   * Optional DB-backed cart store. When omitted, handlers fall back to
   * the in-memory Map (S1 mode). Production always supplies one.
   */
  cartStore?: CartStore;
  /**
   * Optional R7 seam. When omitted, defaults to a refusing stub.
   * Production wiring + tests inject a real resolver.
   */
  resolveItemRef?: ItemRefResolver;
  /** Optional clock for testability. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Optional audit emitter. Required for post-handoff cancel audit emission.
   * When omitted, pre-handoff void still works (no audit for cashier_voided).
   */
  auditEmitter?: AuditEmitter;
  /**
   * Where the cart's payment stands (`bindCartPaymentStatus`). A cart row
   * stays `frozen_handed_off` after settlement, so this is how main tells a
   * paid sale from an unpaid handoff: `cancelPostHandoff` refuses unless it
   * is `none`, and `snapshot` reports a settled cart as paid with no
   * envelope. Optional on the type so unrelated fixtures construct
   * unchanged, but both handlers FAIL CLOSED (`not_implemented`) without it,
   * and the production factory requires it.
   */
  cartPaymentStatus?: (cart_id: string) => CartPaymentStatus;
}

/**
 * The envelope as the renderer may see it: identical to the persisted one
 * except that manager attribution on discount placeholders is removed
 * (FR-021: manager identity never reaches the cashier UI). The persisted
 * envelope keeps it for audit and finalize.
 */
function rendererEnvelope(envelope: PaymentIntentEnvelope): Readonly<PaymentIntentEnvelope> {
  return freezeEnvelope({
    ...envelope,
    lines: envelope.lines.map((line) => ({ ...line })),
    discount_placeholders: envelope.discount_placeholders.map((dp) => ({
      ...dp,
      attribution_operator_id: null,
    })),
  });
}

/** Parses a persisted envelope; null when absent or unreadable (never throws). */
function parseEnvelope(json: string | null): PaymentIntentEnvelope | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Partial<PaymentIntentEnvelope>;
    if (!Array.isArray(env.lines) || !Array.isArray(env.discount_placeholders)) return null;
    return parsed as PaymentIntentEnvelope;
  } catch {
    return null;
  }
}

/**
 * Who approves a post-handoff cancel: a manager or admin approves their own;
 * a cashier needs a manager's attribution. `null` means attribution is
 * required and missing (the only case a cashier can reach via the bridge,
 * which drops attribution).
 */
function postHandoffApprover(
  session: Pick<OperatorSessionRecord, 'role' | 'operator_id'>,
  attributionOperatorId: string | undefined,
): string | null {
  if (session.role === 'manager' || session.role === 'admin') return session.operator_id;
  return attributionOperatorId !== undefined && attributionOperatorId !== ''
    ? attributionOperatorId
    : null;
}

/**
 * Why a (non-replay) post-handoff cancel cannot proceed, or null. Only a
 * `frozen_handed_off` cart qualifies, and the renderer-supplied handoff action
 * must be this cart's persisted handoff, so the audit record can never be
 * mislabelled.
 */
function postHandoffCancelRefusal(
  store: Pick<CartStore, 'findLatestHandoffActionId'>,
  cartState: CartState,
  req: { cart_id: string; handoff_action_id: string },
): CartRefusalReason | null {
  if (cartState !== CartState.frozen_handed_off) return 'closed';
  return store.findLatestHandoffActionId(req.cart_id) === req.handoff_action_id
    ? null
    : 'stale_version';
}

/** A recorded outbox row is a replay of THIS post-handoff cancel (same cart and handoff). */
function isSameCancelReplay(
  replay: { action_kind: string; cart_id: string; payload_json: string },
  req: { cart_id: string; handoff_action_id: string },
): boolean {
  return (
    replay.action_kind === 'cart.cancel.post_handoff' &&
    replay.cart_id === req.cart_id &&
    recordedHandoffAction(replay.payload_json) === req.handoff_action_id
  );
}

/** The handoff action recorded in a post-handoff cancel outbox payload. */
function recordedHandoffAction(payloadJson: string): unknown {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['handoff_action_id']
      : undefined;
  } catch {
    return undefined;
  }
}

function refuse(reason: CartRefusalReason): { kind: 'refused'; reason: CartRefusalReason } {
  return { kind: 'refused', reason };
}

type StoredCart = NonNullable<ReturnType<CartStore['getCart']>>;

/** Successful shared-gate payload for a mutating cart handler. */
interface MutableCartContext {
  session: OperatorSessionRecord;
  store: CartStore;
  cart: StoredCart;
}

/**
 * FR-016 quantity ops: increment/decrement default to delta 1; decrement
 * past zero and absolute zero delegate to line removal. Invalid deltas keep
 * the generic `stale_version` refusal posture.
 */
function computeUpdatedQuantity(
  req: CartLinesUpdateRequest,
  currentQuantity: number,
):
  | { kind: 'ok'; newQuantity: number }
  | { kind: 'remove' }
  | { kind: 'refused'; reason: CartRefusalReason } {
  if (req.op === 'increment') {
    const delta = req.delta ?? 1;
    if (!Number.isInteger(delta) || delta <= 0) return refuse('stale_version');
    return { kind: 'ok', newQuantity: currentQuantity + delta };
  }
  if (req.op === 'decrement') {
    const delta = req.delta ?? 1;
    if (!Number.isInteger(delta) || delta <= 0) return refuse('stale_version');
    const newQuantity = currentQuantity - delta;
    return newQuantity <= 0 ? { kind: 'remove' } : { kind: 'ok', newQuantity };
  }
  const abs = req.absolute;
  if (abs === undefined || !Number.isInteger(abs) || abs < 0) return refuse('stale_version');
  return abs === 0 ? { kind: 'remove' } : { kind: 'ok', newQuantity: abs };
}

export class CartBridgeHandlers {
  /** S1 fallback — used only when deps.cartStore is omitted. */
  private readonly inMemCarts: Map<string, InMemoryCartRecord>;
  private readonly deps: CartBridgeHandlersDeps;
  private readonly clock: () => Date;

  constructor(deps: CartBridgeHandlersDeps) {
    this.deps = deps;
    this.inMemCarts = deps.shareStateWith?.inMemCarts ?? new Map<string, InMemoryCartRecord>();
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  // ── cart.create ─────────────────────────────────────────────────────

  async create(req: CartCreateRequest): Promise<CartCreateResponse> {
    const gate = requireOperatorSession({
      session: this.deps.getCurrentSession(),
      allowedRoles: ['cashier', 'manager', 'admin'],
    });
    if (gate.kind !== 'ok') return refuse(gate.reason);

    const session = gate.session;

    // #380 (F-007) — resolve the REAL terminal_id before doing any work. An
    // unpaired terminal cannot stamp a cart row (carts.terminal_id is NOT
    // NULL); refuse `no_session` consistently with the payments/sales adapters
    // (which return a null session on unpaired) rather than persist a wrong
    // (branch_id) or null terminal_id.
    const terminal_id = this.deps.getTerminalId();
    if (terminal_id === null) return refuse('no_session');

    // Idempotency: replay-safe when a CartStore is wired.
    if (this.deps.cartStore !== undefined) {
      const existing = this.deps.cartStore.getOutboxRow(req.idempotency_key);
      if (existing !== undefined) {
        if (existing.action_kind !== 'cart.create') {
          return refuse('idempotency_payload_mismatch');
        }
        return Promise.resolve({ kind: 'ok', cart_id: existing.cart_id });
      }
    }

    const cart_id = randomUUID();
    const now = this.clock().toISOString();

    if (this.deps.cartStore !== undefined) {
      this.deps.cartStore.insertCartAndOutbox(
        {
          cart_id,
          tenant_id: session.tenant_id,
          branch_id: session.branch_id,
          // #380 (F-007) — the pairing row's REAL terminal_id, NOT
          // session.branch_id. Stamped for audit fidelity (cart events write
          // it into audit_events.originating_terminal_id, alongside the
          // payment events which now use the same value).
          terminal_id,
          owning_operator_id: session.operator_id,
          operator_session_id: session.id,
          state: CartState.empty,
          created_at: now,
          last_action_id: req.idempotency_key,
        },
        {
          action_id: req.idempotency_key,
          cart_id,
          line_id: null,
          action_kind: 'cart.create',
          acting_operator_id: session.operator_id,
          attribution_operator_id: null,
          operator_session_id: session.id,
          payload_json: JSON.stringify({}),
          applied_at: now,
        },
      );
    } else {
      this.inMemCarts.set(cart_id, {
        cart_id,
        operator_session_id: session.id,
        owning_operator_id: session.operator_id,
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        state: CartState.empty,
      });
    }

    this.deps.logger?.info({ event: 'cart.create.ok', cart_id }, 'cart.create');
    return Promise.resolve({ kind: 'ok', cart_id });
  }

  // ── cart.lines.add ──────────────────────────────────────────────────

  async linesAdd(req: CartLinesAddRequest): Promise<CartLinesAddResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    const { store } = gated;

    // Idempotency: replay-safe.
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) return this.replayLinesAdd(req, store, replay);

    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      return refuse('not_implemented'); // generic-refusal posture; bridge contract has no 'invalid_quantity' reason
    }

    // R7 seam — resolve item_ref to display_name + unit_price_minor snapshot.
    const resolver = this.deps.resolveItemRef ?? DEFAULT_ITEM_REF_RESOLVER;
    const resolved = await resolver(req.item_ref);
    if (resolved.kind !== 'ok') {
      // The bridge contract has no per-resolver reason; collapse to generic.
      return refuse('wrong_owner');
    }

    // Q4 merge path — application-layer uniqueness on (cart_id, item_ref) among active lines.
    const existing = store.findActiveLineByItemRef(req.cart_id, req.item_ref);
    const now = this.clock().toISOString();

    if (existing !== undefined) return this.mergeLineOnAdd(req, gated, existing, now);
    return this.insertNewLine(req, gated, resolved, now);
  }

  /** Replay path for linesAdd — returns the previously-applied result. */
  private replayLinesAdd(
    req: CartLinesAddRequest,
    store: CartStore,
    replay: NonNullable<ReturnType<CartStore['getOutboxRow']>>,
  ): CartLinesAddResponse {
    if (replay.action_kind !== 'cart.line.add' && replay.action_kind !== 'cart.line.merge') {
      return refuse('idempotency_payload_mismatch');
    }
    const replayLineId = replay.line_id;
    if (replayLineId === null) return refuse('idempotency_payload_mismatch');
    const replayLine = store.getLine(req.cart_id, replayLineId);
    if (replayLine === undefined) return refuse('idempotency_payload_mismatch');
    return {
      kind: 'ok',
      line_id: replayLineId,
      merged: replay.action_kind === 'cart.line.merge',
      version: replayLine.version,
      display_name: replayLine.display_name,
      unit_price_minor: replayLine.unit_price_minor,
      line_subtotal_minor: replayLine.line_subtotal_minor,
      quantity: replayLine.quantity,
    };
  }

  /** Q4 merge path — add quantity onto the existing active line for the item_ref. */
  private mergeLineOnAdd(
    req: CartLinesAddRequest,
    ctx: MutableCartContext,
    existing: NonNullable<ReturnType<CartStore['findActiveLineByItemRef']>>,
    now: string,
  ): CartLinesAddResponse {
    const newQuantity = existing.quantity + req.quantity;
    let newSubtotal: number;
    try {
      newSubtotal = computeLineSubtotal(newQuantity, existing.unit_price_minor);
    } catch (err) {
      if (err instanceof LineSubtotalError) return refuse('not_implemented');
      throw err;
    }
    ctx.store.mergeLineAndOutbox(
      {
        line_id: existing.line_id,
        quantity: newQuantity,
        line_subtotal_minor: newSubtotal,
        last_action_id: req.idempotency_key,
        updated_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id: existing.line_id,
        action_kind: 'cart.line.merge',
        acting_operator_id: ctx.session.operator_id,
        attribution_operator_id: null,
        operator_session_id: ctx.session.id,
        payload_json: JSON.stringify(
          scrubPayloadForOutbox({
            item_ref: req.item_ref,
            quantity_added: req.quantity,
          }),
        ),
        applied_at: now,
      },
    );
    return {
      kind: 'ok',
      line_id: existing.line_id,
      merged: true,
      version: existing.version + 1,
      display_name: existing.display_name,
      unit_price_minor: existing.unit_price_minor,
      line_subtotal_minor: newSubtotal,
      quantity: newQuantity,
    };
  }

  /** New-line path for linesAdd. */
  private insertNewLine(
    req: CartLinesAddRequest,
    ctx: MutableCartContext,
    resolved: { display_name: string; unit_price_minor: number },
    now: string,
  ): CartLinesAddResponse {
    let subtotal: number;
    try {
      subtotal = computeLineSubtotal(req.quantity, resolved.unit_price_minor);
    } catch (err) {
      if (err instanceof LineSubtotalError) return refuse('not_implemented');
      /* v8 ignore next */
      throw err;
    }
    const line_id = randomUUID();
    ctx.store.insertLineAndOutbox(
      {
        line_id,
        cart_id: req.cart_id,
        item_ref: req.item_ref,
        display_name: resolved.display_name,
        quantity: req.quantity,
        unit_price_minor: resolved.unit_price_minor,
        line_subtotal_minor: subtotal,
        note: null,
        last_action_id: req.idempotency_key,
        created_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id,
        action_kind: 'cart.line.add',
        acting_operator_id: ctx.session.operator_id,
        attribution_operator_id: null,
        operator_session_id: ctx.session.id,
        payload_json: JSON.stringify(
          scrubPayloadForOutbox({ item_ref: req.item_ref, quantity: req.quantity }),
        ),
        applied_at: now,
      },
    );
    return {
      kind: 'ok',
      line_id,
      merged: false,
      version: 1,
      display_name: resolved.display_name,
      unit_price_minor: resolved.unit_price_minor,
      line_subtotal_minor: subtotal,
      quantity: req.quantity,
    };
  }

  // ── cart.lines.update ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async linesUpdate(req: CartLinesUpdateRequest): Promise<CartLinesUpdateResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    const { session, store } = gated;

    // Idempotency replay (mirrors linesAdd).
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.line.update' && replay.action_kind !== 'cart.line.remove') {
        return refuse('idempotency_payload_mismatch');
      }
      const replayLine = store.getLine(req.cart_id, req.line_id);
      if (replayLine === undefined) return refuse('idempotency_payload_mismatch');
      return { kind: 'ok', version: replayLine.version };
    }

    const line = store.getLine(req.cart_id, req.line_id);
    if (line === undefined) return refuse('wrong_owner');
    if (line.removed_at !== null) return refuse('wrong_owner');
    if (line.version !== req.version) return refuse('stale_version');

    const qty = computeUpdatedQuantity(req, line.quantity);
    if (qty.kind === 'refused') return qty;
    if (qty.kind === 'remove') {
      // set(0) / decrement-past-zero → delegate to remove (FR-016).
      const r = this.removeLineInternal(req, session);
      if (r.kind !== 'ok') return r;
      return { kind: 'ok', version: line.version + 1 };
    }

    let newSubtotal: number;
    try {
      newSubtotal = computeLineSubtotal(qty.newQuantity, line.unit_price_minor);
    } catch (err) {
      if (err instanceof LineSubtotalError) return refuse('stale_version');
      /* v8 ignore next */
      throw err;
    }

    const now = this.clock().toISOString();
    store.updateLineQuantityAndOutbox(
      {
        line_id: req.line_id,
        quantity: qty.newQuantity,
        line_subtotal_minor: newSubtotal,
        last_action_id: req.idempotency_key,
        updated_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id: req.line_id,
        action_kind: 'cart.line.update',
        acting_operator_id: session.operator_id,
        attribution_operator_id: null,
        operator_session_id: session.id,
        payload_json: JSON.stringify(
          scrubPayloadForOutbox({ op: req.op, new_quantity: qty.newQuantity }),
        ),
        applied_at: now,
      },
    );
    return { kind: 'ok', version: line.version + 1 };
  }

  // ── cart.lines.remove ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async linesRemove(req: CartLinesRemoveRequest): Promise<CartLinesRemoveResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    return this.removeLineInternal(req, gated.session);
  }

  private removeLineInternal(
    keys: { cart_id: string; line_id: string; version: number; idempotency_key: string },
    session: OperatorSessionRecord,
  ): { kind: 'ok' } | { kind: 'refused'; reason: CartRefusalReason } {
    const store = this.deps.cartStore;
    if (store === undefined) return refuse('not_implemented');

    const replay = store.getOutboxRow(keys.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.line.remove') {
        return refuse('idempotency_payload_mismatch');
      }
      return { kind: 'ok' };
    }

    const line = store.getLine(keys.cart_id, keys.line_id);
    if (line === undefined) return refuse('wrong_owner');
    if (line.removed_at !== null) {
      // Replay-equivalent: line already removed; idempotent no-op.
      return { kind: 'ok' };
    }
    if (line.version !== keys.version) return refuse('stale_version');

    const now = this.clock().toISOString();
    store.softRemoveLineAndOutbox(
      {
        line_id: keys.line_id,
        removed_at: now,
        last_action_id: keys.idempotency_key,
      },
      {
        action_id: keys.idempotency_key,
        cart_id: keys.cart_id,
        line_id: keys.line_id,
        action_kind: 'cart.line.remove',
        acting_operator_id: session.operator_id,
        attribution_operator_id: null,
        operator_session_id: session.id,
        payload_json: JSON.stringify({}),
        applied_at: now,
      },
    );
    return { kind: 'ok' };
  }

  // ── cart.lines.setNote ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async linesSetNote(req: CartLinesSetNoteRequest): Promise<CartLinesSetNoteResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    const { session, store } = gated;

    // Idempotency replay.
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.line.note_set')
        return refuse('idempotency_payload_mismatch');
      const replayLine = store.getLine(req.cart_id, req.line_id);
      if (replayLine === undefined) return refuse('idempotency_payload_mismatch');
      return { kind: 'ok', version: replayLine.version };
    }

    // Length cap (Q1: ≤200 chars). Partial overwrite is forbidden — full
    // replacement only. Bridge enforces; column is intentionally permissive.
    if (req.note !== null && req.note.length > 200) {
      return refuse('note_too_long');
    }

    // Forbidden-pattern check.
    if (req.note !== null && noteHasForbiddenPattern(req.note)) {
      return refuse('note_forbidden_pattern');
    }

    const line = store.getLine(req.cart_id, req.line_id);
    if (line === undefined) return refuse('wrong_owner');
    if (line.removed_at !== null) return refuse('wrong_owner');
    if (line.version !== req.version) return refuse('stale_version');

    const now = this.clock().toISOString();
    store.setLineNoteAndOutbox(
      {
        line_id: req.line_id,
        note: req.note,
        last_action_id: req.idempotency_key,
        updated_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id: req.line_id,
        action_kind: 'cart.line.note_set',
        acting_operator_id: session.operator_id,
        attribution_operator_id: null,
        operator_session_id: session.id,
        // NOTE: bridge MUST NOT echo the note value into payload_json.
        // The redaction set (T054) is the load-bearing layer; here we
        // intentionally store only the length, never the content.
        payload_json: JSON.stringify({ note_length: req.note?.length ?? 0 }),
        applied_at: now,
      },
    );
    return { kind: 'ok', version: line.version + 1 };
  }

  // ── cart.discountPlaceholders.* ─────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async discountPlaceholdersAdd(
    req: CartDiscountPlaceholdersAddRequest,
  ): Promise<CartDiscountPlaceholdersAddResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    const { session, store, cart } = gated;

    // Threshold: percent_NN where NN > 10 is above-threshold.
    const pctMatch = /^percent_(\d+)$/.exec(req.placeholder_kind);
    const pctDigits = pctMatch?.[1] ?? null;
    const isAboveThreshold = pctDigits !== null && parseInt(pctDigits, 10) > 10;

    if (isAboveThreshold) {
      // Attribution must be present and must not be the acting cashier.
      if (!req.attribution_operator_id || req.attribution_operator_id === session.operator_id) {
        return refuse('manager_attribution_required');
      }
    }

    // Narrowed after the guard above — safe to use without assertion in the isAboveThreshold branch.
    const attributionOperatorId = req.attribution_operator_id ?? null;

    // Idempotency: the idempotency_key doubles as placeholder_id.
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.discount_placeholder.add')
        return refuse('idempotency_payload_mismatch');
      return {
        kind: 'ok',
        placeholder_id: req.idempotency_key,
        requires_manager_attribution: isAboveThreshold,
      };
    }

    const now = this.clock().toISOString();
    const placeholder: InsertDiscountPlaceholderInput = {
      placeholder_id: req.idempotency_key,
      cart_id: req.cart_id,
      line_id: req.line_id,
      placeholder_kind: req.placeholder_kind,
      requires_manager_attribution: isAboveThreshold ? 1 : 0,
      attribution_operator_id: attributionOperatorId,
      created_at: now,
    };

    const outboxRow = {
      action_id: req.idempotency_key,
      cart_id: req.cart_id,
      line_id: req.line_id,
      action_kind: 'cart.discount_placeholder.add' as const,
      acting_operator_id: session.operator_id,
      attribution_operator_id: null as string | null,
      operator_session_id: session.id,
      payload_json: JSON.stringify({ cart_id: req.cart_id, cart_line_id: req.line_id }),
      applied_at: now,
    };

    if (isAboveThreshold && attributionOperatorId !== null) {
      const event_id = randomUUID();
      store.insertDiscountPlaceholderAndOutbox(
        placeholder,
        { ...outboxRow, attribution_operator_id: attributionOperatorId },
        () => {
          this.deps.auditEmitter?.emit({
            event_id,
            tenant_id: cart.tenant_id,
            branch_id: cart.branch_id,
            originating_terminal_id: cart.terminal_id,
            acting_operator_id: session.operator_id,
            session_id: session.id,
            shift_id: null,
            action_category: 'cart.discount.above_threshold',
            created_at: now,
            approving_supervisor_id: attributionOperatorId,
            payload: { cart_id: req.cart_id, cart_line_id: req.line_id },
          });
        },
      );
    } else {
      store.insertDiscountPlaceholderAndOutbox(placeholder, outboxRow);
    }

    return {
      kind: 'ok',
      placeholder_id: req.idempotency_key,
      requires_manager_attribution: isAboveThreshold,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async discountPlaceholdersRemove(
    req: CartDiscountPlaceholdersRemoveRequest,
  ): Promise<CartDiscountPlaceholdersRemoveResponse> {
    const gated = this.resolveMutableCart(req.cart_id);
    if (gated.kind !== 'ok') return gated;
    const { session, store } = gated;

    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.discount_placeholder.remove')
        return refuse('idempotency_payload_mismatch');
      return { kind: 'ok' };
    }

    const placeholder = store.getDiscountPlaceholder(req.placeholder_id);
    if (placeholder === undefined) return refuse('wrong_owner');

    const now = this.clock().toISOString();
    store.removeDiscountPlaceholderAndOutbox(req.placeholder_id, {
      action_id: req.idempotency_key,
      cart_id: req.cart_id,
      line_id: placeholder.line_id,
      action_kind: 'cart.discount_placeholder.remove',
      acting_operator_id: session.operator_id,
      attribution_operator_id: null,
      operator_session_id: session.id,
      payload_json: JSON.stringify({ cart_id: req.cart_id, placeholder_id: req.placeholder_id }),
      applied_at: now,
    });

    return { kind: 'ok' };
  }

  // ── cart.void ───────────────────────────────────────────────────────

  /**
   * T067 — Pre-handoff void (any role, no audit).
   * Post-handoff cancel is `cancelPostHandoff` below.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async void(req: CartVoidRequest): Promise<CartVoidResponse> {
    const session = this.deps.getCurrentSession();
    if (session === null) return refuse('no_session');

    if (this.deps.cartStore === undefined) {
      const guard = this.gateMutatingInMem(req.cart_id);
      return guard ?? refuse('not_implemented');
    }

    const store = this.deps.cartStore;
    const cart = store.getCart(req.cart_id);
    if (cart === undefined) return refuse('wrong_owner');

    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
    });
    if (gate.kind !== 'ok') return refuse(gate.reason);

    // Idempotency check before terminal state — replaying after cancel succeeds.
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.void') return refuse('idempotency_payload_mismatch');
      return { kind: 'ok' };
    }

    // Terminal states (after idempotency so replays work on closed carts).
    const cartState = cart.state as CartState;
    if (cartState === CartState.frozen_handed_off) return refuse('frozen');
    if (cartState === CartState.cancelled) return refuse('closed');

    const now = this.clock().toISOString();
    store.cancelCartAndOutbox(
      {
        cart_id: req.cart_id,
        cancelled_at: now,
        cancellation_reason: 'cashier_voided',
        last_action_id: req.idempotency_key,
        updated_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id: null,
        action_kind: 'cart.void',
        acting_operator_id: session.operator_id,
        attribution_operator_id: req.attribution_operator_id ?? null,
        operator_session_id: session.id,
        payload_json: JSON.stringify(scrubPayloadForOutbox({ cart_id: req.cart_id })),
        applied_at: now,
      },
    );
    return { kind: 'ok' };
  }

  // ── cart.cancelPostHandoff ──────────────────────────────────────────

  /**
   * T067 — Post-handoff cancel (manager/admin or cashier+attribution).
   * Emits a `cart.cancel.post_handoff` audit event atomically with the
   * cancellation (FR-031/FR-033). The cart must be in `frozen_handed_off`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelPostHandoff(req: {
    cart_id: string;
    handoff_action_id: string;
    attribution_operator_id?: string;
    idempotency_key: string;
  }): Promise<{ kind: 'ok' } | { kind: 'refused'; reason: CartRefusalReason }> {
    const session = this.deps.getCurrentSession();
    if (session === null) return refuse('no_session');

    if (this.deps.cartStore === undefined) return refuse('not_implemented');

    const store = this.deps.cartStore;
    const cart = store.getCart(req.cart_id);
    if (cart === undefined) return refuse('wrong_owner');

    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
    });
    if (gate.kind !== 'ok') return refuse(gate.reason);

    // Cashier must supply attribution; manager/admin may act directly.
    const approvingSupervisorId = postHandoffApprover(session, req.attribution_operator_id);
    if (approvingSupervisorId === null) return refuse('manager_attribution_required');

    // Without the payments record main cannot tell a paid sale from an unpaid
    // handoff, so refuse rather than guess.
    const paymentStatus = this.deps.cartPaymentStatus;
    if (paymentStatus === undefined) return refuse('not_implemented');

    // Idempotency replay before the terminal-state guard, bound to the SAME
    // cart and handoff: a key reused for another cart must never report a
    // cancel that did not happen.
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      return isSameCancelReplay(replay, req)
        ? { kind: 'ok' }
        : refuse('idempotency_payload_mismatch');
    }

    const precondition = postHandoffCancelRefusal(store, cart.state as CartState, req);
    if (precondition !== null) return refuse(precondition);

    const now = this.clock().toISOString();
    const event_id = randomUUID();

    const cancelled = store.cancelFrozenCartAndOutbox(
      {
        cart_id: req.cart_id,
        cancelled_at: now,
        cancellation_reason: 'manager_voided_post_handoff',
        last_action_id: req.idempotency_key,
        updated_at: now,
      },
      {
        action_id: req.idempotency_key,
        cart_id: req.cart_id,
        line_id: null,
        action_kind: 'cart.cancel.post_handoff',
        acting_operator_id: session.operator_id,
        attribution_operator_id: req.attribution_operator_id ?? null,
        operator_session_id: session.id,
        payload_json: JSON.stringify(
          scrubPayloadForOutbox({
            cart_id: req.cart_id,
            handoff_action_id: req.handoff_action_id,
          }),
        ),
        applied_at: now,
      },
      // Inside the transaction: a started, settled or force-failed payment
      // closes the sale to cancellation.
      () => paymentStatus(req.cart_id) === 'none',
      () => {
        this.deps.auditEmitter?.emit({
          event_id,
          tenant_id: cart.tenant_id,
          branch_id: cart.branch_id,
          originating_terminal_id: cart.terminal_id,
          acting_operator_id: cart.owning_operator_id,
          session_id: session.id,
          shift_id: null,
          action_category: 'cart.cancel.post_handoff',
          created_at: now,
          approving_supervisor_id: approvingSupervisorId,
          payload: {
            cart_id: req.cart_id,
            handoff_action_id: req.handoff_action_id,
          },
        });
      },
    );
    return cancelled ? { kind: 'ok' } : refuse('closed');
  }

  // ── cart.handoff ────────────────────────────────────────────────────

  /**
   * T086 — 7-step handoff construction algorithm.
   *
   * Step 1: requireOperatorSession (no_session gate)
   * Step 2: ownership + tenant + role check (no mutable guard yet)
   * Step 3: idempotency replay (allowed even for frozen carts)
   * Step 4: mutable-state guard (requireMutable: true)
   * Step 5: T088 handing_off freeze guard
   * Step 6: per_line_versions staleness check
   * Step 7: build PaymentIntentEnvelope via builder
   * Step 8: atomic transaction (outbox + freeze + persist + audit)
   * Step 9: return frozen envelope
   *
   * SECURITY: Envelope contains no session credentials, PINs, or secrets.
   * Do NOT claim payment succeeded — this only freezes the cart.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async handoff(req: CartHandoffRequest): Promise<CartHandoffResponse> {
    // Step 1 — session gate.
    const session = this.deps.getCurrentSession();
    if (session === null) return refuse('no_session');

    if (this.deps.cartStore === undefined) {
      const guard = this.gateMutatingInMem(req.cart_id);
      return guard ?? refuse('not_implemented');
    }

    const store = this.deps.cartStore;
    const cart = store.getCart(req.cart_id);
    if (cart === undefined) return refuse('wrong_owner');

    // Step 2 — ownership, role, tenant isolation (without requireMutable — idempotency
    // replay must be allowed even for already-frozen carts, so we defer the mutable guard).
    const ownershipGate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
    });
    if (ownershipGate.kind !== 'ok') return refuse(ownershipGate.reason);

    // Step 3 — idempotency replay (before mutable guard so frozen carts can replay).
    const replay = store.getOutboxRow(req.idempotency_key);
    if (replay !== undefined) {
      if (replay.action_kind !== 'cart.handoff_to_payment') {
        return refuse('idempotency_payload_mismatch');
      }
      const persistedJson = store.getCart(req.cart_id)?.handoff_envelope_json;
      if (persistedJson !== null && persistedJson !== undefined) {
        const parsed = JSON.parse(persistedJson) as Parameters<typeof freezeEnvelope>[0];
        return { kind: 'ok', envelope: rendererEnvelope(parsed) };
      }
      /* v8 ignore next — outbox row written but envelope_json null: impossible under atomic tx */
      return refuse('not_implemented');
    }

    // Step 4 — mutable-state guard (after idempotency, so replay always works).
    const mutabilityGate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
      requireMutable: true,
    });
    if (mutabilityGate.kind !== 'ok') return refuse(mutabilityGate.reason);

    // T088 freeze guard: defence-in-depth — requireMutable doesn't block handing_off.
    if ((cart.state as CartState) === CartState.handing_off) return refuse('frozen');

    // Step 5 — per_line_versions staleness check.
    for (const { line_id, version } of req.per_line_versions) {
      const line = store.getLine(req.cart_id, line_id);
      if (line === undefined || line.removed_at !== null) return refuse('stale_version');
      if (line.version !== version) return refuse('stale_version');
    }

    const now = this.clock().toISOString();
    const handoff_action_id = req.idempotency_key;

    // Step 6 — build the PaymentIntentEnvelope.
    const built = buildPaymentIntentEnvelope({
      cart_id: req.cart_id,
      handoff_action_id,
      session,
      terminal_id: cart.terminal_id,
      tenant_id: cart.tenant_id,
      branch_id: cart.branch_id,
      created_at: now,
      store,
    });

    if (built.kind === 'empty_cart') return refuse('empty_cart');
    if (built.kind === 'subtotal_unsafe') return refuse('not_implemented');

    const { envelope } = built;
    const envelopeJson = JSON.stringify(envelope);
    const event_id = randomUUID();

    // Step 7 — atomic transaction: outbox + cart freeze + audit.
    store.handoffCartAndOutbox(
      {
        cart_id: req.cart_id,
        frozen_at: now,
        handoff_envelope_json: envelopeJson,
        last_action_id: handoff_action_id,
        updated_at: now,
      },
      {
        action_id: handoff_action_id,
        cart_id: req.cart_id,
        line_id: null,
        action_kind: 'cart.handoff_to_payment',
        acting_operator_id: session.operator_id,
        attribution_operator_id: null,
        operator_session_id: session.id,
        payload_json: JSON.stringify(
          scrubPayloadForOutbox({
            cart_id: req.cart_id,
            handoff_action_id,
            line_count: built.line_count,
            subtotal_minor: envelope.subtotal_minor,
          }),
        ),
        applied_at: now,
      },
      () => {
        this.deps.auditEmitter?.emit({
          event_id,
          tenant_id: cart.tenant_id,
          branch_id: cart.branch_id,
          originating_terminal_id: cart.terminal_id,
          acting_operator_id: session.operator_id,
          session_id: session.id,
          shift_id: null,
          action_category: 'cart.handoff_to_payment',
          created_at: now,
          approving_supervisor_id: null,
          payload: {
            cart_id: req.cart_id,
            handoff_action_id,
            line_count: built.line_count,
            subtotal_minor: envelope.subtotal_minor,
          },
        });
      },
    );

    // Step 8 — return the frozen envelope, without manager attribution.
    return { kind: 'ok', envelope: rendererEnvelope(envelope) };
  }

  // ── cart.subscribe ──────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(_req: CartSubscribeRequest): Promise<CartSubscribeResponse> {
    const gate = requireOperatorSession({
      session: this.deps.getCurrentSession(),
      allowedRoles: ['cashier', 'manager', 'admin'],
    });
    if (gate.kind !== 'ok') return Promise.resolve(refuse(gate.reason));
    return Promise.resolve(refuse('not_implemented'));
  }

  // ── cart.snapshot ───────────────────────────────────────────────────

  /**
   * V5 active cart read. READ-ONLY: no outbox row, no audit event, no write.
   *
   * 1. `requireOperatorSession` first (AD-1) — no session / role → refuse.
   * 2. The cart is looked up by the renderer-held `cart_id` only; scope is
   *    NEVER taken from the request.
   * 3. The same ownership/tenant gate every cart handler applies (cashier:
   *    own session only; manager/admin: same tenant+branch), WITHOUT
   *    `requireMutable`, so frozen and cancelled carts stay readable.
   * 4. Returns the display-safe projection: active lines as persisted,
   *    opaque discount placeholder refs, and the persisted envelope only for
   *    a handed-off cart.
   */
  snapshot(req: CartSnapshotRequest): Promise<CartSnapshotResponse> {
    const gate = requireOperatorSession({
      session: this.deps.getCurrentSession(),
      allowedRoles: ['cashier', 'manager', 'admin'],
    });
    if (gate.kind !== 'ok') return Promise.resolve(refuse(gate.reason));

    const store = this.deps.cartStore;
    if (store === undefined) return Promise.resolve(refuse('not_implemented'));

    const cart = store.getCart(req.cart_id);
    if (cart === undefined) return Promise.resolve(refuse('wrong_owner'));

    const ownership = requireOperatorSession({
      session: gate.session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
    });
    if (ownership.kind !== 'ok') return Promise.resolve(refuse(ownership.reason));

    const state = cart.state as CartState;
    const payable =
      state === CartState.frozen_handed_off
        ? this.frozenCartPayment(cart.cart_id, cart.handoff_envelope_json)
        : { paid: false, envelope: null };
    if (payable === null) return Promise.resolve(refuse('not_implemented'));
    const { paid, envelope } = payable;

    this.deps.logger?.info({ event: 'cart.snapshot.ok', cart_id: cart.cart_id }, 'cart.snapshot');
    return Promise.resolve({
      kind: 'ok',
      snapshot: {
        cart_id: cart.cart_id,
        state,
        lines: store.getActiveLines(cart.cart_id).map((line) => ({
          line_id: line.line_id,
          display_name: line.display_name,
          quantity: line.quantity,
          unit_price_minor: line.unit_price_minor,
          line_subtotal_minor: line.line_subtotal_minor,
          note: line.note,
          version: line.version,
        })),
        discount_placeholders: store
          .getDiscountPlaceholdersForCart(cart.cart_id)
          .map((dp) => ({ placeholder_id: dp.placeholder_id, line_id: dp.line_id })),
        paid,
        envelope,
      },
    });
  }

  /**
   * Payment view of a handed-off cart for `snapshot`. A settled cart is a
   * completed sale: `paid` and no payable envelope, so it can never be offered
   * to payment again. `null` (refuse generically) when the payments record is
   * not wired or the persisted envelope is unreadable — never parse text.
   */
  private frozenCartPayment(
    cart_id: string,
    envelopeJson: string | null,
  ): { paid: boolean; envelope: Readonly<PaymentIntentEnvelope> | null } | null {
    const paymentStatus = this.deps.cartPaymentStatus;
    if (paymentStatus === undefined) return null;
    if (paymentStatus(cart_id) === 'settled') return { paid: true, envelope: null };
    const persisted = parseEnvelope(envelopeJson);
    return persisted === null ? null : { paid: false, envelope: rendererEnvelope(persisted) };
  }

  // ── Internal gates ──────────────────────────────────────────────────

  /** S1-compat: in-memory cart map gate (used when no DB cartStore). */
  private gateMutatingInMem(
    cart_id: string,
  ): { kind: 'refused'; reason: CartRefusalReason } | null {
    const session = this.deps.getCurrentSession();
    if (session === null) return refuse('no_session');
    const cart = this.inMemCarts.get(cart_id);
    if (cart === undefined) return refuse('wrong_owner');
    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state,
      },
      requireMutable: true,
    });
    if (gate.kind !== 'ok') return refuse(gate.reason);
    return null;
  }

  /**
   * Shared trust-boundary preamble for the mutating line/discount handlers
   * (AD-1): live session → S1 in-mem fallback gate → cart lookup →
   * role/ownership/mutability gate → handing_off freeze.
   */
  private resolveMutableCart(
    cart_id: string,
  ): { kind: 'refused'; reason: CartRefusalReason } | ({ kind: 'ok' } & MutableCartContext) {
    const session = this.deps.getCurrentSession();
    if (session === null) return refuse('no_session');

    if (this.deps.cartStore === undefined) {
      // S1-compat path: gate then refuse not_implemented.
      const guard = this.gateMutatingInMem(cart_id);
      return guard ?? refuse('not_implemented');
    }

    const store = this.deps.cartStore;
    const cart = store.getCart(cart_id);
    if (cart === undefined) return refuse('wrong_owner');

    const gate = requireOperatorSession({
      session,
      allowedRoles: ['cashier', 'manager', 'admin'],
      cart: {
        operator_session_id: cart.operator_session_id,
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        state: cart.state as CartState,
      },
      requireMutable: true,
    });
    if (gate.kind !== 'ok') return refuse(gate.reason);
    if ((cart.state as CartState) === CartState.handing_off) return refuse('frozen');

    return { kind: 'ok', session, store, cart };
  }
}
