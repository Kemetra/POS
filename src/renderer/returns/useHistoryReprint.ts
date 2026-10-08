import { useCallback, useState } from 'react';

import type { ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { reprintResult, type ReprintResult } from './payout-state.js';
import { attempt, useSingleFlight } from './returns-bridge.js';

/**
 * RT-15 S4 — reprint a paid-out return's slip (a copy) from the journal.
 * Single-flight across the whole list (R4): one print at a time.
 */
export interface HistoryReprint {
  readonly run: (returnId: string) => Promise<void>;
  /** The return whose copy is printing now, if any. */
  readonly printing: string | null;
  /** The last reprint's result, for the notice above the list. */
  readonly result: ReprintResult | null;
}

export function useHistoryReprint(bridge: ReturnsBridgeAPI): HistoryReprint {
  const { run: once } = useSingleFlight<'reprint'>();
  const [printing, setPrinting] = useState<string | null>(null);
  const [result, setResult] = useState<ReprintResult | null>(null);

  const run = useCallback(
    (returnId: string) =>
      once('reprint', async () => {
        setPrinting(returnId);
        const res = await attempt(() => bridge.reprintSlip({ returnId }));
        setResult(reprintResult(res));
        setPrinting(null);
      }),
    [bridge, once],
  );

  return { run, printing, result };
}
