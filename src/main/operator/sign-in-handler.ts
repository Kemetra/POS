import type { Logger } from 'pino';

import { randomUUID, createHash } from 'node:crypto';

import type {
  ManagerAdminSignInRequest,
  SignInResponse,
  SignInSuccessResponse,
  TakeoverRequiredResponse,
} from '../../shared/bridge-api.js';
import { makeSecretKey, type SecretStore } from '../../shared/secret-store.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

import type { ClerkExchanger } from './clerk-client.js';
import type { BackendClient } from './backend-client.js';
import type { SessionManager } from './session-manager.js';
import type { JwtHolder } from './jwt-holder.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import type { PairingStore } from '../pairing/store.js';
import { CheckActiveSessionHandler } from './check-active-session.js';
import { unsealPinMaterial } from './pin-seal.js';
import { verifyPinWithWindow, rowMatchesScope, type PinScope } from './pin-lockout.js';
import type { PinRow } from './pin-credential.js';
import { ProtoSessionStore } from './takeover-handler.js';

/**
 * 004-operator-session T026 — manager/admin sign-in handler.
 *
 * Wave 1 path (b): POS terminal exchanges the password against Clerk
 * directly to obtain a fresh Clerk session JWT, then posts that JWT in
 * `Authorization: Bearer …` to Data-Pulse-2 along with a
 * `device_token_attestation` body. Data-Pulse-2 verifies the JWT via
 * Clerk JWKS — the password NEVER reaches Data-Pulse-2 (AD-2 /
 * Constitution v1.5.1).
 *
 * Refusal posture (NFR-003 / PR-2): every factor-distinguishable cause
 * collapses to `OperatorRefusal { category: 'invalid_input' }`. The
 * sole exceptions are network unreachability (`no_connection`) and the
 * cashier-PIN-only `rate_limited` carve-out (S4 only). The renderer
 * maps the category to a single generic Surface-6 message family.
 *
 * Redaction (PR-1): the `password` field is consumed by the Clerk
 * exchanger and IS NEVER persisted, logged, snapshotted, or surfaced
 * in any thrown error. The JWT is held only in-memory inside this
 * handler's call frame and the SessionManager record's
 * `backend_session_id` (the JWT itself is not stored — the backend
 * session id is the durable handle).
 */

export interface SignInHandlerDeps {
  clerk: ClerkExchanger;
  backend: BackendClient;
  sessionManager: SessionManager;
  /** Terminal-side proof of device-token possession (per 002). */
  deviceTokenAttestation: () => Promise<string> | string;
  /**
   * Shared proto-session store. Populated when signIn returns
   * `takeover_required`; consumed by TakeoverHandler.confirmTakeover.
   */
  protoStore: ProtoSessionStore;
  /**
   * Optional JWT holder. Production wires `createJwtHolder()`; tests
   * may omit. When present, the Clerk provider JWT is recorded against
   * the backend session id on successful sign-in.
   *
   * 016 (review HIGH): DP-2 splits POS auth into TWO schemes. The
   * provider JWT (`operator-identity`) is identity proof at sign-in AND
   * on subsequent operator-identity calls — sign-out
   * (`POST /operators/sign-out`) and stuck-shifts (`GET /shifts/stuck`)
   * — per 028 §6 CM-1. THIS holder feeds those routes, so it MUST keep
   * the JWT, NOT the opaque sale-sync envelope.
   */
  jwtHolder?: JwtHolder;
  /**
   * Optional envelope holder — the SECOND credential seam (016 review
   * HIGH). Production wires a separate `createJwtHolder()`; tests may
   * omit. When present, the opaque `pos_operator` ENVELOPE (#559) is
   * recorded against the backend session id on successful sign-in.
   *
   * The envelope authorizes ONLY the sale-sync routes (`operatorAuthorization`
   * scheme: captureSale / recordVoid / recordRefund). An absent or null
   * envelope (legacy backend / replayed sign-in) normalizes to '' so the
   * sale-sync envelope-present gate (M-1) treats it as absent and pauses
   * the drain rather than POSTing without a credential. Held in
   * main-process memory only — NEVER bridged, NEVER logged (P7/P8).
   */
  envelopeHolder?: JwtHolder;
  /** Optional logger. Tests omit it. */
  logger?: Logger;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_NO_CONN: OperatorRefusal = { kind: 'refused', category: 'no_connection' };
const REFUSE_RATE_LIMITED: OperatorRefusal = { kind: 'refused', category: 'rate_limited' };

export class SignInHandler {
  constructor(private readonly deps: SignInHandlerDeps) {}

