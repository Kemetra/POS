// Canonical source of truth for pairing types from T005 onward.
// specs/002-terminal-pairing/contracts/preload-bridge.ts is a planning
// snapshot and is NOT re-synced after this file exists.
//
// Constraints honoured:
//   - All fields and methods are typed; no `any`.
//   - The renderer never receives the device token; PairingStatus carries
//     only configuration.
//   - The bridge never accepts the device token from the renderer either;
//     the only writable path is submit(pairing_code), which is short-lived
//     form state.

/** Why a terminal needs to be paired again (`PairingStatus.invalid`). */
export const PAIRING_INVALID_REASONS = [
  'missing_token',
  'orphaned_row',
  'decrypt_failed',
  'device_revoked',
] as const;
export type PairingInvalidReason = (typeof PAIRING_INVALID_REASONS)[number];

/**
 * RT-215 — the device-bearer route family whose 401 started a confirmed
 * device revocation (decision 2: only the cashier-admissions routes and the
 * catalogue read-down count). Carried as the audit payload `{ source }`.
 */
export type DeviceRevokedSource = 'cashier_admissions' | 'read_down' | 'sale_sync';

/** What the terminal currently knows about its identity. */
export type PairingStatus =
  | { kind: 'unpaired' }
  /**
   * Either the SecretStore entry is missing-but-the-table-row-is-orphaned,
   * the table row is missing while the SecretStore entry exists, or the
   * SecretStore entry exists but DPAPI cannot decrypt it. All three are
   * surfaced as "needs re-pair" with a banner reason; recovery is a normal
   * pair attempt (FR-1(c)).
   *
   * RT-215: `device_revoked` — Backend-Core refused this terminal's device
   * credential (two consecutive device-bearer 401s, the second from a
   * confirmation call). Durable on the pairing row until a re-pair; the
   * device token is kept sealed but never sent. Recovery is a normal pair
   * attempt with a new pairing code, or (RT-215 10897-A) a user-initiated
   * "Check again" that the server answers 2xx (`pairing:recheck`).
   */
  | { kind: 'invalid'; reason: PairingInvalidReason }
  | {
      kind: 'paired';
      tenant_id: string;
      branch_id: string;
      terminal_id: string;
      terminal_label: string;
      paired_at: number; // unix epoch seconds
    };

/** Outcome category of a single pair-submit attempt. */
export type PairingOutcome =
  | 'success'
  | 'invalid_code'
  | 'expired_code'
  | 'already_paired'
  | 'branch_mismatch'
  | 'rate_limited'
  | 'network_error'
  | 'unknown_error'
  /**
   * RT-215 review F3 — refused locally: an operator session is still alive
   * (a revoked terminal's latched session ends at its safe point first). The
   * code is not sent.
   */
  | 'session_active'
  /**
   * RT-215 rev546b S-1 — refused locally: the terminal is paired (and not
   * revoked). Pairing is a recovery from unpaired / invalid / revoked only, so
   * a sign-in cannot complete during a re-pair and skip the relaunch. The code
   * is not sent. (Distinct from the server's `already_paired`: code used.)
   */
  | 'terminal_already_paired';

/**
 * Result returned to the renderer after a submit. Discriminated on
 * `outcome` so callers can switch exhaustively. The success branch
 * carries only configuration (no device_token — that lives in
 * SecretStore on the main side and never crosses the bridge).
 */
export type PairingSubmitResult =
  | {
      outcome: 'success';
      tenant_id: string;
      branch_id: string;
      terminal_id: string;
      terminal_label: string;
    }
  | {
      outcome: 'rate_limited';
      /** Seconds the UI MUST keep submit disabled. Clamped to [1, 300]. */
      retry_after_s: number;
    }
  | {
      outcome:
        | 'invalid_code'
        | 'expired_code'
        | 'already_paired'
        | 'branch_mismatch'
        | 'network_error'
        | 'unknown_error'
        | 'session_active'
        | 'terminal_already_paired';
    };

/**
 * Canonical IPC channel names for the pairing namespace. Enumerated to
 * satisfy Constitution III (no ad-hoc strings). The preload binds these
 * names to the bridge methods; the main process registers handlers
 * under exactly these names.
 */
export const PAIRING_IPC_CHANNELS = {
  GET_STATUS: 'pairing:get-status',
  SUBMIT: 'pairing:submit',
  /**
   * RT-215 10897-A (owner approval 10906) — the user-initiated "Check again"
   * on `/pairing` while the terminal is device-revoked. The renderer only
   * triggers it (no argument); it answers a {@link PairingRecheckResult}.
   */
  RECHECK: 'pairing:recheck',
} as const;

/**
 * RT-215 10897-A — what one "Check again" found. The ONE roster call (with the
 * sealed device token) answered:
 *  - `cleared`: 2xx — the revocation is cleared, durably and in memory;
 *  - `still_revoked`: 401 — the terminal stays revoked;
 *  - `unreachable`: anything else (no connection, 5xx, an unreadable token,
 *    nothing to check) — the terminal stays revoked; try again.
 * No token, no identifier: the result is the outcome only.
 */
export const PAIRING_RECHECK_OUTCOMES = ['cleared', 'still_revoked', 'unreachable'] as const;
export type PairingRecheckOutcome = (typeof PAIRING_RECHECK_OUTCOMES)[number];
export interface PairingRecheckResult {
  outcome: PairingRecheckOutcome;
}

/**
 * RT-215 — main → renderer PUSH channels of the pairing namespace. Kept apart
 * from {@link PAIRING_IPC_CHANNELS}, which lists only the invoke handlers main
 * registers (the same split as `SESSION_LOCK_IPC_CHANNELS.SESSION_STATE`).
 *
 * `STATUS_CHANGED` is sent when a confirmed device revocation reaches its
 * routing point (no session, or the latched session ended at its safe point)
 * and after a successful pairing. The payload is a
 * {@link PairingStatusChangedEvent}.
 */
export const PAIRING_PUSH_CHANNELS = {
  STATUS_CHANGED: 'pairing:status-changed',
} as const;

/**
 * RT-215 — payload of the `pairing:status-changed` push. Minimal by design:
 * the status kind and, for `invalid`, the reason. No identifiers, no token.
 */
export type PairingStatusChangedEvent =
  | { kind: 'invalid'; reason: PairingInvalidReason }
  | { kind: 'paired' }
  | { kind: 'unpaired' };

export type PairingIpcChannel = (typeof PAIRING_IPC_CHANNELS)[keyof typeof PAIRING_IPC_CHANNELS];
