/**
 * RT-603 (VN-S6 S6-2, doc 24 §3.1) — the terminal status bridge contract.
 *
 * Two channels: `terminalStatus:get` (invoke, `{}` only) and
 * `terminalStatus:changed` (push, main → renderer). Both carry one
 * `TerminalStatusSnapshot`: closed-set codes, non-negative integer counts and
 * ISO 8601 UTC timestamps only. Never a URL, host, error, HTTP status, token,
 * tenant / branch / terminal / sale id or cashier identity (A4-3, P7).
 *
 * Main sends facts, not copy: the renderer derives the cashier-facing
 * composite (§4.1).
 */

export const TERMINAL_STATUS_IPC_CHANNELS = {
  GET: 'terminalStatus:get',
  CHANGED: 'terminalStatus:changed',
} as const;

export const CONNECTION_STATE_CODES = ['checking', 'online', 'degraded', 'offline'] as const;
export type ConnectionStateCode = (typeof CONNECTION_STATE_CODES)[number];

/** Mirrors main's `SALE_SYNC_PAUSED_REASONS` (RT-224); a test keeps them equal. */
export const TERMINAL_STATUS_PAUSED_REASONS = ['no_operator_credential'] as const;
export type TerminalStatusPausedReason = (typeof TERMINAL_STATUS_PAUSED_REASONS)[number];

export interface TerminalStatusSync {
  /** This terminal's unsent sales. */
  readonly pending: number;
  /** Unsent sales queued under an earlier pairing (RT-221; held, never sent). */
  readonly heldPreviousPairing: number;
  /** Every dead-lettered sale, payload divergences included. */
  readonly deadLetter: number;
  /** Outbox enqueue time of the oldest pending sale (ISO), or null. */
  readonly oldestPendingAt: string | null;
  /** Why the drain cannot send right now (RT-224), or null. */
  readonly paused: TerminalStatusPausedReason | null;
  /** Last successful send (ISO), or null. */
  readonly lastSuccessAt: string | null;
}

export interface TerminalStatusSnapshot {
  readonly v: 1;
  readonly connection: ConnectionStateCode;
  /** When `connection` last changed (ISO 8601 UTC). */
  readonly connectionSince: string;
  /** Last qualifying Backend-Core answer (ISO), or null if none since start. */
  readonly lastContactAt: string | null;
  readonly sync: TerminalStatusSync;
}

/** `terminalStatus:get` with anything but `{}` (INP-1). */
export const TERMINAL_STATUS_INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
export type TerminalStatusInvalid = typeof TERMINAL_STATUS_INVALID;