  async signIn(req: ManagerAdminSignInRequest): Promise<SignInResponse> {
    // Boundary input validation — generic refusal on shape miss; we
    // never echo the rejected payload (Constitution VII).
    if (
      typeof req.identifier !== 'string' ||
      req.identifier.length === 0 ||
      typeof req.password !== 'string' ||
      req.password.length === 0
    ) {
      this.logRefusal('invalid_input', 'shape');
      return REFUSE_INVALID;
    }

    // 1. Clerk credential exchange — happens in main process; password
    //    is consumed by the exchanger and discarded after this call.
    const exchange = await this.deps.clerk.exchange({
      identifier: req.identifier,
      password: req.password,
    });
    if (exchange.kind === 'no_connection') {
      this.logRefusal('no_connection', 'clerk');
      return REFUSE_NO_CONN;
    }
    if (exchange.kind === 'refused') {
      this.logRefusal('invalid_input', 'clerk');
      return REFUSE_INVALID;
    }

    // 2. Backend sign-in — JWT in Authorization header; body carries
    //    NO credential material (Wave 1 path b). The role-eligibility,
    //    tenant/branch scope, and takeover detection happen
    //    server-side; the client treats every refusal mode as the
    //    single generic category.
    const attestation = await Promise.resolve(this.deps.deviceTokenAttestation());
    const backend = await this.deps.backend.signIn(
      { kind: 'manager_admin', device_token_attestation: attestation },
      exchange.jwt,
    );
    if (backend.kind === 'no_connection') {
      this.logRefusal('no_connection', 'backend');
      return REFUSE_NO_CONN;
    }
    if (backend.kind === 'refused') {
      this.logRefusal('invalid_input', 'backend');
      return REFUSE_INVALID;
    }
    if (backend.kind === 'takeover_required') {
      const pending_takeover_id = randomUUID();
      // tenant_id and branch_id are not available from the backend takeover_required
      // response (FR-013 minimum-disclosure). TakeoverHandler.confirmTakeover uses
      // the backend confirm response (Endpoint 4) for authoritative scope values.
      this.deps.protoStore.set({
        pending_takeover_id,
        operator_id: exchange.operator_id,
        display_name: exchange.display_name,
        role: exchange.role,
        tenant_id: '',
        branch_id: '',
        jwt: exchange.jwt,
        created_at: Date.now(),
      });
      this.logSuccess('takeover_required');
      return { kind: 'takeover_required', pending_takeover_id } satisfies TakeoverRequiredResponse;
    }

    // 3. Manager / admin only at S1. Cashier-role identities cannot
    //    sign in via this endpoint per the backend contract; the
    //    backend already refuses them, but a defence-in-depth check
    //    here keeps the local trust boundary explicit.
    if (backend.operator.role === 'cashier') {
      this.logRefusal('invalid_input', 'role');
      return REFUSE_INVALID;
    }

    // 4. Create local in-memory session. S3 makes this durable.
    const record = this.deps.sessionManager.create({
      operator_id: backend.operator.id,
      display_name: backend.operator.display_name,
      role: backend.operator.role,
      tenant_id: backend.operator.tenant_id,
      branch_id: backend.operator.branch_id,
      backend_session_id: backend.operator_session.id,
      started_at: backend.operator_session.issued_at,
    });
    // 016 (review HIGH) — two credential seams, contract-correct:
    //
    //   • jwtHolder ← the Clerk provider JWT (`operator-identity` scheme). The
    //     provider JWT is identity proof at sign-in AND on subsequent
    //     operator-identity calls — sign-out + stuck-shifts (028 §6 CM-1). If
    //     this held the envelope, those routes would 401 (silent regression).
    //
    //   • envelopeHolder ← the opaque pos_operator ENVELOPE (#559,
    //     `operatorAuthorization` scheme). Authorizes ONLY the sale-sync POSTs.
    //     An absent or null envelope (legacy backend / replayed sign-in)
    //     normalizes to '' so the envelope-present gate (M-1) treats it as
    //     absent and pauses the drain rather than POSTing without a credential.
    //
    // Both held in main-process memory only — NEVER crosses to the renderer,
    // NEVER logged (P7/P8).
    this.deps.jwtHolder?.set(record.backend_session_id, exchange.jwt);
    this.deps.envelopeHolder?.set(record.backend_session_id, backend.pos_operator_envelope ?? '');

    this.logSuccess('signed_in');
    return {
      kind: 'signed_in',
      session: {
        id: record.id,
        operator_id: record.operator_id,
        display_name: record.display_name,
        role: record.role,
        tenant_id: record.tenant_id,
        branch_id: record.branch_id,
        started_at: record.started_at,
      },
    } satisfies SignInSuccessResponse;
  }

