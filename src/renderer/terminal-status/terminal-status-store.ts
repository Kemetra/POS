import { create } from 'zustand';
import type { TerminalStatusBridgeAPI } from '../../shared/bridge-api';
import type { TerminalStatusSnapshot } from '../../shared/terminal-status/types';

/**
 * RT-604 (VN-S6 S6-3) — the renderer's terminal status, fed only by the
 * `terminalStatus` bridge (RT-603). It starts with no snapshot, which the
 * indicator shows as «checking», never «online». It never polls: one read on
 * connect, then the coalesced push. Nothing else writes it (a source-scope
 * test guards that).
 */

interface TerminalStatusState {
  readonly snapshot: TerminalStatusSnapshot | null;
}

export const useTerminalStatusStore = create<TerminalStatusState>()(() => ({ snapshot: null }));

function setSnapshot(snapshot: TerminalStatusSnapshot | null): void {
  useTerminalStatusStore.setState({ snapshot });
}

export function terminalStatusBridge(): TerminalStatusBridgeAPI | undefined {
  const api = (window as unknown as { api?: { terminalStatus?: TerminalStatusBridgeAPI } }).api;
  return api?.terminalStatus;
}

/**
 * Subscribes to the push, then reads once. A push that lands first is newer
 * than the read, so the read is then dropped. A refused read (locked session,
 * malformed answer) leaves the store as it is. The returned stop unsubscribes
 * and forgets the snapshot, so a later mount never starts from a stale one.
 */
export function connectTerminalStatus(bridge: TerminalStatusBridgeAPI | undefined): () => void {
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
