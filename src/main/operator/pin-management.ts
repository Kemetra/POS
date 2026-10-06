/**
 * 004-operator-session T072 + T073 — PIN management handler.
 *
 * T072: `resetCashierPin` — manager/admin-attributable PIN reset for a
 *   cashier on this terminal. Writes a fresh Argon2id hash+salt, resets
 *   lockout state, emits `cashier.pin.reset` audit event.
 *
 * T073: `unlockCashier` — manager/admin-attributable unlock of a
 *   locked-out cashier. Resets lockout state, emits `cashier.pin.unlock`
 *   audit event. Does NOT accept a PIN field.
 *
 * Security invariants (PR-1 / FR-030):
 *   - `new_pin` is consumed here and never passed to the logger,
 *     never stored as plaintext, never appears in thrown errors.
 *   - No JWT, device_token, device_token_attestation, or Clerk credential
 *     is logged or returned to the renderer. The provision path reads the
 *     manager's JWT from the operator JWT holder and hands it only to
 *     `backend.listRoster` (RT-214).
 *   - Audit payloads contain only allowlisted identifiers — no PIN values,
 *     no hashes, no credential fragments.
 *
 * Role gate (AD-1): `requireRole` is the first executable call in each
 * public method. A cashier session calling either method returns
 * `role_mismatch` generically.
 *
 * PR-4 per-terminal scope: `cashier_pin_records` rows are keyed by
 * `(tenant_id, branch_id, terminal_id, cashier_clerk_user_id)`. The scope
 * comes from the paired terminal's device-token state, never from the
 * renderer (Constitution VII).
 */

import type { Logger } from 'pino';

import type {
  ProvisionCashierPinRequest,
  ProvisionCashierPinResponse,
  ResetCashierPinRequest,
  ResetCashierPinResponse,
  UnlockCashierRequest,
  UnlockCashierResponse,
} from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';
import { OperatorRefusalError } from '../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import type { PairingStore } from '../pairing/store.js';
import type { SessionManager, OperatorSessionRecord } from './session-manager.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { BackendClient, BackendRosterResponse } from './backend-client.js';
import type { JwtHolder } from './jwt-holder.js';
import { requireRole } from './role-enforcement.js';
import { hashPin } from './pin-credential.js';
import { sealPinMaterial } from './pin-seal.js';
import type {
  CashierPinProvisionedPayload,
  CashierPinResetPayload,
  CashierPinUnlockPayload,
} from '../../shared/audit/payload-schemas.js';

// ─── PIN validation ────────────────────────────────────────────────────────

const PIN_RE = /^\d{4,6}$/;

function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

// ─── DB row shape ─────────────────────────────────────────────────────────

interface PinRecordRow {
  failed_attempt_count: number;
  lockout_until: string | null;
}

type PrepareRun = { run(...p: unknown[]): unknown };
type PrepareGet = { get(...p: unknown[]): PinRecordRow | undefined };

// ─── Refusal sentinels ────────────────────────────────────────────────────

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_STATE_INVALID: OperatorRefusal = { kind: 'refused', category: 'state_invalid' };
const REFUSE_NOT_READY: OperatorRefusal = { kind: 'refused', category: 'not_ready' };
const REFUSE_NO_CONNECTION: OperatorRefusal = { kind: 'refused', category: 'no_connection' };
const REFUSE_NOT_SIGNED_IN: OperatorRefusal = { kind: 'refused', category: 'not_signed_in' };
const REFUSE_ROLE_MISMATCH: OperatorRefusal = { kind: 'refused', category: 'role_mismatch' };

/**
 * RT-214 — a roster answer that is not a roster, mapped to an existing refusal:
 *   - no_token / 401 → not_signed_in: the manager's operator-identity JWT is
 *     absent, expired or rejected; signing in again mints a fresh one.
 *   - 403 → role_mismatch: Backend-Core says the caller is not manager-eligible
 *     (RT-150). The contract answers 401 for this today; 403 is defensive.
 *   - no_connection → no_connection; any other refusal → invalid_input (as before).
 */
