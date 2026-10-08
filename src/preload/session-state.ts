import type { SessionStateEvent } from '../shared/bridge-api';
import { SESSION_LOCK_IPC_CHANNELS } from '../shared/operator/channels';

/**
 * RT-117 (RT-116 §7.2, §A4) — preload side of the main → renderer
 * session-state push on `operator:session-state`.
 *
 * Only a validated `{ state }` reaches the renderer callback: Electron's
 * `IpcRendererEvent` (which carries a `sender` reference) is never passed
 * through, and any extra payload field is dropped.
 */

type Listener = (event: unknown, payload: unknown) => void;

interface RendererLike {
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

const STATES: ReadonlySet<string> = new Set(['active', 'locked', 'ended']);

export function subscribeSessionState(
  renderer: RendererLike,
  cb: (event: SessionStateEvent) => void,
): () => void {
  const listener: Listener = (_event, payload) => {
    if (typeof payload !== 'object' || payload === null) return;
    const state = (payload as { state?: unknown }).state;
    if (typeof state !== 'string' || !STATES.has(state)) return;
    cb({ state: state as SessionStateEvent['state'] });
  };
  renderer.on(SESSION_LOCK_IPC_CHANNELS.SESSION_STATE, listener);
  return () => {
    renderer.removeListener(SESSION_LOCK_IPC_CHANNELS.SESSION_STATE, listener);
  };
}
