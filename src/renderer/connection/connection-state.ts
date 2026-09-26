import { create } from 'zustand';
import type { ConnectionState } from '../ui/tokens/connection-state';

/**
 * T028 — Connection-state zustand slice.
 *
 * Four-state enum with a single setter. No side-effect listeners.
 * The `syncing` state is visual-only — no sync queue, no fetch,
 * no IPC, no persistence (contracts/shell-regions.md §"syncing hard
 * non-implementation list").
 */

interface ConnectionStateSlice {
  state: ConnectionState;
  setState: (next: ConnectionState) => void;
}

export const useConnectionStateStore = create<ConnectionStateSlice>()((set) => ({
  state: 'online',
  setState: (next) => {
    set({ state: next });
  },
}));

export function useConnectionState(): ConnectionStateSlice {
  return useConnectionStateStore();
}

/**
 * Persistent banner copy for every non-online state (Arabic-first, POS v3.5
 * prototype copy). Shared by the legacy TopBar and the v5 frame so both say
 * the same thing. Connection failure is a banner, never a toast (FR-25).
 */
export const CONNECTION_BANNER_MESSAGES: Record<Exclude<ConnectionState, 'online'>, string> = {
  degraded: 'الاتصال بطيء — Connection slow',
  offline: 'غير متصل — البيع من قائمة الانتظار المحلية',
  syncing: 'جارٍ المزامنة…',
};