function rosterRefusal(
  roster: Exclude<BackendRosterResponse, { kind: 'roster' }>,
): OperatorRefusal {
  switch (roster.kind) {
    case 'no_connection':
      return REFUSE_NO_CONNECTION;
    case 'no_token':
    case 'unauthenticated':
      return REFUSE_NOT_SIGNED_IN;
    case 'forbidden':
      return REFUSE_ROLE_MISMATCH;
    case 'refused':
      return REFUSE_INVALID;
  }
}

// ─── Dependencies ─────────────────────────────────────────────────────────

export interface PinManagementHandlerDeps {
  db: DatabaseHandle;
  safeStorage: SafeStorageLike;
  sessionManager: SessionManager;
  pairingStore: PairingStore;
  auditEmitter: AuditEmitter;
  /**
   * 019 — roster source for the provision path. `provisionCashierPin` resolves
   * the request's `target_cashier_id` (the roster `id`) to the cashier's
   * roster entry (to read the provider-neutral `user_id` the row is keyed on). The
   * neutral↔clerk mapping is resolved main-side and NEVER crosses the bridge.
   */
  backend: BackendClient;
  /**
   * RT-214 — the operator JWT holder (`operatorJwtHolder` in `index.ts`), keyed
   * on `backend_session_id`. The roster route is `operator-identity` + manager
   * gated on Backend-Core, so the provision path presents the signed-in
   * manager's JWT, exactly as sign-out and stuck-shifts do. Never logged,
   * never returned over IPC.
   */
  jwtHolder: Pick<JwtHolder, 'get'>;
  /** Optional logger. Tests omit it. */
  logger?: Logger;
}

// ─── Handler ──────────────────────────────────────────────────────────────

export class PinManagementHandler {
  constructor(private readonly deps: PinManagementHandlerDeps) {}

