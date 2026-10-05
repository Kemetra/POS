import {
  PAIRING_INVALID_REASONS,
  PAIRING_PUSH_CHANNELS,
  type PairingInvalidReason,
  type PairingStatusChangedEvent,
} from '../shared/pairing-types';

/**
 * RT-215 — preload side of the main → renderer `pairing:status-changed` push.
 *
 * Only a validated `{ kind }` / `{ kind: 'invalid', reason }` reaches the
 * renderer callback: Electron's `IpcRendererEvent` (which carries a `sender`
 * reference) is never passed through, and any extra payload field is dropped.
 */

type Listener = (event: unknown, payload: unknown) => void;

interface RendererLike {
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

const REASONS: ReadonlySet<string> = new Set(PAIRING_INVALID_REASONS);

function parse(payload: unknown): PairingStatusChangedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { kind, reason } = payload as { kind?: unknown; reason?: unknown };
  if (kind === 'paired' || kind === 'unpaired') return { kind };
  if (kind === 'invalid' && typeof reason === 'string' && REASONS.has(reason)) {
    return { kind, reason: reason as PairingInvalidReason };
  }
  return null;
}

export function subscribePairingStatus(
  renderer: RendererLike,
  cb: (event: PairingStatusChangedEvent) => void,
): () => void {
  const listener: Listener = (_event, payload) => {
    const event = parse(payload);
    if (event !== null) cb(event);
  };
  renderer.on(PAIRING_PUSH_CHANNELS.STATUS_CHANGED, listener);
  return () => {
    renderer.removeListener(PAIRING_PUSH_CHANNELS.STATUS_CHANGED, listener);
  };
}
