import { useCallback, useEffect, useState } from 'react';

import type {
  ReturnJournalView,
  ReturnsBridgeAPI,
  ReturnsRefusalReason,
} from '../../shared/returns/types.js';
import { attempt, CALL_FAILED, failureNotice, useSingleFlight } from './returns-bridge.js';
import type { FlowNotice } from './return-flow-state.js';

/**
 * RT-15 S3 — this terminal's return journal, as main lists it (H1..H3).
 * The journal is the truth after an unconfirmed or session-changed submit.
 */
export type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly rows: readonly ReturnJournalView[] }
  | { readonly status: 'refused'; readonly reason: ReturnsRefusalReason }
  | { readonly status: 'failed' };

export interface ReturnHistory {
  readonly state: HistoryState;
  /** Re-read the journal; the rows, or null when main did not list them. */
  readonly reload: () => Promise<readonly ReturnJournalView[] | null>;
  /** Ask main to re-send unresolved returns, then re-read the journal. */
  readonly checkUnresolved: () => Promise<void>;
  readonly checking: boolean;
  readonly checkNotice: FlowNotice | null;
}

/** The notice for a `resolve` answer, or null when main resolved. */
export function resolveNotice(
  res: Awaited<ReturnType<ReturnsBridgeAPI['resolve']>> | typeof CALL_FAILED,
): FlowNotice | null {
  return res === CALL_FAILED || res.kind === 'refused' ? failureNotice(res) : null;
}

export function useReturnHistory(bridge: ReturnsBridgeAPI): ReturnHistory {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [checkNotice, setCheckNotice] = useState<FlowNotice | null>(null);
  const { busy, run } = useSingleFlight<'check'>();

  const reload = useCallback(async () => {
    const res = await attempt(() => bridge.list());
    if (res === CALL_FAILED) {
      setState({ status: 'failed' });
      return null;
    }
    if (res.kind === 'refused') {
      setState({ status: 'refused', reason: res.reason });
      return null;
    }
    setState({ status: 'ok', rows: res.returns });
    return res.returns;
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const checkUnresolved = useCallback(
    () =>
      run('check', async () => {
        setCheckNotice(resolveNotice(await attempt(() => bridge.resolve())));
        await reload();
      }),
    [bridge, reload, run],
  );

  return { state, reload, checkUnresolved, checking: busy === 'check', checkNotice };
}