  /**
   * T072 — manager/admin PIN reset for a cashier on this terminal.
   *
   * Validates role, PIN shape, and cashier existence; hashes and seals
   * the new PIN; upserts the cashier_pin_records row (creates or
   * overwrites); resets lockout state; emits cashier.pin.reset audit event.
   */
  async resetCashierPin(
    req: ResetCashierPinRequest,
  ): Promise<ResetCashierPinResponse | OperatorRefusal> {
    const session = this.deps.sessionManager.getCurrent();

    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      if (err instanceof OperatorRefusalError) {
        this.log('info', 'reset_cashier_pin.refused', err.category);
        return { kind: 'refused', category: err.category };
      }
      this.log('info', 'reset_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }
    // requireRole throws on null session — safe to narrow here.
    const activeSession = session as OperatorSessionRecord;

    // Input validation — generic refusal; never echo the rejected value
    if (
      typeof req.event_id !== 'string' ||
      req.event_id.length === 0 ||
      typeof req.target_cashier_id !== 'string' ||
      req.target_cashier_id.length === 0 ||
      typeof req.new_pin !== 'string' ||
      !isValidPin(req.new_pin)
    ) {
      this.log('info', 'reset_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const pairingStatus = await this.deps.pairingStore.getStatus();
    if (pairingStatus.kind !== 'paired') {
      this.log('info', 'reset_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const { tenant_id, branch_id, terminal_id } = pairingStatus;
    const { target_cashier_id } = req;

    // Verify the cashier has an existing pin record on this terminal.
    // If no record exists, the manager cannot reset an uninitialized PIN
    // (the cashier must be onboarded first — invalid_input).
    const existing = (
      this.deps.db.prepare(
        `SELECT failed_attempt_count, lockout_until
           FROM cashier_pin_records
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as PrepareGet
    ).get(tenant_id, branch_id, terminal_id, target_cashier_id);

    if (existing === undefined) {
      this.log('info', 'reset_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    // Hash the new PIN — plaintext is consumed here and never stored.
    const raw = await hashPin(req.new_pin);
    const sealed = sealPinMaterial(raw, this.deps.safeStorage);

    // Upsert: overwrite hash/salt, reset lockout state.
    (
      this.deps.db.prepare(
        `UPDATE cashier_pin_records
            SET pin_hash = ?, pin_salt = ?,
                failed_attempt_count = 0, lockout_until = NULL,
                created_by_operator_id = ?
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as PrepareRun
    ).run(
      sealed.pin_hash,
      sealed.pin_salt,
      activeSession.operator_id,
      tenant_id,
      branch_id,
      terminal_id,
      target_cashier_id,
    );

    // Emit audit event — PIN value MUST NOT appear in payload (PR-1).
    const payload: CashierPinResetPayload = {
      target_cashier_id,
      terminal_id,
    };

    this.deps.auditEmitter.emit({
      event_id: req.event_id,
      tenant_id,
      branch_id,
      originating_terminal_id: terminal_id,
      acting_operator_id: activeSession.operator_id,
      session_id: activeSession.id,
      shift_id: null,
      action_category: 'cashier.pin.reset',
      created_at: new Date().toISOString(),
      approving_supervisor_id: null,
      payload,
    });

    this.log('info', 'reset_cashier_pin.success', undefined);
    return { kind: 'pin_reset', audit_event_id: req.event_id };
  }

  /**
   * 019 — manager/admin FIRST-PIN provisioning (create path) for a cashier on
   * this terminal.
   *
   * Distinct from `resetCashierPin` (which overwrites an EXISTING secret): this
   * CREATES the row where none exists, born keyed on the provider-neutral
   * `user_id` (028 §16), never the Clerk subject (Constitution VIII — advanced).
   *
   * Flow (data-model.md §"State transitions"):
   *   1. role-gate (manager/admin) — FIRST executable call (AD-1).
   *   2. validate event_id + PIN shape — generic refusal, value never echoed.
   *   3. resolve scope from pairing state (never the renderer — Constitution VII).
   *   4. fetch the branch roster; find the entry whose `id` === target_cashier_id (RT-235),
   *      then read its provider-neutral `user_id`.
   *      The roster is the only source of the neutral↔clerk mapping needed for
   *      both the legacy create-only check and the NOT-NULL clerk PK column.
   *        • no entry carries that user_id → `not_ready` (FR-11; covers the
   *          pre-DP-2 "no user_ids at all" state). NO fallback to a clerk key.
   *        • roster unreachable → `no_connection` (truthful; provisioning is
   *          an online manager action).
   *   5. create-only guard: a row already exists for (scope, cashier) on EITHER
   *      key column (a born-neutral `user_id` row OR a legacy clerk-keyed row)
   *      → `state_invalid` (FR-5). 019 never duplicates, never replaces a
   *      secret, never upgrades a legacy row in place (that is 017's boundary).
   *   6. hash + seal (same order as reset) → INSERT keyed on `user_id`, ALSO
   *      writing `cashier_clerk_user_id` (the current PK column) so the row is
   *      valid today AND born ready for 017's re-key (SC-2). failed=0, lockout=null.
   *   7. emit `cashier.pin.provisioned` (secret-free) → return `pin_provisioned`.
   */
  async provisionCashierPin(
    req: ProvisionCashierPinRequest,
  ): Promise<ProvisionCashierPinResponse | OperatorRefusal> {
    const session = this.deps.sessionManager.getCurrent();

    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      if (err instanceof OperatorRefusalError) {
        this.log('info', 'provision_cashier_pin.refused', err.category);
        return { kind: 'refused', category: err.category };
      }
      this.log('info', 'provision_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }
    // requireRole throws on null session — safe to narrow here.
    const activeSession = session as OperatorSessionRecord;

    // Input validation — generic refusal; never echo the rejected value.
    if (
      typeof req.event_id !== 'string' ||
      req.event_id.length === 0 ||
      typeof req.target_cashier_id !== 'string' ||
      req.target_cashier_id.length === 0 ||
      typeof req.initial_pin !== 'string' ||
      !isValidPin(req.initial_pin)
    ) {
      this.log('info', 'provision_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const pairingStatus = await this.deps.pairingStore.getStatus();
    if (pairingStatus.kind !== 'paired') {
      this.log('info', 'provision_cashier_pin.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const { tenant_id, branch_id, terminal_id } = pairingStatus;
    const { target_cashier_id } = req;

    // RT-214: the roster route needs the manager's operator-identity JWT. With
    // none held for this session, refuse before any request goes out.
    const jwt = this.deps.jwtHolder.get(activeSession.backend_session_id) ?? '';
    if (jwt === '') {
      this.log('info', 'provision_cashier_pin.refused', 'not_signed_in');
      return REFUSE_NOT_SIGNED_IN;
    }

    // Resolve the cashier's roster entry by provider-neutral user_id. This is
    // the ONLY source of the user_id→clerk mapping required by both the legacy
    // create-only check and the NOT-NULL clerk PK column. The mapping is
    // resolved here and NEVER crosses the bridge.
    const roster = await this.deps.backend.listRoster(branch_id, jwt);
    if (roster.kind !== 'roster') {
      const refusal = rosterRefusal(roster);
      this.log('info', 'provision_cashier_pin.refused', refusal.category);
      return refusal;
    }

    // FR-11: the cashier must carry a provider-neutral user_id. Absent → not_ready,
    // no row, no fallback to a clerk-keyed row. Also covers the pre-DP-2 state
    // where NO entry has a user_id (every attempt is truthfully not_ready).
    // RT-235: the renderer names the cashier by the roster `id` it holds; the
    // neutral `user_id` is read from that entry here and never crosses the bridge.
    // An empty `user_id` is not a delivered key: sign-in rejects such a row.
    const entry = roster.cashiers.find((c) => c.id === target_cashier_id);
    if (entry === undefined || entry.user_id === undefined || entry.user_id === '') {
      this.log('info', 'provision_cashier_pin.refused', 'not_ready');
      return REFUSE_NOT_READY;
    }
    const target_user_id = entry.user_id;
    const cashierClerkId = entry.id;

    // Create-only guard (FR-5): refuse if ANY row already exists for this
    // (scope, cashier) on EITHER key column — a born-neutral user_id row OR a
    // legacy clerk-keyed row (user_id NULL). Match on both so a legacy row,
    // whose user_id is NULL, is still caught by its clerk id.
    const existing = (
      this.deps.db.prepare(
        `SELECT 1 AS present
           FROM cashier_pin_records
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
            AND (user_id = ? OR cashier_clerk_user_id = ?)`,
      ) as PrepareGet
    ).get(tenant_id, branch_id, terminal_id, target_user_id, cashierClerkId);

    if (existing !== undefined) {
      this.log('info', 'provision_cashier_pin.refused', 'state_invalid');
      return REFUSE_STATE_INVALID;
    }

    // Hash the new PIN — plaintext is consumed here and never stored.
    const raw = await hashPin(req.initial_pin);
    const sealed = sealPinMaterial(raw, this.deps.safeStorage);

    // INSERT a born-neutral row: user_id is the identity key; cashier_clerk_user_id
    // satisfies the current PK and bridges to 017's re-key. failed=0, lockout=null.
    (
      this.deps.db.prepare(
        `INSERT INTO cashier_pin_records
           (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
            pin_hash, pin_salt, failed_attempt_count, lockout_until,
            created_at, created_by_operator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      ) as PrepareRun
    ).run(
      tenant_id,
      branch_id,
      terminal_id,
      cashierClerkId,
      target_user_id,
      sealed.pin_hash,
      sealed.pin_salt,
      new Date().toISOString(),
      activeSession.operator_id,
    );

    // Emit audit event — PIN value MUST NOT appear in payload (PR-1 / FR-7).
    // target_cashier_id is the provider-neutral user_id the row is keyed on.
    const payload: CashierPinProvisionedPayload = {
      target_cashier_id: target_user_id,
      terminal_id,
    };

    this.deps.auditEmitter.emit({
      event_id: req.event_id,
      tenant_id,
      branch_id,
      originating_terminal_id: terminal_id,
      acting_operator_id: activeSession.operator_id,
      session_id: activeSession.id,
      shift_id: null,
      action_category: 'cashier.pin.provisioned',
      created_at: new Date().toISOString(),
      approving_supervisor_id: null,
      payload,
    });

    this.log('info', 'provision_cashier_pin.success', undefined);
    return { kind: 'pin_provisioned', audit_event_id: req.event_id };
  }

  /**
   * T073 — manager/admin unlock of a locked-out cashier on this terminal.
   *
   * Clears lockout state; emits cashier.pin.unlock audit event.
   * If the cashier is not locked out, still emits the event and returns
   * `state_invalid` (renderer interprets as "already unlocked, no-op").
   */
  async unlockCashier(req: UnlockCashierRequest): Promise<UnlockCashierResponse | OperatorRefusal> {
    const session = this.deps.sessionManager.getCurrent();

    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      if (err instanceof OperatorRefusalError) {
        this.log('info', 'unlock_cashier.refused', err.category);
        return { kind: 'refused', category: err.category };
      }
      this.log('info', 'unlock_cashier.refused', 'invalid_input');
      return REFUSE_INVALID;
    }
    // requireRole throws on null session — safe to narrow here.
    const activeSession = session as OperatorSessionRecord;

    if (
      typeof req.event_id !== 'string' ||
      req.event_id.length === 0 ||
      typeof req.target_cashier_id !== 'string' ||
      req.target_cashier_id.length === 0
    ) {
      this.log('info', 'unlock_cashier.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const pairingStatus = await this.deps.pairingStore.getStatus();
    if (pairingStatus.kind !== 'paired') {
      this.log('info', 'unlock_cashier.refused', 'invalid_input');
      return REFUSE_INVALID;
    }

    const { tenant_id, branch_id, terminal_id } = pairingStatus;
    const { target_cashier_id } = req;

    const existing = (
      this.deps.db.prepare(
        `SELECT failed_attempt_count, lockout_until
           FROM cashier_pin_records
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as PrepareGet
    ).get(tenant_id, branch_id, terminal_id, target_cashier_id);

    const notLockedOut =
      existing === undefined ||
      existing.lockout_until === null ||
      new Date(existing.lockout_until) <= new Date();

    if (existing !== undefined) {
      // Clear lockout state unconditionally.
      (
        this.deps.db.prepare(
          `UPDATE cashier_pin_records
              SET failed_attempt_count = ?, lockout_until = ?
            WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
        ) as PrepareRun
      ).run(0, null, tenant_id, branch_id, terminal_id, target_cashier_id);
    }

    // Emit audit event regardless of prior lockout state (support trail).
    const payload: CashierPinUnlockPayload = {
      target_cashier_id,
      terminal_id,
    };

    this.deps.auditEmitter.emit({
      event_id: req.event_id,
      tenant_id,
      branch_id,
      originating_terminal_id: terminal_id,
      acting_operator_id: activeSession.operator_id,
      session_id: activeSession.id,
      shift_id: null,
      action_category: 'cashier.pin.unlock',
      created_at: new Date().toISOString(),
      approving_supervisor_id: null,
      payload,
    });

    if (notLockedOut) {
      this.log('info', 'unlock_cashier.state_invalid', undefined);
      return REFUSE_STATE_INVALID;
    }

    this.log('info', 'unlock_cashier.success', undefined);
    return { kind: 'unlocked', audit_event_id: req.event_id };
  }

  private log(level: 'info' | 'warn', event: string, category: string | undefined): void {
    if (category !== undefined) {
      this.deps.logger?.[level]({ event, category }, event.replace('.', ' '));
    } else {
      this.deps.logger?.[level]({ event }, event.replace('.', ' '));
    }
  }
}