  private logRefusal(category: 'invalid_input' | 'no_connection', stage: string): void {
    // PR-1 / FR-030 redaction: log only the category and stage; never
    // the identifier, never the password, never the JWT.
    this.deps.logger?.info(
      { event: 'operator.sign_in.refused', category, stage },
      'sign-in refused',
    );
  }

  private logSuccess(kind: 'signed_in' | 'takeover_required'): void {
    this.deps.logger?.info({ event: 'operator.sign_in.outcome', kind }, 'sign-in outcome');
  }
}

/**
 * 004-operator-session T069 — cashier sign-in handler.
 *
 * AD-2: PIN verified locally via Argon2id (T066). The plaintext PIN NEVER
 * reaches the backend, any logger, or the renderer (PR-1 / FR-030).
 *
 * Flow:
 *   1. Verify terminal is paired (provides tenant/branch/terminal scope).
 *   2. Fetch sealed cashier_pin_records row from SQLite by composite PK.
 *   3. PR-4 scope guard — row must match the requested scope.
 *   4. Unseal pin_hash + pin_salt via safeStorage (DPAPI on Windows).
 *   5. Verify PIN via verifyPinWithWindow (handles PR-3 expired-lockout reset).
 *   6. Persist only safe lockout-state columns (failed_attempt_count, lockout_until).
 *   7. On match: check for an active session (T069b); return takeover_required or signed_in.
 */

/** DB row returned by the cashier_pin_records SELECT. Local to this module. */
interface CashierPinDbRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  cashier_clerk_user_id: string;
  pin_hash: Buffer;
  pin_salt: Buffer;
  failed_attempt_count: number;
  lockout_until: string | null;
}

/**
 * Request shape for the cashier sign-in path.
 * Defined here (not in bridge-api.ts) — IPC wiring is a separate task.
 */
export interface CashierSignInRequest {
  kind: 'cashier';
  cashier_clerk_user_id: string;
  /** Plaintext PIN — consumed by verifyPinWithWindow, never persisted or logged. */
  pin: string;
  /** Display name used to populate the local session record. */
  display_name: string;
}

export interface CashierSignInHandlerDeps {
  db: DatabaseHandle;
  safeStorage: SafeStorageLike;
  sessionManager: SessionManager;
  checkActiveSession: CheckActiveSessionHandler;
  pairingStore: PairingStore;
  /**
   * Shared proto-session store. Populated when signIn returns
   * `takeover_required`; consumed by TakeoverHandler.confirmTakeover.
   */
  protoStore: ProtoSessionStore;
  /** T091 — DPAPI-backed secret store for dismiss records. Tests omit it. */
  secretStore?: SecretStore;
  /** Optional logger. Tests omit it. */
  logger?: Logger;
}

/**
 * T091 — derive the forced-close-notice dismiss key.
 *
 * SHA-256 of `tenantId|branchId|terminalId|cashierId`, first 24 hex chars → total
 * key length 50 chars (within the 64-char SecretKey limit). The hash is
 * one-way: cashier identity is not reconstructable from the stored key.
 */
