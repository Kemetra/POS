import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ShiftCashupBridgeAPI,
  ShiftCashupRefused,
  ShiftStatusView,
} from '../../../shared/shift-cashup/types';

/**
 * RT-17 slice 4 part 3 — the renderer's only way to main for the shift cash-up:
 * `window.api.shiftCashup`. Null when the preload has no such namespace.
 */
export function windowShiftBridge(): ShiftCashupBridgeAPI | null {
  const api = (window as unknown as { api?: { shiftCashup?: ShiftCashupBridgeAPI } }).api;
  return api?.shiftCashup ?? null;
}

/** Tests inject a bridge (null = none); production reads `window.api`. */
export function resolveShiftBridge(
  injected: ShiftCashupBridgeAPI | null | undefined,
): ShiftCashupBridgeAPI | null {
  return injected === undefined ? windowShiftBridge() : injected;
}

const UNAVAILABLE: ShiftCashupRefused = { kind: 'refused', reason: 'unavailable' };

/**
 * Run a bridge call; a rejection (never its message) becomes the generic
 * `unavailable` refusal, so no error text reaches the screen.
 */
export async function callShift<T>(call: () => Promise<T>): Promise<T | ShiftCashupRefused> {
  try {
    return await call();
  } catch {
    return UNAVAILABLE;
  }
}

export type ShiftStatusState =
  | { kind: 'loading' }
  | { kind: 'status'; status: ShiftStatusView }
  | ShiftCashupRefused;

/** The shift status, read on mount and on `reload()`; the last read wins. */
export function useShiftStatus(bridge: ShiftCashupBridgeAPI): {
  state: ShiftStatusState;
  reload: () => void;
} {
  const [state, setState] = useState<ShiftStatusState>({ kind: 'loading' });
  const latest = useRef(0);
  const reload = useCallback(() => {
    latest.current += 1;
    const ticket = latest.current;
    void callShift(() => bridge.status()).then((answer) => {
      if (ticket === latest.current) setState(answer);
    });
  }, [bridge]);
  useEffect(reload, [reload]);
  return { state, reload };
}

/**
 * One call at a time: the ref closes the gap before React re-renders the
 * disabled control, so a double press in one frame is dropped.
 */
export function useSingleFlight(): { busy: boolean; run: (fn: () => Promise<void>) => void } {
  const flying = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback((fn: () => Promise<void>) => {
    if (flying.current) return;
    flying.current = true;
    setBusy(true);
    void fn().finally(() => {
      flying.current = false;
      setBusy(false);
    });
  }, []);
  return { busy, run };
}
