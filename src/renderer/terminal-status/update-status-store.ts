import { create } from 'zustand';
import type { UpdateStatusBridgeAPI } from '../../shared/bridge-api';
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

/**
 * Subscribes to the push, then reads once. A push that lands first is newer
 * than the read, so the read is then dropped. A refused read (locked session,
 * malformed answer) leaves the store as it is. The returned stop unsubscribes
 * and forgets the snapshot, so a later mount never starts from a stale one.
 */
export function connectUpdateStatus(bridge: UpdateStatusBridgeAPI | undefined): () => void {
  if (bridge === undefined) return () => undefined;
  let active = true;
  let pushed = false;
  const unsubscribe = bridge.onChanged((snapshot) => {
    if (!active) return;
    pushed = true;
    setSnapshot(snapshot);
  });
  bridge
    .get()
    .then((snapshot) => {
      if (active && !pushed) setSnapshot(snapshot);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
    setSnapshot(null);
  };
}
