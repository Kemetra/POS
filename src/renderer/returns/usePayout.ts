import { useCallback, useState } from 'react';

import type {
  ReturnJournalView,
  ReturnPayoutAction,
  ReturnsBridgeAPI,
} from '../../shared/returns/types.js';
import {
  afterPayout,
  afterReprint,
  askManual,
  cancelManual,
  initialPayout,
  payoutRevision,
  refreshed,
  synced,
  type PayoutState,
} from './payout-state.js';
import { attempt, useSingleFlight } from './returns-bridge.js';

/**
 * RT-15 S4 — drives one return's payout through `returns.payout` /
 * `returns.reprintSlip`. Every call is single-flight (R4) and sends only the
 * return id and an action: the amount is main's (R6). After a payout answer
 * the journal is re-read so the history shows the true state.
 */
export type PayoutOp = 'payout' | 'reprint' | 'refresh';

export interface Payout {
  readonly state: PayoutState;
  readonly busy: PayoutOp | null;
  readonly pay: (action: ReturnPayoutAction) => Promise<void>;
  readonly reprint: () => Promise<void>;
  readonly askManual: () => void;
  readonly cancelManual: () => void;
  readonly refresh: () => Promise<void>;
}

export type Reload = () => Promise<readonly ReturnJournalView[] | null>;

export function usePayout(
  bridge: ReturnsBridgeAPI,
  ret: ReturnJournalView,
  reload: Reload,
): Payout {
  const [state, setState] = useState<PayoutState>(() => initialPayout(ret));
  // Codex P2: `ret` is not only the seed. A newer view of this return (by
  // payout revision) is adopted while rendering (React's "adjust state when a
  // prop changes"); the same view keeps what this panel learned live.
  const revision = payoutRevision(ret);
  const [seen, setSeen] = useState(revision);
  if (seen !== revision) {
    setSeen(revision);
    setState((s) => synced(s, ret));
  }
  const { busy, run } = useSingleFlight<PayoutOp>();
  const { returnId } = ret;

  const pay = useCallback(
    (action: ReturnPayoutAction) =>
      run('payout', async () => {
        const res = await attempt(() => bridge.payout({ returnId, action }));
        setState((s) => afterPayout(s, res));
        await reload();
      }),
    [bridge, reload, returnId, run],
  );

  const reprint = useCallback(
    () =>
      run('reprint', async () => {
        const res = await attempt(() => bridge.reprintSlip({ returnId }));
        setState((s) => afterReprint(s, res));
      }),
    [bridge, returnId, run],
  );

  const refresh = useCallback(
    () =>
      run('refresh', async () => {
        const rows = await reload();
        setState((s) =>
          refreshed(
            s,
            rows?.find((r) => r.returnId === returnId),
          ),
        );
      }),
    [reload, returnId, run],
  );

  return {
    state,
    busy,
    pay,
    reprint,
    askManual: () => {
      setState(askManual);
    },
    cancelManual: () => {
      setState(cancelManual);
    },
    refresh,
  };
}
