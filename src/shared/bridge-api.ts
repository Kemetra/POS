// Canonical source of truth from T022 onward. specs/001-foundation/contracts/preload-bridge.ts
// is a planning snapshot and is NOT re-synced after this file exists.
import type { LogRecord } from './log-record.js';
import type { AppConfig } from './app-config.js';
import type { PairingStatus, PairingSubmitResult } from './pairing-types.js';
import type { Role } from './operator/role.js';
import type { OperatorRefusal } from './audit/event-shape.js';
import type { ForcedCloseReason } from './audit/payload-schemas.js';
import type {
  SaleId,
  SaleNumber,
  TenderLineSummary,
  PrintEventSummary,
  DrawerEventSummary,
  SalesRefusalReason,
  BannerState,
  RecentSaleSummary,
} from './sales/types.js';
import type {
  CartCreateRequest,
  CartCreateResponse,
  CartLinesAddRequest,
  CartLinesAddResponse,
  CartLinesUpdateRequest,
  CartLinesUpdateResponse,
  CartLinesRemoveRequest,
  CartLinesRemoveResponse,
  CartLinesSetNoteRequest,
  CartLinesSetNoteResponse,
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersAddResponse,
  CartDiscountPlaceholdersRemoveRequest,
  CartDiscountPlaceholdersRemoveResponse,
  CartVoidRequest,
  CartVoidResponse,
  CartHandoffRequest,
  CartHandoffResponse,
  CartSubscribeRequest,
  CartSubscribeResponse,
} from './cart/bridge-types.js';

/**
 * T048 — `operator.emitAuditEvent` bridge surface.
 *
 * The renderer supplies only the fields it owns. Trusted enrichment
 * (acting_operator_id, tenant_id, branch_id, originating_terminal_id,
 * session_id, created_at) is applied by the main-process handler
 * from SessionManager and PairingStore — these MUST NOT cross the
 * renderer→main direction (FR-013 / Constitution VII).
 *
 * `action_category` is typed as `string` here (not `ActionCategory`)
 * so the preload layer remains forward-compatible if new categories
 * are added to the server contract before a client rebuild. The
 * main-process handler validates it at the AuditEmitter boundary.
 */
export interface EmitAuditEventRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Closed-set action category (validated main-side). */
  action_category: string;
  /** Shift id; omit for non-shift-scoped categories. */
  shift_id?: string;
  /** Optional second identity for supervisor-approved actions. */
  approving_supervisor_id?: string;
  /** Per-category structured payload. Forbidden keys refused main-side. */
  payload: Record<string, unknown>;
}

export interface EmitAuditEventResponse {
  kind: 'emitted';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  event_id: string;
}

/**
 * 002-terminal-pairing: the `pairing` namespace exposed by the preload
 * bridge. Interface-only at the foundational layer — the preload stub
 * throws "not implemented" until US1 (getStatus) and US2 (submit) wire
 * the real handlers. Types are canonical; specs/002-terminal-pairing/
 * contracts/preload-bridge.ts is a planning snapshot and is NOT re-synced.
 */
export interface PairingBridgeAPI {
  /**
   * Inspect local pairing state. Cheap; backed by a single SecretStore
   * read + single SQL row read. Renderer calls this on application boot
   * to decide between routing to /pairing or /paired (US1).
   */
  getStatus(): Promise<PairingStatus>;

  /**
   * Submit a pairing code (manual entry or wedge scan — bridge does not
   * care which). Resolves with a discriminated PairingSubmitResult for
   * every outcome, including failures. Rejects ONLY on programmer error
   * (invalid argument shape) — backend / network failures resolve with
   * the appropriate outcome category (US2 + US3-7).
   */
  submit(pairing_code: string): Promise<PairingSubmitResult>;
}

/**
 * 004-operator-session T014 — `operator.*` namespace skeleton.
 *
 * Per `specs/004-operator-session/contracts/bridge-api.md`. S1 wires
 * only the manager/admin Clerk path; cashier-PIN, takeover-confirm,
 * roster, audit-event-emit, and PIN management are §A1-gated and land
 * in S3/S4. Their typed signatures are intentionally absent here —
 * a future task adds them rather than adding stubs that throw
 * "not implemented" (a stub is a contract claim that the call exists,
 * which is misleading when the gate is closed).
 */

export interface OperatorSessionBridgeView {
  /** Operator session id (UUID v4). */
  id: string;
  /** Clerk user id of the operator. */
  operator_id: string;
  /** Display name as held by Clerk. */
  display_name: string;
  /** Closed-set role from Clerk metadata. */
  role: Role;
  /** Opaque tenant identifier from the device-token scope. */
  tenant_id: string;
  /** Opaque branch identifier from the device-token scope. */
  branch_id: string;
  /** ISO 8601 UTC timestamp the session was issued. */
  started_at: string;
}

export interface SignInSuccessResponse {
  kind: 'signed_in';
  session: OperatorSessionBridgeView;
  /** T091 — present when the cashier's most recent shift was force-closed and the notice was not yet dismissed. */
  forced_close_notice?: { closed_at: string };
}

export interface TakeoverRequiredResponse {
  kind: 'takeover_required';
  // No identification of the prior terminal/operator/timestamp (FR-013).
  /**
   * Capability token for the pending takeover. Must be supplied to
   * `confirmTakeover` or `cancelTakeover`. Expires after 60 seconds.
   * Opaque to the renderer — do not inspect or log its value (PR-1).
   */
  pending_takeover_id: string;
}

/**
 * T070 — request to confirm a pending takeover.
 * The renderer supplies only the capability token; all session material
 * comes from the main-process proto-session store (FR-013 / PR-1).
 */
export interface ConfirmTakeoverRequest {
  pending_takeover_id: string;
}

export type ConfirmTakeoverResponse = SignInSuccessResponse;

/**
 * T071 — request to cancel a pending takeover.
 */
export interface CancelTakeoverRequest {
  pending_takeover_id: string;
}

export interface CancelTakeoverResponse {
  kind: 'cancelled';
}

/**
 * T072 — manager/admin PIN reset for a cashier on this terminal (§A1-gated).
 *
 * `new_pin` crosses the bridge ONCE on input and is consumed by the
 * main-process handler. It MUST NOT be persisted, logged, snapshotted,
 * or surfaced in any thrown error (PR-1). 4–6 digit constraint is
 * validated main-side; invalid shape returns `invalid_input` refusal.
 */
