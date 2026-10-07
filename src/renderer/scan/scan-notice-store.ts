import { create } from 'zustand';

/**
 * RT-239 (VNext A2) — the visible scan notice (M-S5 / M-S6 / M-S1).
 *
 * One message at a time, replaced by the next one. `seq` changes on every
 * notice, so the same text shown twice still restarts its dismissal timer and
 * is re-announced.
 */
interface ScanNoticeState {
  readonly message: string | null;
  readonly seq: number;
  show(message: string): void;
  clear(): void;
}

export const useScanNoticeStore = create<ScanNoticeState>((set, get) => ({
  message: null,
  seq: 0,
  show: (message) => {
    set({ message, seq: get().seq + 1 });
  },
  clear: () => {
    set({ message: null });
  },
}));
