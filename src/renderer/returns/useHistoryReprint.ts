import { useCallback, useState } from 'react';

import type { ReturnSlipStatus, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { attempt, CALL_FAILED, useSingleFlight } from './returns-bridge.js';

/**
 * RT-15 S4 — reprint a paid-out return's slip (a copy) from the journal.
 * Single-flight across the whole list (R4): one print at a time.
 */
export interface HistoryReprint {
  readonly run: (returnId: string) => Promise<void>;
  /** The return whose copy is printing now, if any. */
  readonly printing: string | null;
  /** The last reprint's result, for the notice above the list. */
  readonly result: ReturnSlipStatus | null;
}

export function useHistoryReprint(bridge: ReturnsBridgeAPI): HistoryReprint {
  const { run: once } = useSingleFlight<'reprint'>();
  const [printing, setPrinting] = useState<string | null>(null);
  const [result, setResult] = useState<ReturnSlipStatus | null>(null);

  const run = useCallback(
    (returnId: string) =>
      once('reprint', async () => {
        setPrinting(returnId);
        const res = await attempt(() => bridge.reprintSlip({ returnId }));
        setResult(res !== CALL_FAILED && res.kind === 'printed' ? 'printed' : 'failed');
        setPrinting(null);
      }),
    [bridge, once],
  );

  return { run, printing, result };
}
