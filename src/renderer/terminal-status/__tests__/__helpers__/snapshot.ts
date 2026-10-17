import type {
  ConnectionStateCode,
  TerminalStatusSnapshot,
  TerminalStatusSync,
} from '../../../../shared/terminal-status/types';

/**
 * RT-604 / RT-605 — one terminal-status snapshot builder for the renderer
 * status tests. The mapping reads only `connection` and `sync`, so the
 * timestamps are fixed.
 */
export const STATUS_NOW = Date.parse('2026-10-17T12:00:00.000Z');

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function snap(
  connection: ConnectionStateCode,
  sync: Partial<TerminalStatusSync> = {},
): TerminalStatusSnapshot {
  return {
    v: 1,
    connection,
    connectionSince: iso(STATUS_NOW - 60_000),
    lastContactAt: connection === 'online' ? iso(STATUS_NOW - 5_000) : null,
    sync: {
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: null,
      ...sync,
    },
  };
}