export function makeShiftDismissKey(
  tenantId: string,
  branchId: string,
  terminalId: string,
  cashierId: string,
): ReturnType<typeof makeSecretKey> {
  const digest = createHash('sha256')
    .update(`${tenantId}|${branchId}|${terminalId}|${cashierId}`)
    .digest('hex')
    .slice(0, 24);
  return makeSecretKey(`pos-pulse.shift-dismissed.${digest}`);
}

export class CashierSignInHandler {
  constructor(private readonly deps: CashierSignInHandlerDeps) {}

  /**
   * RT-117 (RT-116 §2.4) — verify a cashier's PIN on this terminal WITHOUT
   * creating a session. Used for same-operator unlock of a locked session.
   * Same row lookup, scope guard, unseal and 004 lockout rules as sign-in.
   * Returns null on a match, otherwise the generic refusal.
   */
  async verifyPin(cashier_clerk_user_id: string, pin: string): Promise<OperatorRefusal | null> {
    const pairingStatus = await this.deps.pairingStore.getStatus();
    if (pairingStatus.kind !== 'paired') {
      this.logRefusal('invalid_input', 'not_paired');
      return REFUSE_INVALID;
    }
    const scope: PinScope = {
      tenant_id: pairingStatus.tenant_id,
      branch_id: pairingStatus.branch_id,
      terminal_id: pairingStatus.terminal_id,
      cashier_clerk_user_id,
    };
    const loaded = this.loadPinRow(scope);
    if ('kind' in loaded) return loaded;
    return await this.verifyPinAndUpdateLockout(pin, loaded, scope);
  }

  async signIn(req: CashierSignInRequest): Promise<SignInResponse> {
    // 1. Terminal scope — must be paired to know tenant/branch/terminal
    const pairingStatus = await this.deps.pairingStore.getStatus();
    if (pairingStatus.kind !== 'paired') {
      this.logRefusal('invalid_input', 'not_paired');
      return REFUSE_INVALID;
    }

    const scope: PinScope = {
      tenant_id: pairingStatus.tenant_id,
      branch_id: pairingStatus.branch_id,
      terminal_id: pairingStatus.terminal_id,
      cashier_clerk_user_id: req.cashier_clerk_user_id,
    };

    // 2–4. Fetch sealed pin row, PR-4 scope guard, unseal pin material.
    const loaded = this.loadPinRow(scope);
    if ('kind' in loaded) return loaded;
    const pinRow = loaded;

    // 5. Verify PIN — verifyPinWithWindow handles PR-3 expired-lockout reset
    const pinRefusal = await this.verifyPinAndUpdateLockout(req.pin, pinRow, scope);
    if (pinRefusal !== null) return pinRefusal;

    // 6. Check for an existing active session for this cashier (T069b)
    const activeCheck = await this.deps.checkActiveSession.checkActiveSession(
      req.cashier_clerk_user_id,
      scope.branch_id,
    );
    if (activeCheck.kind === 'refused') {
      this.logRefusal(activeCheck.category, 'active_session_check');
      return activeCheck;
    }
    if (activeCheck.kind === 'active') {
      const pending_takeover_id = randomUUID();
      this.deps.protoStore.set({
        pending_takeover_id,
        operator_id: req.cashier_clerk_user_id,
        display_name: req.display_name,
        role: 'cashier',
        tenant_id: scope.tenant_id,
        branch_id: scope.branch_id,
        jwt: null,
        created_at: Date.now(),
      });
      this.logSuccess('takeover_required');
      return { kind: 'takeover_required', pending_takeover_id } satisfies TakeoverRequiredResponse;
    }

    // 7. No active session — create local in-memory session
    // AD-2: cashier PIN path is local-only; backend_session_id is empty.
    const record = this.deps.sessionManager.create({
      operator_id: req.cashier_clerk_user_id,
      display_name: req.display_name,
      role: 'cashier',
      tenant_id: scope.tenant_id,
      branch_id: scope.branch_id,
      backend_session_id: '',
    });

    // T091 — check for an undismissed forced-close shift on this cashier.
    const forced_close_notice = await this.resolveForcedCloseNotice(scope);

    this.logSuccess('signed_in');
    if (forced_close_notice !== undefined) {
      this.logInfo('operator.cashier_sign_in.forced_close_banner');
    }
    return {
      kind: 'signed_in',
      session: {
        id: record.id,
        operator_id: record.operator_id,
        display_name: record.display_name,
        role: record.role,
        tenant_id: record.tenant_id,
        branch_id: record.branch_id,
        started_at: record.started_at,
      },
      ...(forced_close_notice !== undefined ? { forced_close_notice } : {}),
    } satisfies SignInSuccessResponse;
  }