export interface ResetCashierPinRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Clerk user id of the cashier whose PIN is being reset. */
  target_cashier_id: string;
  /** Plaintext 4–6 digit PIN — consumed by the main-process verifier, never persisted or logged. */
  new_pin: string;
}

export interface ResetCashierPinResponse {
  kind: 'pin_reset';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * 019-cashier-pin-provisioning — manager/admin FIRST-PIN provisioning for a
 * cashier on this terminal. Distinct from reset (which changes an existing
 * PIN): provisioning CREATES the row where none exists, born keyed on the
 * provider-neutral `user_id` (028 §16), never the Clerk subject. Create-only:
 * refuses (`state_invalid`) if any row already exists (incl. a legacy
 * clerk-keyed one). Refuses `not_ready` when the roster carries no `user_id`
 * yet (FR-11) — never falls back to a provider-coupled key. Validated
 * main-side; invalid shape returns `invalid_input`.
 */
export interface ProvisionCashierPinRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /**
   * The cashier to provision, by PROVIDER-NEUTRAL `user_id` (028 §16 =
   * DP-2 `users.id`), as delivered on the roster entry — NOT the Clerk subject.
   */
  target_user_id: string;
  /** Plaintext 4–6 digit PIN — consumed by the main-process verifier, never persisted or logged. */
  initial_pin: string;
}

export interface ProvisionCashierPinResponse {
  kind: 'pin_provisioned';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * T073 — manager/admin unlock of a locked-out cashier on this terminal (§A1-gated).
 *
 * This call MUST NOT accept any PIN field — it only clears lockout state.
 */
export interface UnlockCashierRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Clerk user id of the locked-out cashier. */
  target_cashier_id: string;
}

export interface UnlockCashierResponse {
  kind: 'unlocked';
  /** Echoes the client-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * T089 — manager/admin forced-close of a stuck cashier shift.
 *
 * `event_id` is the caller-generated UUID v4 idempotency key.
 * `declared_count` is intentionally absent — forced-close always leaves it
 * NULL (FR-024(a) blind-close / absent state).
 */
export interface ForceCloseShiftRequest {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Local shift id to force-close. */
  shift_id: string;
  /** Structured reason; must be one of the FORCED_CLOSE_REASONS enum members. */
  reason: ForcedCloseReason;
  /** Optional free-text annotation for support context (PR-1: no PIN/PII). */
  annotation?: string;
}

export interface ForceCloseShiftResponse {
  kind: 'forced_closed';
  /** Echoes the caller-supplied event_id for idempotency confirmation. */
  audit_event_id: string;
}

/**
 * T090 — one stuck shift summary visible to the renderer.
 *
 * FR-013 minimum-disclosure: only display-safe fields. No Clerk user ids,
 * branch_id, tenant_id, device ids, or financial counts.
 */
export interface StuckShiftSummary {
  shift_id: string;
  /** Display label only — never email or Clerk user id (FR-032). */
  cashier_display_name: string;
  terminal_label: string;
  /** ISO 8601 UTC timestamp. */
  opened_at: string;
  duration_minutes: number;
}

export type ListStuckShiftsResponse =
  | { kind: 'stuck_shifts'; shifts: StuckShiftSummary[] }
  | OperatorRefusal;

/**
 * Manager/admin sign-in request shape.
 */
export interface ManagerAdminSignInRequest {
  kind: 'manager_admin';
  /** Identifier (email or username) the operator typed. */
  identifier: string;
  /** Cleartext password — crosses the bridge ONCE on input (PR-1). */
  password: string;
}

/**
 * S4 / T075 — cashier sign-in request shape.
 *
 * AD-2: PIN verified locally via Argon2id. The plaintext PIN NEVER
 * reaches the backend, any logger, or the renderer response (PR-1).
 * Crosses the bridge ONCE on input; consumed by CashierSignInHandler.
 */
export interface CashierSignInRequest {
  kind: 'cashier';
  /** Clerk user id of the cashier (from the branch roster). */
  cashier_clerk_user_id: string;
  /** Plaintext PIN — consumed by the verifier, never persisted or logged. */
  pin: string;
  /** Display name used to populate the local session record. */
  display_name: string;
}

export type SignInRequest = ManagerAdminSignInRequest | CashierSignInRequest;

export type SignInResponse = SignInSuccessResponse | TakeoverRequiredResponse | OperatorRefusal;

export interface SignOutResponse {
  kind: 'signed_out';
}

/**
 * T070b — bridge view of a single cashier on the branch roster.
 *
 * Strict minimum-disclosure: only `{id, display_name, role}` cross the
 * bridge (FR-006, FR-031). Email, phone, password hash, PIN material,
 * and audit history MUST NOT appear here.
 */
export interface BranchRosterCashier {
  id: string;
  display_name: string;
  role: 'cashier';
}

export interface ListBranchRosterSuccess {
  kind: 'roster';
  cashiers: BranchRosterCashier[];
}

export type ListBranchRosterResponse = ListBranchRosterSuccess | OperatorRefusal;

/**
 * `operator.*` namespace. Manager/admin paths only at S1; cashier,
 * takeover-confirm, roster, audit-event-emit, and PIN management land
 * in later slices behind their gates.
 */
export interface OperatorBridgeAPI {
  /**
   * Authenticate an operator and create an operator session. S1 wires
   * the manager/admin variant only. Resolves with one of:
   *   - { kind: 'signed_in', session }
   *   - { kind: 'takeover_required' }                    // S4 wires the prompt UX
   *   - { kind: 'refused', category: RefusalCategory }   // single generic family
   *
   * The bridge handler MUST refuse generically (NFR-003 / PR-2): every
   * factor-distinguishable cause maps to `invalid_input` except the
   * cashier-PIN-only `rate_limited` case (S4) and the network-only
   * `no_connection` case.
   *
   * Redaction: the `password` field is consumed by the verifier and
   * MUST NOT be persisted, logged, snapshotted, or surfaced in any
   * thrown error (PR-1).
   */
  signIn(req: SignInRequest): Promise<SignInResponse>;

  /**
   * End the current operator session. Best-effort backend call; the
   * local session is torn down within 1 s regardless of backend
   * reachability (FR-008 / NFR-007).
   */
  signOut(): Promise<SignOutResponse>;

  /**
   * Read-only inquiry for the current session. Returns the session if
   * one is active, otherwise `null`.
   */
  getCurrentSession(): Promise<OperatorSessionBridgeView | null>;

