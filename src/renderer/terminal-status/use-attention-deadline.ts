import { useEffect, useState } from 'react';
import type { TerminalStatusSnapshot } from '../../shared/terminal-status/types';
import { syncAttentionDueAt } from './status-mapping';

/**
 * RT-604 / RT-605 (VN-S6) — re-renders once when the oldest pending sale
 * passes the 24 h attention line (D-6-5). One timer for that moment, never a
 * poll; a new snapshot re-arms it. Shared by the indicator and the banners so
 * both cross the line together, from the one `syncAttentionDueAt` rule.
 */
export function useAttentionDeadline(snapshot: TerminalStatusSnapshot | null): void {
  const [, setPassed] = useState(0);
  useEffect(() => {
    const due = syncAttentionDueAt(snapshot);
    if (due === null) return;
    const wait = due - Date.now() + 1;
    if (wait <= 0) return;
    const handle = setTimeout(() => {
      setPassed((n) => n + 1);
    }, wait);
    return () => {
      clearTimeout(handle);
    };
  }, [snapshot]);
}
