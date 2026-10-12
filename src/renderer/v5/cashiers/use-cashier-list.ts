import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CashierPinStatus,
  ListCashierPinStatusResponse,
  OperatorBridgeAPI,
} from '../../../shared/bridge-api';

/**
 * RT-424 (doc 19 §2 "Loading and re-reading") — the cashier list.
 *
 * - The first load shows no rows (`loading`).
 * - A re-read keeps the rows on screen with `reading` set (the screen disables
 *   every row action) and replaces them in one step when the answer lands.
 * - Only the latest read applies: an older answer that lands late is dropped.
 * - No polling: the screen calls `reload` on mount, after every action and on
 *   «إعادة المحاولة».
 * - The bridge rejects while the session is locked (the main-side lock
 *   guard); a rejection reads as a refusal, never an unhandled error.
 */

export type CashierListState =
  | { kind: 'loading' }
  | { kind: 'rows'; cashiers: CashierPinStatus[] }
  | { kind: 'failed'; reason: 'unreachable' | 'refused' };

type Reader = Pick<OperatorBridgeAPI, 'listCashierPinStatus'>;

const REFUSED: ListCashierPinStatusResponse = { kind: 'refused', category: 'invalid_input' };

function readList(operator: Reader): Promise<ListCashierPinStatusResponse> {
  if (operator.listCashierPinStatus === undefined) return Promise.resolve(REFUSED);
  return operator.listCashierPinStatus().catch(() => REFUSED);
}

function stateOf(res: ListCashierPinStatusResponse): CashierListState {
  if (res.kind === 'cashiers') return { kind: 'rows', cashiers: res.cashiers };
  return { kind: 'failed', reason: res.category === 'no_connection' ? 'unreachable' : 'refused' };
}

export interface CashierList {
  list: CashierListState;
  /** A read is in flight (the first load or a re-read). */
  reading: boolean;
  /**
   * Counts the reads that landed. A fast re-read can start and land inside
   * one React batch, so `reading` alone may never visibly change.
   */
  landed: number;
  reload: () => Promise<void>;
}

export function useCashierList(operator: Reader): CashierList {
  const [list, setList] = useState<CashierListState>({ kind: 'loading' });
  const [reading, setReading] = useState(true);
  const [landed, setLanded] = useState(0);
  const latest = useRef(0);
  // The bridge is read through a ref: a caller passing a fresh object each
  // render must not re-run the mount read (that would loop).
  const bridge = useRef(operator);
  bridge.current = operator;

  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++latest.current;
    setReading(true);
    const res = await readList(bridge.current);
    if (ticket !== latest.current) return;
    setList(stateOf(res));
    setReading(false);
    setLanded((n) => n + 1);
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      // Unmounted: no read that lands later may touch state.
      latest.current += 1;
    };
  }, [reload]);

  return { list, reading, landed, reload };
}
