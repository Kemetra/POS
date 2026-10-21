import type { UpdateStatusBridgeAPI } from '../shared/bridge-api.js';
import {
  UPDATE_STATUS_IPC_CHANNELS,
  isDetailCode,
  isUpdateStatusBlocker,
  isUpdateStatusState,
  isVersionString,
  type UpdateStatusBlocker,
  type UpdateStatusSnapshot,
} from '../shared/update-status/types.js';

/**
 * RT-322 (S-B) — preload side of the update status bridge: `get()` over
 * `updateStatus:get` and `onChanged(cb)` over the `updateStatus:changed` push.
 * Read-only: no install trigger, no channel or origin setter.
 *
 * `parse` checks every field against its closed set or shape and rebuilds the
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBlockers(value: unknown): readonly UpdateStatusBlocker[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) return null;
  return value.every(isUpdateStatusBlocker) ? value : null;
}

/** The validated snapshot, rebuilt from known fields only; null if anything fails. */
export function parseUpdateStatusSnapshot(payload: unknown): UpdateStatusSnapshot | null {
  if (!isRecord(payload)) return null;
  const { v, state, detail, availableVersion } = payload;
  if (v !== 1 || !isUpdateStatusState(state)) return null;
  if (detail !== undefined && !isDetailCode(detail)) return null;
  if (availableVersion !== undefined && !isVersionString(availableVersion)) return null;
  const blockers = parseBlockers(payload['blockers']);
  if (blockers === null) return null;
  return {
    v,
    state,
    ...(detail === undefined ? {} : { detail }),
    ...(availableVersion === undefined ? {} : { availableVersion }),
    ...(blockers === undefined ? {} : { blockers: [...blockers] }),
  };
}

export function createUpdateStatusBridge(renderer: RendererLike): UpdateStatusBridgeAPI {
  return {
    async get() {
      const snapshot = parseUpdateStatusSnapshot(
        await renderer.invoke(UPDATE_STATUS_IPC_CHANNELS.GET, {}),
      );
      if (snapshot === null) throw new Error('update_status_unavailable');
      return snapshot;
    },
    onChanged(cb) {
      const listener: Listener = (_event, payload) => {
        const snapshot = parseUpdateStatusSnapshot(payload);
        if (snapshot !== null) cb(snapshot);
      };
      renderer.on(UPDATE_STATUS_IPC_CHANNELS.CHANGED, listener);
      return () => {
        renderer.removeListener(UPDATE_STATUS_IPC_CHANNELS.CHANGED, listener);
      };
    },
  };
}