  /**
   * Steps 2–4 of cashier sign-in: fetch the sealed pin row, enforce the PR-4
   * scope guard (defense-in-depth: queried row must match the scope), and
   * unseal the pin material (DPAPI on Windows; throws if ciphertext is
   * tampered/corrupt). Any decrypt error returns a generic refusal — raw
   * storage errors must not propagate out of the sign-in path (PR-1: no
   * ciphertext, hash, salt, or cashier id in logs or returned values).
   */
  private loadPinRow(scope: PinScope): PinRow | OperatorRefusal {
    type SelectStmt = { get(...p: unknown[]): CashierPinDbRow | undefined };
    const sealedRow = (
      this.deps.db.prepare(
        `SELECT tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
                pin_hash, pin_salt, failed_attempt_count, lockout_until
           FROM cashier_pin_records
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as SelectStmt
    ).get(scope.tenant_id, scope.branch_id, scope.terminal_id, scope.cashier_clerk_user_id);

    if (sealedRow === undefined) {
      this.logRefusal('invalid_input', 'not_found');
      return REFUSE_INVALID;
    }

    if (!rowMatchesScope(sealedRow, scope)) {
      this.logRefusal('invalid_input', 'scope_mismatch');
      return REFUSE_INVALID;
    }

    try {
      const unsealed = unsealPinMaterial(
        { pin_hash: sealedRow.pin_hash, pin_salt: sealedRow.pin_salt },
        this.deps.safeStorage,
      );
      return {
        pin_hash: unsealed.pin_hash,
        pin_salt: unsealed.pin_salt,
        failed_attempt_count: sealedRow.failed_attempt_count,
        lockout_until: sealedRow.lockout_until,
      };
    } catch {
      this.logRefusal('invalid_input', 'pin_unseal');
      return REFUSE_INVALID;
    }
  }

  /**
   * Step 5 of cashier sign-in: verify the PIN and persist lockout-state
   * transitions (PR-1: only the safe lockout-state columns are written —
   * never the PIN). Returns the refusal to surface, or null on a match.
   */
  private async verifyPinAndUpdateLockout(
    pin: string,
    pinRow: PinRow,
    scope: PinScope,
  ): Promise<OperatorRefusal | null> {
    const result = await verifyPinWithWindow(pin, pinRow);

    if (result.kind === 'locked_out') {
      // Active lockout — do NOT write to DB (lockout_until is already set)
      this.logRefusal('rate_limited', 'locked_out');
      return REFUSE_RATE_LIMITED;
    }

    if (result.kind === 'no_match') {
      this.persistLockoutState(scope, result.newFailedCount, result.newLockoutUntil);
      if (result.newLockoutUntil !== null) {
        // T081: lockout was triggered by this failed attempt.
        this.logInfo('operator.cashier_sign_in.lockout_triggered');
      }
      this.logRefusal('invalid_input', 'wrong_pin');
      return REFUSE_INVALID;
    }

    // result.kind === 'match' — reset failure counter in DB
    const hadActiveLockout =
      pinRow.lockout_until !== null && new Date(pinRow.lockout_until) <= new Date();
    this.persistLockoutState(scope, 0, null);
    if (hadActiveLockout) {
      // T081: expired lockout was released on successful sign-in.
      this.logInfo('operator.cashier_sign_in.lockout_released');
    }
    return null;
  }

  /**
   * T091 — resolve whether an undismissed forced-close notice should surface
   * for this cashier. Only `closed_at` crosses the bridge; no financial
   * totals, manager reason, annotation, shift_id, or IDs (FR-013
   * minimum-disclosure).
   */
  private async resolveForcedCloseNotice(
    scope: PinScope,
  ): Promise<{ closed_at: string } | undefined> {
    interface ShiftRow {
      closed_at: string;
    }
    type ShiftSelectStmt = { get(...p: unknown[]): ShiftRow | undefined };
    const shiftRow = (
      this.deps.db.prepare(
        `SELECT closed_at FROM shifts
         WHERE lifecycle_state = 'closed_forced'
           AND tenant_id = ?
           AND branch_id = ?
           AND originating_terminal_id = ?
           AND opening_operator_id = ?
          ORDER BY closed_at DESC
          LIMIT 1`,
      ) as ShiftSelectStmt
    ).get(scope.tenant_id, scope.branch_id, scope.terminal_id, scope.cashier_clerk_user_id);

    if (shiftRow === undefined || typeof shiftRow.closed_at !== 'string') return undefined;
    const notice = { closed_at: shiftRow.closed_at };

    if (this.deps.secretStore === undefined) return notice;

    const dismissKey = makeShiftDismissKey(
      scope.tenant_id,
      scope.branch_id,
      scope.terminal_id,
      scope.cashier_clerk_user_id,
    );
    const dismissRaw = await this.deps.secretStore.get(dismissKey);
    if (dismissRaw === null) return notice;

    try {
      const parsed = JSON.parse(dismissRaw) as { dismissed_closed_at?: unknown };
      return parsed.dismissed_closed_at !== shiftRow.closed_at ? notice : undefined;
    } catch {
      return notice;
    }
  }

  /**
   * T091 — persist a dismiss record for the most recent forced-close shift.
   *
   * Called from the IPC handler when the cashier clicks Dismiss on the
   * ShiftClosedBanner. Writes `{ dismissed_closed_at }` under the hashed
   * dismiss key so subsequent sign-ins omit the notice.
   * No-op when secretStore is absent (test environments) or no shift exists.
   */
  async dismissForcedCloseNotice(
    tenantId: string,
    branchId: string,
    terminalId: string,
    cashierId: string,
  ): Promise<void> {
    if (this.deps.secretStore === undefined) return;
    interface ShiftRow {
      closed_at: string;
    }
    type ShiftSelectStmt = { get(...p: unknown[]): ShiftRow | undefined };
    const shiftRow = (
      this.deps.db.prepare(
        `SELECT closed_at FROM shifts
         WHERE lifecycle_state = 'closed_forced'
           AND tenant_id = ?
           AND branch_id = ?
           AND originating_terminal_id = ?
           AND opening_operator_id = ?
          ORDER BY closed_at DESC
          LIMIT 1`,
      ) as ShiftSelectStmt
    ).get(tenantId, branchId, terminalId, cashierId);
    if (shiftRow === undefined || typeof shiftRow.closed_at !== 'string') return;
    const dismissKey = makeShiftDismissKey(tenantId, branchId, terminalId, cashierId);
    await this.deps.secretStore.set(
      dismissKey,
      JSON.stringify({ dismissed_closed_at: shiftRow.closed_at }),
    );
  }

  /** Write failed_attempt_count and lockout_until to cashier_pin_records. */
  private persistLockoutState(
    scope: PinScope,
    failed_attempt_count: number,
    lockout_until: string | null,
  ): void {
    type RunStmt = { run(...p: unknown[]): unknown };
    (
      this.deps.db.prepare(
        `UPDATE cashier_pin_records
            SET failed_attempt_count = ?, lockout_until = ?
          WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND cashier_clerk_user_id = ?`,
      ) as RunStmt
    ).run(
      failed_attempt_count,
      lockout_until,
      scope.tenant_id,
      scope.branch_id,
      scope.terminal_id,
      scope.cashier_clerk_user_id,
    );
  }

  private logRefusal(category: string, stage: string): void {
    this.deps.logger?.info(
      { event: 'operator.cashier_sign_in.refused', category, stage },
      'cashier sign-in refused',
    );
  }

  private logSuccess(kind: 'signed_in' | 'takeover_required'): void {
    this.deps.logger?.info(
      { event: 'operator.cashier_sign_in.outcome', kind },
      'cashier sign-in outcome',
    );
  }

  /** T081 — named log site for lockout state transitions (no credential data — PR-1). */
  private logInfo(event: string): void {
    this.deps.logger?.info({ event }, event.replace(/\./g, ' '));
  }
}
