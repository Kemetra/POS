import { useCallback, useEffect, useState } from 'react';

import type {
  ReturnJournalView,
  ReturnsBridgeAPI,
  ReturnsRefusalReason,
} from '../../shared/returns/types.js';
import {
  attempt,
  CALL_FAILED,
  failureNotice,
  useSingleFlight,
  type SessionEvents,
} from './returns-bridge.js';
import type { FlowNotice } from './return-flow-state.js';

/**
 * RT-15 S3 — this terminal's return journal, as main lists it (H1..H4).
 * The journal is the truth after an unconfirmed or session-changed submit,
 * so a failed read is never final: it can be reloaded by hand and is re-read
 * automatically when the session becomes active again (unlock).
 */
export type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly rows: readonly ReturnJournalView[] }
  | { readonly status: 'refused'; readonly reason: ReturnsRefusalReason }
  | { readonly status: 'failed' };

export interface ReturnHistory {
  readonly state: HistoryState;
  /**
   * The rows of the last successful listing, kept across a failed or refused
   * reload, for the payout already open (it shows that return anyway): a
   * missing list never puts an older view of it back (reviewer P2, 49e0277).
   * They belong to one operator: the screen is keyed by the operator session
   * id, so another operator starts with none (S1).
   */
  readonly known: readonly ReturnJournalView[];
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

export function useReturnHistory(
  bridge: ReturnsBridgeAPI,
  sessionEvents: SessionEvents | null,
): ReturnHistory {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [checkNotice, setCheckNotice] = useState<FlowNotice | null>(null);
  const [known, setKnown] = useState<readonly ReturnJournalView[]>([]);
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
    setKnown(res.returns);
    return res.returns;
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // H4: every `returns.*` call is refused while the session is locked, so a
  // read that failed under the lock is repeated the moment it lifts.
  useEffect(() => {
    if (sessionEvents === null) return undefined;
    return sessionEvents.onSessionStateChanged((event) => {
      if (event.state === 'active') void reload();
    });
  }, [sessionEvents, reload]);

  const checkUnresolved = useCallback(
    () =>
      run('check', async () => {
        setCheckNotice(resolveNotice(await attempt(() => bridge.resolve())));
        await reload();
      }),
    [bridge, reload, run],
  );

  return { state, known, reload, checkUnresolved, checking: busy === 'check', checkNotice };
}
