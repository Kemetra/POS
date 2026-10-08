import { useCallback, useRef, useState } from 'react';

import type { ReturnJournalView, ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { attempt, CALL_FAILED, failureNotice, useSingleFlight } from './returns-bridge.js';
import { normalizeSaleNumber } from './returns-format.js';
import {
  afterCheck,
  editQuantities,
  found,
  INITIAL_FLOW,
  outcomeOf,
  pickedLines,
  quoted,
  reconcile,
  setQuantity,
  settled,
  withNotice,
  type FlowState,
  type Outcome,
} from './return-flow-state.js';
import { resolveNotice } from './useReturnHistory.js';

/**
 * RT-15 S3 — drives one return through the `returns.*` bridge.
 *
 * Every call is single-flight (D1/D2). After any submit answer the flow is in
 * `outcome`: the selection is never re-armed for a second submit (O7), and the
 * journal is re-read so the true state is on screen (H2).
 */
export type FlowOp = 'lookup' | 'quote' | 'submit' | 'check';

export interface ReturnFlow {
  readonly state: FlowState;
  readonly busy: FlowOp | null;
  readonly lookup: (raw: string) => Promise<void>;
  readonly pick: (lineRef: string, quantity: number) => void;
  readonly getQuote: () => Promise<void>;
  readonly edit: () => void;
  readonly submit: () => Promise<void>;
  readonly checkAgain: () => Promise<void>;
  readonly startOver: () => void;
  /** RT-15 S4: show a confirmed return from the journal with its payout. */
  readonly openPayout: (row: ReturnJournalView) => void;
}

type Reload = () => Promise<readonly ReturnJournalView[] | null>;

export function useReturnFlow(bridge: ReturnsBridgeAPI, reload: Reload): ReturnFlow {
  const [state, setState] = useState<FlowState>(INITIAL_FLOW);
  // The latest state for async continuations (a call reads where it started).
  const current = useRef(state);
  current.current = state;
  const { busy, run } = useSingleFlight<FlowOp>();

  const lookup = useCallback(
    (raw: string) =>
      run('lookup', async () => {
        const saleNumber = normalizeSaleNumber(raw);
        if (saleNumber === '') {
          setState((s) => withNotice(s, { kind: 'empty' }));
          return;
        }
        const res = await attempt(() => bridge.lookup({ saleNumber }));
        if (res === CALL_FAILED || res.kind === 'refused') {
          setState((s) => withNotice(s, failureNotice(res)));
          return;
        }
        setState(found(saleNumber, res.sale));
      }),
    [bridge, run],
  );

  const getQuote = useCallback(
    () =>
      run('quote', async () => {
        const s = current.current;
        if (s.step !== 'select') return;
        const lines = pickedLines(s.sale, s.picked);
        const res = await attempt(() => bridge.quote({ saleNumber: s.saleNumber, lines }));
        if (res === CALL_FAILED || res.kind === 'refused') {
          setState((x) => withNotice(x, failureNotice(res)));
          return;
        }
        setState((x) => quoted(x, res.quote));
      }),
    [bridge, run],
  );

  const submit = useCallback(
    () =>
      run('submit', async () => {
        const s = current.current;
        if (s.step !== 'summary') return;
        const lines = s.quote.lines.map((l) => ({ lineRef: l.lineRef, quantity: l.quantity }));
        const res = await attempt(() => bridge.submit({ saleNumber: s.saleNumber, lines }));
        setState(settled(res === CALL_FAILED ? { kind: 'failed' } : outcomeOf(res)));
        await reload();
      }),
    [bridge, reload, run],
  );

  const checkAgain = useCallback(
    () =>
      run('check', async () => {
        const s = current.current;
        if (s.step !== 'outcome' || s.outcome.kind !== 'unconfirmed') return;
        const { ret } = s.outcome;
        const notice = resolveNotice(await attempt(() => bridge.resolve()));
        const apply = (next: Outcome): void => {
          setState((x) => afterCheck(x, next));
        };
        if (notice !== null) {
          apply({ kind: 'unconfirmed', ret, still: false, notice });
          return;
        }
        const rows = await reload();
        apply(
          reconcile(
            ret,
            rows?.find((r) => r.returnId === ret.returnId),
          ),
        );
      }),
    [bridge, reload, run],
  );

  const pick = useCallback((lineRef: string, quantity: number) => {
    setState((s) => setQuantity(s, lineRef, quantity));
  }, []);
  const edit = useCallback(() => {
    setState(editQuantities);
  }, []);
  const startOver = useCallback(() => {
    setState(INITIAL_FLOW);
  }, []);
  const openPayout = useCallback((row: ReturnJournalView) => {
    setState(settled({ kind: 'confirmed', ret: row, replayed: false }));
  }, []);

  return { state, busy, lookup, pick, getQuote, edit, submit, checkAgain, startOver, openPayout };
}