  /**
   * Notify-only: the renderer reports genuine user input (mousemove,
   * keypress, touch) to the inactivity monitor (T028b / FR-009). Fire-
   * and-forget — the caller MUST NOT await or use the return value. No
   * new IPC channel: reuses `operator:_report-activity` registered in S1.
   * Wired by F-01 (s1-review finding — was registered main-side but
   * missing from the bridge surface).
   */
  _reportActivity(): void;

  /**
   * T048 — Emit one audit event to the local outbox.
   *
   * The renderer supplies only the fields it owns (`EmitAuditEventRequest`);
   * the main-process handler enriches the trusted fields from session
   * state and pairing state before delegating to `AuditEmitter.emit()`.
   *
   * Resolves with `{ kind: 'emitted', event_id }` on success.
   * Resolves with `{ kind: 'refused', category }` on any failure
   * (no session → `not_signed_in`; bad payload / forbidden key →
   * `invalid_input`). Never rejects.
   *
   * Idempotent: submitting the same `event_id` twice is a no-op (P5 /
   * INSERT OR IGNORE at the SQL layer).
   */
  emitAuditEvent(req: EmitAuditEventRequest): Promise<EmitAuditEventResponse | OperatorRefusal>;

  /**
   * T051 — Debug bridge smoke. Main generates the event_id; renderer
   * supplies nothing. Gated by `process.env.NODE_ENV !== 'production'`
   * in the main-process handler — returns `invalid_input` refusal in
   * production builds. Manager / admin roles only; cashier → `role_mismatch`.
   * Hardcoded `action_category: 'shift.open'`, `payload: { smoke: true }`.
   */
  _emitAuditEventSmoke(): Promise<EmitAuditEventResponse | OperatorRefusal>;

  /**
   * T070b — list cashiers on the terminal's paired branch.
   *
   * Manager and admin roles only (cashier → `role_mismatch`). Returns only
   * `{id, display_name, role: 'cashier'}` per entry — no email, phone,
   * PIN material, or audit history crosses the bridge (FR-006, FR-031).
   * Branch scope comes from the active operator session (trusted main-side).
   */
  listBranchRoster(): Promise<ListBranchRosterResponse>;

  /**
   * T070 — confirm a pending takeover using the capability token returned
   * by `signIn`. Creates the new session and emits the
   * `operator.session.takeover` audit event.
   *
   * On success: `{ kind: 'signed_in', session }`.
   * On `no_connection`: proto-session is retained; caller may retry.
   * On any other failure: `{ kind: 'refused', category: 'invalid_input' }`.
   * Token expires after 60 seconds (NFR-003).
   */
  confirmTakeover(req: ConfirmTakeoverRequest): Promise<ConfirmTakeoverResponse | OperatorRefusal>;

  /**
   * T071 — cancel a pending takeover. Discards the proto-session;
   * returns `{ kind: 'cancelled' }` idempotently even if the token is
   * unknown or already expired. No audit event. No session change.
   */
  cancelTakeover(req: CancelTakeoverRequest): Promise<CancelTakeoverResponse>;

  /**
   * T072 — PR-5 manager/admin PIN reset for a cashier on this terminal.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * `new_pin` must be 4–6 digits; invalid shape → `invalid_input`.
   * `target_cashier_id` must have an existing pin record on this terminal;
   * unknown cashier → `invalid_input`.
   *
   * Emits `cashier.pin.reset` audit event (manager attributed, cashier
   * referenced by id only; PIN value never in payload — PR-1).
   * Resets `failed_attempt_count` to 0 and `lockout_until` to null.
   */
  resetCashierPin(req: ResetCashierPinRequest): Promise<ResetCashierPinResponse | OperatorRefusal>;

  /**
   * 019 — manager/admin FIRST-PIN provisioning (create) for a cashier on this
   * terminal. Creates the row keyed on the provider-neutral `user_id`; emits
   * `cashier.pin.provisioned` (secret-free). Create-only; refuses `state_invalid`
   * if a row exists, `not_ready` if the roster has no `user_id` (FR-11).
   */
  provisionCashierPin(
    req: ProvisionCashierPinRequest,
  ): Promise<ProvisionCashierPinResponse | OperatorRefusal>;

  /**
   * T073 — PR-3 manager/admin unlock of a locked-out cashier on this terminal.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Resets `failed_attempt_count` to 0 and `lockout_until` to null.
   *
   * If the cashier is not currently locked out, still emits the
   * `cashier.pin.unlock` audit event and returns `state_invalid`
   * (the renderer interprets this as "already unlocked, no-op").
   *
   * This call MUST NOT accept any PIN field — it only clears lockout state.
   */
  unlockCashier(req: UnlockCashierRequest): Promise<UnlockCashierResponse | OperatorRefusal>;

  /**
   * T089 — manager/admin forced-close of a stuck cashier shift.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Branch isolation: manager can only close shifts on their own branch
   * (P17 — mismatch returns `role_mismatch`, not `state_invalid`).
   * declared_count is left NULL (FR-024(a) blind-close / absent state).
   *
   * Idempotent: calling with the same `event_id` on an already-closed
   * shift returns `{ kind: 'forced_closed', audit_event_id }` without
   * re-emitting the audit event.
   */
  forceCloseShift(req: ForceCloseShiftRequest): Promise<ForceCloseShiftResponse | OperatorRefusal>;

  /**
   * T090 — list stuck cashier shifts on this terminal's branch.
   *
   * Role gate: `manager` or `admin` only — `cashier` → `role_mismatch`.
   * Returns only display-safe fields per FR-013 / FR-032. Branch scope
   * comes from the active operator session (trusted main-side).
   */
  listStuckShifts(): Promise<ListStuckShiftsResponse>;

