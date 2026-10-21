import { create } from 'zustand';
import type { OperatorBridgeAPI, UpdateStatusBridgeAPI } from '../../shared/bridge-api';
import type { UpdateStatusSnapshot } from '../../shared/update-status/types';

/**
 * RT-322 (S-B) — the renderer's update status, fed only by the read-only
 * `updateStatus` bridge. It starts with no snapshot, which shows nothing: an
 * update the cashier cannot confirm is not announced. It never polls: one read
 * on connect, then the push. Nothing else writes it.
 */

interface UpdateStatusState {
  readonly snapshot: UpdateStatusSnapshot | null;
}

export const useUpdateStatusStore = create<UpdateStatusState>()(() => ({ snapshot: null }));

function setSnapshot(snapshot: UpdateStatusSnapshot | null): void {
  useUpdateStatusStore.setState({ snapshot });
}

export function updateStatusBridge(): UpdateStatusBridgeAPI | undefined {
  const api = (window as unknown as { api?: { updateStatus?: UpdateStatusBridgeAPI } }).api;
  return api?.updateStatus;
}

/** Main's session-state push (lock, unlock, end), from the operator bridge. */
export type SessionStateEvents = Pick<OperatorBridgeAPI, 'onSessionStateChanged'>;

export function sessionStateEvents(): SessionStateEvents | undefined {
  const api = (window as unknown as { api?: { operator?: SessionStateEvents } }).api;
  return api?.operator;
}

/** Calls `cb` on each unlock (`active`); returns the unsubscribe (a no-op without events). */
function onUnlock(session: SessionStateEvents | undefined, cb: () => void): () => void {
  if (session === undefined) return () => undefined;
  return session.onSessionStateChanged((event) => {
    if (event.state === 'active') cb();
  });
}

/**
 * Subscribes to the push, then reads once. A read that was started before a
 * newer push landed is dropped. A refused read (locked session, malformed
 * answer) leaves the store as it is. While the session is locked main refuses
 * the read and the push may be missed, so an unlock (`active`) reads again.
 * The returned stop unsubscribes and forgets the snapshot, so a later mount
 * never starts from a stale one.
 */
export function connectUpdateStatus(
  bridge: UpdateStatusBridgeAPI | undefined,
  session?: SessionStateEvents,
): () => void {
  if (bridge === undefined) return () => undefined;
  let active = true;
  let pushes = 0;
  const read = (): void => {
    const seen = pushes;
    bridge
      .get()
      .then((snapshot) => {
        if (active && pushes === seen) setSnapshot(snapshot);
      })
      .catch(() => undefined);
  };
  const unsubscribe = bridge.onChanged((snapshot) => {
    if (!active) return;
    pushes += 1;
    setSnapshot(snapshot);
  });
  const unsubscribeSession = onUnlock(session, read);
  read();
  return () => {
    active = false;
    unsubscribe();
    unsubscribeSession();
    setSnapshot(null);
  };
}
