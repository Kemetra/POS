import type { TerminalStatusBridgeAPI } from '../shared/bridge-api.js';
import {
  CONNECTION_STATE_CODES,
  TERMINAL_STATUS_IPC_CHANNELS,
  TERMINAL_STATUS_PAUSED_REASONS,
  type ConnectionStateCode,
  type TerminalStatusPausedReason,
  type TerminalStatusSnapshot,
  type TerminalStatusSync,
} from '../shared/terminal-status/types.js';

/**
 * RT-603 (VN-S6 S6-2, doc 24 §3.1, A4-4) — preload side of the terminal status
 * bridge: `get()` over `terminalStatus:get` and `onChanged(cb)` over the
 * `terminalStatus:changed` push.
 *
 * `parse` checks every field against its closed set or type and rebuilds the
 * snapshot from known fields only, so unknown fields are dropped. A payload
 * that fails is never coerced: `get()` rejects with a fixed message, and a
 * push is dropped with no callback. Electron's `IpcRendererEvent` (which
 * carries a `sender` reference) is never passed to the renderer.
 */

type Listener = (event: unknown, payload: unknown) => void;

interface RendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

const CONNECTION_CODES: ReadonlySet<string> = new Set(CONNECTION_STATE_CODES);
const PAUSED_REASONS: ReadonlySet<string> = new Set(TERMINAL_STATUS_PAUSED_REASONS);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An ISO 8601 UTC timestamp exactly as `Date#toISOString` writes it. */
function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function isIsoOrNull(value: unknown): value is string | null {
  return value === null || isIsoUtc(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isConnectionCode(value: unknown): value is ConnectionStateCode {
  return typeof value === 'string' && CONNECTION_CODES.has(value);
}

function isPausedOrNull(value: unknown): value is TerminalStatusPausedReason | null {
  return value === null || (typeof value === 'string' && PAUSED_REASONS.has(value));
}

function parseSync(value: unknown): TerminalStatusSync | null {
  if (!isRecord(value)) return null;
  const { pending, heldPreviousPairing, deadLetter, oldestPendingAt, paused, lastSuccessAt } =
    value;
  if (!isCount(pending) || !isCount(heldPreviousPairing)) return null;
  if (!isCount(deadLetter)) return null;
  if (!isIsoOrNull(oldestPendingAt) || !isIsoOrNull(lastSuccessAt)) return null;
  if (!isPausedOrNull(paused)) return null;
  return { pending, heldPreviousPairing, deadLetter, oldestPendingAt, paused, lastSuccessAt };
}

/** The validated snapshot, rebuilt from known fields only; null if anything fails. */
export function parseTerminalStatusSnapshot(payload: unknown): TerminalStatusSnapshot | null {
  if (!isRecord(payload)) return null;
  const { v, connection, connectionSince, lastContactAt } = payload;
  if (v !== 1 || !isConnectionCode(connection)) return null;
  if (!isIsoUtc(connectionSince) || !isIsoOrNull(lastContactAt)) return null;
  const sync = parseSync(payload['sync']);
  if (sync === null) return null;
  return { v, connection, connectionSince, lastContactAt, sync };
}

export function createTerminalStatusBridge(renderer: RendererLike): TerminalStatusBridgeAPI {
  return {
    async get() {
      const snapshot = parseTerminalStatusSnapshot(
        await renderer.invoke(TERMINAL_STATUS_IPC_CHANNELS.GET, {}),
      );
      if (snapshot === null) throw new Error('terminal_status_unavailable');
      return snapshot;
    },
    onChanged(cb) {
      const listener: Listener = (_event, payload) => {
        const snapshot = parseTerminalStatusSnapshot(payload);
        if (snapshot !== null) cb(snapshot);
      };
      renderer.on(TERMINAL_STATUS_IPC_CHANNELS.CHANGED, listener);
      return () => {
        renderer.removeListener(TERMINAL_STATUS_IPC_CHANNELS.CHANGED, listener);
      };
    },
  };
}