  /**
   * T091 — cashier dismisses the forced-close return banner.
   *
   * Zero renderer args. Main process reads the current session and pairing
   * state to derive all needed IDs. Fire-and-forget; always resolves void.
   * Takeover-confirm responses do NOT populate forced_close_notice — this
   * call is a no-op in that path.
   */
  dismissShiftClosedNotice(): Promise<void>;
}

export interface PreloadBridgeAPI {
  ping(): Promise<'pong'>;
  appVersion(): Promise<string>;
  /**
   * Phase 8 / US6: ship a structured log record to the main-process
   * logger. Sandboxed renderers cannot write files directly; this is
   * the only path from renderer code to the on-disk log stream.
   * Resolves on successful enqueue; never rejects with a value the
   * caller is expected to surface — logging must not crash the app.
   */
  log(record: LogRecord): Promise<void>;
  /**
   * Phase 9 / US7: pull renderer-relevant runtime configuration from
   * main. Currently the only field is `sentryDsn` — used to decide
   * whether to initialise renderer-side Sentry. Sandboxed renderers
   * cannot read `process.env`, and `import.meta.env.VITE_*` would
   * inline the DSN into the bundle at build time — neither is
   * acceptable, so config crosses the typed bridge instead (D3).
   */
  appConfig(): Promise<AppConfig>;
  /**
   * 002-terminal-pairing: terminal-pairing namespace. Interface-only at
   * the foundational layer; the preload stub throws "not implemented"
   * until US1 / US2 wire the real handlers.
   */
  pairing: PairingBridgeAPI;
  /**
   * 004-operator-session: operator-session namespace. S1 wires the
   * manager/admin Clerk path; cashier-PIN, takeover-confirm, roster,
   * audit-event-emit, and PIN management are §A1-gated and land
   * later.
   */
  operator: OperatorBridgeAPI;
  /**
   * 005-sales-cart: cart namespace. Phase 2 provides typed stubs only;
   * all handlers return refused/not_implemented until S1 wires real
   * main-process logic.
   */
  cart: CartBridgeAPI;
  /**
   * 006-payments-tender Slice 3: `payments.*` (attempt-level) +
   * `tender.*` (per-line) namespaces. Slice 4 adds `payments.forceFail`
   * (still pending) and `vouchers.*` (Wave 4 — voucher validate path).
   *
   * Marked optional in S3b — the namespace types are declared but the
   * preload (`src/preload/index.ts`) is wired in S3c (T142). Once S3c
   * lands, callers that need a guarantee can narrow with the
   * non-null-assertion operator or a runtime presence check. The
   * Slice-3 renderer wiring (T150–T154) is the only consumer and lands
   * in S3d after S3c is GREEN.
   */
  payments?: PaymentsBridgeAPI;
  tender?: TenderBridgeAPI;
  /** 006 Wave 4 — voucher validate (per §A4-B authorisation 2026-05-25). */
  vouchers?: VouchersBridgeAPI;
  /**
   * 008-sale-finalization-and-receipts Slice 1: `sales.*` (read-only)
   * namespace. Slice 2+ adds `receipts.*` (mutating).
   *
   * Marked optional in S1b — the namespace types are declared here but
   * the preload (`src/preload/index.ts`) is wired in S1d (T100/T101).
   * Once S1d lands, callers that need a guarantee can narrow with the
   * non-null-assertion operator or a runtime presence check. The
   * Slice-1 renderer is read-only (no UI mounted by Slice 1 itself;
   * S1 surfaces are consumed by Slice 2 onwards).
   */
  sales?: SalesBridgeAPI;
  /**
   * 008-sale-finalization-and-receipts Slice 2: `receipts.*` (mutating)
   * namespace. S2 exposes `receipts.preview` only (read-only render); the
   * genuinely-mutating members join in Slices 3 / 5 / 6. Optional for the
   * same staged-wiring reason as `sales` above.
   */
  receipts?: ReceiptsBridgeAPI;
  /**
   * 009-product-search-and-barcode-lookup Slice S1: read-only `catalogue.*`
   * namespace (lookupBarcode / lookupSku / search / resolve). Wired into the
   * preload in S1 (T016); session-gated main-side (NFR-6a). Optional for the
   * same staged-wiring reason as `sales`/`receipts` — S1 ships a gated skeleton
   * (handlers return `catalogue_unavailable` until the read model lands in S2).
   */
  catalogue?: CatalogueBridgeAPI;

  /**
   * 011-sale-sync-capture-up: READ-ONLY sale-sync status namespace. A single
   * channel (`sales:syncStatus`) exposing pending / dead-letter counts + the
   * last-success timestamp. The renderer can OBSERVE sync health but can never
   * trigger or mutate the drain (the engine runs in the main process; §A4 / P8 /
   * WR-1). Optional for the same staged-wiring reason as the namespaces above.
   */
  salesSync?: SalesSyncBridgeAPI;
}

/**
 * 011-sale-sync-capture-up: typed read-only `salesSync.*` namespace. No write
 * channel exists. The response carries counts + one timestamp only — no token,
 * PII, or raw error (P7).
 */
export interface SalesSyncBridgeAPI {
  syncStatus(): Promise<SaleSyncStatusResponse>;
}

/** The read-only sync-status payload (mirrors main `SaleSyncStatusCounts`). */
export interface SaleSyncStatusResponse {
  pending: number;
  deadLetter: number;
  lastSuccessAt: string | null;
}

/**
 * 005-sales-cart: typed cart.* namespace for the preload bridge.
 * Every handler is role-gated on the main-process side (AD-1).
 * Phase 2 stubs return refused/not_implemented.
 */
export interface CartBridgeAPI {
  /** Creates a new draft cart bound to the current operator session. */
  create(req: CartCreateRequest): Promise<CartCreateResponse>;
  lines: {
    /** Adds a line item; merges if same item_ref exists (Q4). */
    add(req: CartLinesAddRequest): Promise<CartLinesAddResponse>;
    /** Changes quantity of an existing line. */
    update(req: CartLinesUpdateRequest): Promise<CartLinesUpdateResponse>;
    /** Soft-removes a line. */
    remove(req: CartLinesRemoveRequest): Promise<CartLinesRemoveResponse>;
    /** Sets or clears the free-text note on a line. */
    setNote(req: CartLinesSetNoteRequest): Promise<CartLinesSetNoteResponse>;
  };
  discountPlaceholders: {
    /** Adds a discount placeholder; may require manager attribution. */
    add(req: CartDiscountPlaceholdersAddRequest): Promise<CartDiscountPlaceholdersAddResponse>;
    /** Removes a discount placeholder; mirrors attribution rule of add. */
    remove(
      req: CartDiscountPlaceholdersRemoveRequest,
    ): Promise<CartDiscountPlaceholdersRemoveResponse>;
  };
  /** Voids a cart. Post-handoff void requires manager attribution. */
  void(req: CartVoidRequest): Promise<CartVoidResponse>;
  /** Freezes the cart and constructs the PaymentIntentEnvelope. */
  handoff(req: CartHandoffRequest): Promise<CartHandoffResponse>;
  /** Push-style cart state updates (type-only in Phase 2; S1+ runtime). */
  subscribe(req: CartSubscribeRequest): Promise<CartSubscribeResponse>;
}

declare global {
  interface Window {
    api: PreloadBridgeAPI;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 006-payments-tender Slice 3 — payments.* + tender.* bridge types (T071)
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors specs/006-payments-tender/contracts/bridge-api.md (DRAFT — §A4-A
// cleared 2026-05-21). Slice-3 subset only: no `payments.forceFail`, no
// `vouchers.*`. Slice 4 will add those additively.

import type {
  PaymentAttemptRendererView,
  PaymentRefusal,
  TenderLineRendererView,
  TenderType,
} from './payments/types.js';

// ── payments.start ───────────────────────────────────────────────────────────

export interface PaymentsStartRequest {
  /** From 005's `cart.handoff` return value. */
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  envelope_version: 'v1';
  /** Client-generated UUID v4 (R-10). */
  idempotency_key: string;
}

export type PaymentsStartResponse = { kind: 'ok'; payment_attempt_id: string } | PaymentRefusal;

// ── payments.confirm ─────────────────────────────────────────────────────────

export interface PaymentsConfirmRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsConfirmResponse = { kind: 'ok'; settled_at: string } | PaymentRefusal;

// ── payments.cancel ──────────────────────────────────────────────────────────

export interface PaymentsCancelRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsCancelResponse =
  | {
      kind: 'ok';
      cancelled_at: string;
      /** TenderLines successfully reversed (LIFO per FR-006B). */
      reversed_tender_line_ids: readonly string[];
      /** TenderLines awaiting deferred reversal (Slice 4 voucher path). */
      reversal_pending_tender_line_ids: readonly string[];
    }
  | PaymentRefusal;

// ── payments.forceFail (Wave 5b — manager-only) ──────────────────────────────
//
// Manager / admin incident-response action that transitions a stuck
// `started` attempt to `force_failed` (FR-021 / plan AD-5). The audit
// row carries dual attribution (manager actor + original cashier).
// **Manager identity NEVER appears in cashier-visible surfaces** —
// `force_fail_attribution_operator_id` is stripped from any renderer
// projection of the attempt; consumers of this response see only the
// generic timestamp.

export interface PaymentsForceFailRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsForceFailResponse = { kind: 'ok'; force_failed_at: string } | PaymentRefusal;

// ── payments.read ────────────────────────────────────────────────────────────

export interface PaymentsReadRequest {
  payment_attempt_id: string;
}

export type PaymentsReadResponse =
  | { kind: 'ok'; payment_attempt: PaymentAttemptRendererView }
  | PaymentRefusal;

// ── payments.subscribe ───────────────────────────────────────────────────────

export interface PaymentsSubscribeRequest {
  payment_attempt_id: string;
}

/**
 * Subscribe-stream payload. Same projection as `payments.read` per
 * contracts/bridge-api.md §"payments.subscribe".
 */
export type PaymentsSubscribeResponse =
  | { kind: 'ok'; payment_attempt: PaymentAttemptRendererView }
  | PaymentRefusal;

// ── tender.apply ─────────────────────────────────────────────────────────────

export interface TenderApplyRequest {
  payment_attempt_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  /** Only for `external_card_terminal` (regex `^[A-Z0-9]{0,6}$`). */
  external_reference?: string;
  /** Only for `internal_voucher` (Slice 4 path). */
  voucher_code?: string;
  idempotency_key: string;
}

export type TenderApplyResponse =
  | {
      kind: 'ok';
      tender_line_id: string;
      applied_at: string;
      /** Cash overpayment only. */
      change_due_minor?: number;
    }
  | PaymentRefusal;

// ── tender.reverse ───────────────────────────────────────────────────────────

export interface TenderReverseRequest {
  tender_line_id: string;
  idempotency_key: string;
}

export type TenderReverseResponse =
  | {
      kind: 'ok';
      reversed_at: string;
      /** `reversed` for cash + external_card_terminal in Slice 3. */
      state: 'reversed' | 'reversal_pending';
    }
  | PaymentRefusal;

// ── tender.read ──────────────────────────────────────────────────────────────

export interface TenderReadRequest {
  tender_line_id: string;
}

export type TenderReadResponse =
  | { kind: 'ok'; tender_line: TenderLineRendererView }
  | PaymentRefusal;

// ── vouchers.validate (Slice 4 / Wave 4) ─────────────────────────────────────
//
// Bridge surface for the voucher-authority-client (V-A) `posValidateVoucher`
// operation. The bridge persists a `payment_tender_lines` row with
// `state='applied'` + `voucher_redemption_intent_token` on success
// (data-model §"PaymentTenderLine" Invariant 4). On any V-A refusal the
// row is persisted with `state='refused'` + `refusal_reason`. The
// `voucher_redemption_intent_token` is **main-side only** and MUST NOT
// appear in the response (FR-017 / F-A4B brief §3.4).
//
// `applied_amount_minor` is the cashier-supplied amount; V-A caps refuse
// rather than truncate (research §R-7). `remaining_balance_minor` is
// computed main-side from `payment_attempts.envelope_subtotal_minor` and
// the current line breakdown — the renderer does NOT compute or send it.

export interface VouchersValidateRequest {
  payment_attempt_id: string;
  voucher_code: string;
  amount_applied_minor: number;
  idempotency_key: string;
}

export type VouchersValidateResponse =
  | {
      kind: 'ok';
      tender_line_id: string;
      applied_amount_minor: number;
      applied_at: string;
    }
  | PaymentRefusal;

// ── Namespace surfaces ───────────────────────────────────────────────────────

export interface PaymentsBridgeAPI {
  /** Starts a new payment attempt against a frozen `PaymentIntentEnvelope v1`. */
  start(req: PaymentsStartRequest): Promise<PaymentsStartResponse>;
  /** Evaluates the settlement invariant + transitions to `settled`. */
  confirm(req: PaymentsConfirmRequest): Promise<PaymentsConfirmResponse>;
  /** Reverses applied TenderLines LIFO + transitions to `cancelled`. */
  cancel(req: PaymentsCancelRequest): Promise<PaymentsCancelResponse>;
  /** Push-stream subscription to attempt-level + per-line state. */
  subscribe(req: PaymentsSubscribeRequest): Promise<PaymentsSubscribeResponse>;
  /** One-shot read of the same renderer projection as `subscribe`. */
  read(req: PaymentsReadRequest): Promise<PaymentsReadResponse>;
  /**
   * Wave 5b — manager / admin-only force-fail of a stuck `started`
   * attempt (FR-021). The renderer's `<OperatorRouteGuard>` is
   * secondary UX defence; the load-bearing role check lives in the
   * main-process handler. Cashier role is refused with `role_denied`.
   */
  forceFail(req: PaymentsForceFailRequest): Promise<PaymentsForceFailResponse>;
}

export interface TenderBridgeAPI {
  /** Applies a tender line to a `started` payment attempt. */
  apply(req: TenderApplyRequest): Promise<TenderApplyResponse>;
  /** Reverses an `applied` tender line (idempotent via `idempotency_key`). */
  reverse(req: TenderReverseRequest): Promise<TenderReverseResponse>;
  /** One-shot read of a single line — same projection as `payments.subscribe`. */
  read(req: TenderReadRequest): Promise<TenderReadResponse>;
}

/**
 * 006 Wave 4 — voucher bridge namespace (Contract V-A). Only `validate`
 * is renderer-facing; `redeem` is invoked inside `payments.confirm` and
 * `reverse` inside `tender.reverse`. Both server-side flows are
 * intentionally absent from this surface so the renderer cannot
 * unilaterally redeem or reverse a voucher (FR-017 + AD-3).
 */
export interface VouchersBridgeAPI {
  /** Validates a voucher code with V-A and persists the resulting line. */
  validate(req: VouchersValidateRequest): Promise<VouchersValidateResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// 008-sale-finalization-and-receipts Slice 1: `sales.*` namespace (read-only)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"Namespace: sales.* (read-only)"
//
// All handlers are gated server-side by `requireOperatorSession` (every
// 008 bridge handler MUST start with that call). No `idempotency_key` on
// any `sales.*` handler — they are read-only.
//
// Slice 1 lands these read handlers. Slice 2+ adds the mutating
// `receipts.*` namespace (preview, reprint, retryPrint, manualOverride).

/**
 * The shape returned by `sales.read` + `sales.findByNumber`. Strict subset
 * of the persisted `sales` row — main-only fields (envelope_handoff_action_id,
 * payment_attempt_id, envelope_cart_id, tenant_tax_registration_id) are
 * EXCLUDED per `contracts/bridge-api.md` §"Notes" + Constitution §P15.
 */
export interface SaleSummary {
  sale_id: SaleId;
  sale_number: SaleNumber;
  receipt_number: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  terminal_label: string;
  selling_operator_id: string;
  selling_operator_display_name: string;
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;
  tender_lines_summary: TenderLineSummary[];
  finalized_at: string;
  /** Latest PrintEvent projection (gates the reprint affordance per AD-10). */
  latest_print_event?: PrintEventSummary;
  /** Latest DrawerEvent projection (drives the drawer-failure banner). */
  latest_drawer_event?: DrawerEventSummary;
}

// ── sales.read ──────────────────────────────────────────────────────────────

export interface SalesReadRequest {
  sale_id: SaleId;
}

export type SalesReadResponse =
  | { kind: 'ok'; sale: SaleSummary }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.findByNumber ──────────────────────────────────────────────────────

export interface SalesFindByNumberRequest {
  sale_number: SaleNumber;
}

export type SalesFindByNumberResponse =
  | { kind: 'ok'; sale: SaleSummary }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── sales.subscribe / sales.unsubscribe ─────────────────────────────────────

/**
 * Subscription topic. `recent` emits compact summaries on every new
 * `sale.finalized` audit event for the current terminal. `banner_state`
 * emits the projected banner state on every new PrintEvent / DrawerEvent.
 */
export type SalesSubscribeTopic = 'recent' | 'banner_state';

export interface SalesSubscribeRequest {
  topic: SalesSubscribeTopic;
}

/**
 * Snapshot-subscribe (008 follow-up slice): `subscribe` returns the current
 * projection for the topic, exactly as 006's `subscribe ≡ read`. The renderer
 * POLLS this on an interval (no `webContents.send` push — consistent with the
 * deliberately poll-based AD-2 finalize design; see coordination §S3c
 * mechanism-corrected note). `subscription_token` is retained for `unsubscribe`
 * symmetry (additive per PRODUCT.md Principle 4 — extend, don't rename); the
 * snapshot field carried depends on the requested `topic`:
 *   • `topic='banner_state'` → `banner_state: BannerState`
 *   • `topic='recent'`       → `recent: RecentSaleSummary | null`
 */
export type SalesSubscribeResponse =
  | { kind: 'ok'; subscription_token: string; banner_state: BannerState }
  | { kind: 'ok'; subscription_token: string; recent: RecentSaleSummary | null }
  | { kind: 'refused'; reason: SalesRefusalReason };

export interface SalesUnsubscribeRequest {
  subscription_token: string;
}

export type SalesUnsubscribeResponse = { kind: 'ok' };

// ── SalesBridgeAPI surface ──────────────────────────────────────────────────

/**
 * 008-sale-finalization-and-receipts Slice 1 read-only bridge surface.
 *
 * Every handler is gated server-side by `requireOperatorSession`; no
 * renderer-side authorization is load-bearing (AD-1). Tenant / branch /
 * terminal scoping is derived from the operator session and enforced at
 * each handler entry per the §A4 8-item checklist (PR #257).
 */
export interface SalesBridgeAPI {
  /** Read a single sale by id. */
  read(req: SalesReadRequest): Promise<SalesReadResponse>;
  /** Lookup by cashier-quotable sale_number (tenant/branch/terminal-scoped). */
  findByNumber(req: SalesFindByNumberRequest): Promise<SalesFindByNumberResponse>;
  /** Subscribe to live updates on the current terminal's sales activity. */
  subscribe(req: SalesSubscribeRequest): Promise<SalesSubscribeResponse>;
  /** Detach a previously-acquired subscription. */
  unsubscribe(req: SalesUnsubscribeRequest): Promise<SalesUnsubscribeResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// 008-sale-finalization-and-receipts Slice 2: `receipts.*` namespace (mutating)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"Namespace: receipts.* (mutating)" → "receipts.preview"
//
// Slice 2 lands `receipts.preview` ONLY. It is the one read-shaped member of
// the mutating namespace — it renders the AD-6 engine's HTML for a sale and
// has NO side effects (no print command, no drawer kick, no Sale mutation).
// The genuinely-mutating handlers (reprint / retryPrint / manualOverride) land
// in Slices 3 / 5 / 6. Every handler is gated server-side by
// `requireOperatorSession`; preview reuses the `SalesRefusalReason` vocabulary
// (no_session / sale_not_found / forbidden_field_in_request).

// ── receipts.preview ──────────────────────────────────────────────────────────

export interface ReceiptsPreviewRequest {
  sale_id: SaleId;
  /**
   * Present for symmetry with the mutating `receipts.*` handlers; preview is
   * effectively idempotent (no side effects), so it is not used to dedupe.
   */
  idempotency_key: string;
}

export interface ReceiptPreviewPayload {
  /** The AD-6 engine's HTML output. The renderer mounts this directly. */
  html: string;
  /** ESC/POS column width the printed slip uses (80 mm Font A → 42 in v1). */
  width_chars: number;
  /** Locale/direction hint so the preview pane mirrors the printed slip. */
  bilingual_locale: 'ar-EG-RTL-with-latin-en';
}

export type ReceiptsPreviewResponse =
  | { kind: 'ok'; preview: ReceiptPreviewPayload }
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.retryPrint (008 Slice 3) ────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.retryPrint"
//
// THREE-way response. A successful retry is the canonical first print
// (FR-052): no duplicate-copy marker. A still-failed retry returns kind:'ok'
// with outcome:'failure' (NOT kind:'refused') because the retry attempt itself
// was accepted — it ran and got a failure ack back; the banner stays loud.

export interface ReceiptsRetryPrintRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsRetryPrintResponse =
  // success
  | {
      kind: 'ok';
      outcome: 'success';
      print_event_id: string;
      purpose: 'retry_after_failure';
      render_path: 'escpos_direct' | 'os_print';
      printed_at: string;
    }
  // still-failed (attempt accepted, print failed)
  | {
      kind: 'ok';
      outcome: 'failure';
      print_event_id: string;
      purpose: 'retry_after_failure';
      failure_reason:
        | 'printer_offline'
        | 'printer_out_of_paper'
        | 'printer_jam'
        | 'os_print_error'
        | 'escpos_write_failure'
        | 'escpos_status_unknown';
    }
  // refused (attempt NOT accepted — gate/isolation/not-found)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.reprint (008 Slice 5) ────────────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.reprint"
//
// TWO-way response (success | refused) — NOT three-way like retryPrint. A
// reprint is repeatable by design (the n-th reprint gets
// duplicate_copy_sequence_number=n), so a print FAILURE refuses with
// `printer_unavailable` rather than returning an ok+failure outcome. Reprint is
// cashier-permitted (AD-10): gated only on requireOperatorSession, no role
// restriction. It renders the `reprint_duplicate` template variant (bilingual
// duplicate-copy marker) and NEVER kicks the drawer (FR-030).

export interface ReceiptsReprintRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsReprintResponse =
  // success
  | {
      kind: 'ok';
      print_event_id: string;
      duplicate_copy_sequence_number: number;
      reprinted_at: string;
      render_path: 'escpos_direct' | 'os_print';
    }
  // refused (gate / isolation / precondition / printer-down)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── receipts.manualOverride (008 Slice 6) ─────────────────────────────────────
//
// Schema source of truth:
//   specs/008-sale-finalization-and-receipts/contracts/bridge-api.md
//   §"receipts.manualOverride"
//
// Cashier invokes manual-receipt override after a print failure (from the
// printer-failure banner). The handler records that a receipt was handled
// out-of-band: it INSERTs a print_events row with purpose='first_print',
// outcome='manual_override', render_path=NULL — NO slip is rendered or printed.
// Two-way response (success | refused). Idempotent per-sale (Path A, key-on-
// state): a sale that already has a manual_override is a no-op returning the
// original row. The drawer is NEVER kicked (no print succeeded).

export interface ReceiptsManualOverrideRequest {
  sale_id: SaleId;
  idempotency_key: string;
}

export type ReceiptsManualOverrideResponse =
  // success
  | {
      kind: 'ok';
      print_event_id: string;
      purpose: 'first_print';
      outcome: 'manual_override';
      overridden_at: string;
    }
  // refused (gate / isolation / not-found)
  | { kind: 'refused'; reason: SalesRefusalReason };

// ── ReceiptsBridgeAPI surface ───────────────────────────────────────────────

/**
 * 008 mutating-namespace bridge surface. S2 landed `preview`; S3 adds
 * `retryPrint`; S5 adds `reprint`; S6 adds `manualOverride`. Gated server-side
 * by `requireOperatorSession`; tenant/branch/terminal scoping is derived from
 * the operator session per the §A4 checklist.
 */
export interface ReceiptsBridgeAPI {
  /** Render the read-only HTML preview of a sale's receipt. No side effects. */
  preview(req: ReceiptsPreviewRequest): Promise<ReceiptsPreviewResponse>;
  /** Retry a failed print. Three-way response (success / still-failed / refused). */
  retryPrint(req: ReceiptsRetryPrintRequest): Promise<ReceiptsRetryPrintResponse>;
  /** Reprint a previously-printed sale (duplicate copy). Two-way response. */
  reprint(req: ReceiptsReprintRequest): Promise<ReceiptsReprintResponse>;
  /** Record a manual-receipt override after a print failure. Two-way response. */
  manualOverride(req: ReceiptsManualOverrideRequest): Promise<ReceiptsManualOverrideResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// 009-product-search-and-barcode-lookup — `catalogue.*` namespace (read-only)
// ────────────────────────────────────────────────────────────────────────────
//
// Schema source of truth:
//   specs/009-product-search-and-barcode-lookup/contracts/bridge-api.md
//
// Slice S1 (§A0/§A1 ratified 2026-05-30) lands the typed surface + a
// session-gated SKELETON (every handler returns the `catalogue_unavailable`
// stub until the read model is wired). Exact lookup lands in S2 (§A2), folded
// search in S3 (§A2), resolve + 005 seam wiring in S4 (§A1). The namespace is
// READ-ONLY — there is no insert/update/delete handler (AD-2). Every handler's
// first step is the active-session gate (NFR-6a); refusals are generic.

import type { ProductSnapshotDisplay, ResolvedSeam } from './catalogue/product-snapshot.js';

export interface CatalogueLookupBarcodeRequest {
  barcode: string;
}
export interface CatalogueLookupSkuRequest {
  sku: string;
}
export interface CatalogueSearchRequest {
  query: string;
}
export interface CatalogueResolveRequest {
  product_id: string;
}

/**
 * Generic gate refusals (NFR-6a). The `reason` is for diagnostic logging only
 * and is NEVER echoed to the cashier verbatim. No role gate beyond an active
 * session — cashier/manager/admin all look up products.
 */
export type CatalogueRefusalReason = 'no_session' | 'tenant_isolation';

/** Shared by `lookupBarcode` + `lookupSku` (exact lookup, FR-4/FR-9). */
export type CatalogueLookupResponse =
  | { kind: 'one'; product: ProductSnapshotDisplay } // exactly one active product → confirm-first (FR-5)
  | { kind: 'not_found' } // zero matches (FR-6)
  | { kind: 'ambiguous' } // >1 active product for this barcode (FR-7)
  | { kind: 'catalogue_unavailable' } // empty/missing/unreadable read model (FR-24)
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/** Folded substring name/alias search (FR-11/12/13). */
export type CatalogueSearchResponse =
  | { kind: 'results'; items: readonly ProductSnapshotDisplay[]; truncated: boolean } // ranked, ≤20 (NFR-4)
  | { kind: 'not_found' }
  | { kind: 'too_short' } // < 2 normalized chars (FR-16)
  | { kind: 'catalogue_unavailable' }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * Resolve a chosen product to the confirm-and-add snapshot. `seam` is the 005
 * cart-seam success shape (`ResolvedSeam` = `{ display_name, unit_price_minor }`
 * — §A1 ratified: no `version`, matching 005's live `ItemRefResolver`).
 */
export type CatalogueResolveResponse =
  | { kind: 'ok'; snapshot: ProductSnapshotDisplay; seam: ResolvedSeam }
  | {
      kind: 'refused';
      // Gate refusals (NFR-6a — resolve is session-gated like every handler)
      // PLUS the resolve-specific refusals (FR-18/FR-19): inactive product,
      // unknown id, missing required field, or any other generic failure.
      reason:
        | CatalogueRefusalReason
        | 'unknown_item'
        | 'disabled'
        | 'missing_required_field'
        | 'generic';
    }
  | { kind: 'catalogue_unavailable' };

// ───────────────────────────────────────────────────────────────────────────
// 010-pos-catalog-read-down-consumption (T041) — `catalogue.refresh` /
// `catalogue.freshness` additions (§A4 bridge-security review). Both requests
// are `{}` (INP-1 — the terminal identity + tenant come from session/pairing,
// NEVER the renderer payload). Both gate on the session FIRST (AD-1) and refuse
// generically (AD-2). Neither returns catalogue data or any secret (WR-2/SEC-1).
// ───────────────────────────────────────────────────────────────────────────

/** Empty request — no renderer-supplied identity/scope/cursor (INP-1 / FR-15a). */
export type CatalogueRefreshRequest = Record<string, never>;
export type CatalogueFreshnessRequest = Record<string, never>;
export type CatalogueCountsRequest = Record<string, never>;

/**
 * `catalogue.refresh` response (contract Addition 1). Status ONLY — no catalogue
 * data, no per-record content (WR-2). Returns immediately after kicking off the
 * tick, NOT after the promote commits (P9-2 / FR-12 — no fake "done").
 */
export type CatalogueRefreshResponse =
  | { kind: 'started' } // a read-down tick was kicked off
  | { kind: 'already_running' } // single-flight: a tick is in progress (FR-14)
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * `catalogue.freshness` response (contract Addition 2). A truthful last-updated
 * read for the FR-16 indicator. `is_empty` closes the empty-catalogue
 * truthfulness hole (SC-10): a successful EMPTY promote sets a non-null
 * `last_success_at` while the live products table has 0 rows, so the indicator
 * must distinguish three states (P9-1) — never a bare timestamp implying data
 * when there is none.
 */
export type CatalogueFreshnessResponse =
  | { kind: 'ok'; last_success_at: string | null; is_empty: boolean }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * `catalogue.counts` response (diagnostics) — the tenant-scoped LOCAL read-model
 * size for the Catalogue Diagnostics screen. Integers ONLY (WR-2): no catalogue
 * rows, no secrets, no device token. `products` = live products row count;
 * `barcodes` = product_barcodes (alias) row count. Both scoped to the session
 * tenant (P17-1). Refuses (never throws/leaks) with no session or no source.
 */
export type CatalogueCountsResponse =
  | { kind: 'ok'; products: number; barcodes: number }
  | { kind: 'refused'; reason: CatalogueRefusalReason };

/**
 * 009 read-only `catalogue.*` bridge surface, EXTENDED by 010 with the read-down
 * `refresh` / `freshness` additions. Gated server-side on an active operator
 * session (NFR-6a); renderer-side checks are never load-bearing. Tenant scoping
 * is derived from the session at the repo layer (S2). Optional for the same
 * staged-wiring reason as `sales`/`receipts` above — the preload
 * (`src/preload/index.ts`) wires it in S1 (T016); 010 adds `refresh`/`freshness`.
 */
export interface CatalogueBridgeAPI {
  /** Exact barcode lookup (FR-4). */
  lookupBarcode(req: CatalogueLookupBarcodeRequest): Promise<CatalogueLookupResponse>;
  /** Exact SKU lookup (FR-9). */
  lookupSku(req: CatalogueLookupSkuRequest): Promise<CatalogueLookupResponse>;
  /** Folded substring name/alias search (FR-11/12/13). */
  search(req: CatalogueSearchRequest): Promise<CatalogueSearchResponse>;
  /** Resolve a chosen product to the confirm-and-add snapshot (FR-19). */
  resolve(req: CatalogueResolveRequest): Promise<CatalogueResolveResponse>;
  /** 010 — kick off one manual read-down tick (status only; §A4 Addition 1). */
  refresh(req: CatalogueRefreshRequest): Promise<CatalogueRefreshResponse>;
  /** 010 — truthful last-updated read for the FR-16 indicator (§A4 Addition 2). */
  freshness(req: CatalogueFreshnessRequest): Promise<CatalogueFreshnessResponse>;
  /** 010 diagnostics — tenant-scoped local read-model counts (integers only). */
  counts(req: CatalogueCountsRequest): Promise<CatalogueCountsResponse>;
}
