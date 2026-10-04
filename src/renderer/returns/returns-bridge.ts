import { useCallback, useRef, useState } from 'react';

import type { OperatorBridgeAPI } from '../../shared/bridge-api.js';
import type { ReturnsBridgeAPI, ReturnsRefused } from '../../shared/returns/types.js';
import type { FlowNotice } from './return-flow-state.js';

/**
 * RT-15 S3 — the renderer's only way to main for returns: `window.api.returns`
 * (A1). Null when the preload has no returns namespace.
 */
export function windowReturnsBridge(): ReturnsBridgeAPI | null {
  const api = (window as unknown as { api?: { returns?: ReturnsBridgeAPI } }).api;
  return api?.returns ?? null;
}

/** Main's session-state push (lock, unlock, end), from the operator bridge. */
export type SessionEvents = Pick<OperatorBridgeAPI, 'onSessionStateChanged'>;

export function windowSessionEvents(): SessionEvents | null {
  const api = (window as unknown as { api?: { operator?: SessionEvents } }).api;
  return api?.operator ?? null;
}

/** A bridge call that rejected (e.g. refused by main while the session is locked). */
export const CALL_FAILED: unique symbol = Symbol('call_failed');

/** Run a bridge call; a rejection becomes `CALL_FAILED`, never success (O6). */
export async function attempt<T>(call: () => Promise<T>): Promise<T | typeof CALL_FAILED> {
  try {
    return await call();
  } catch {
    return CALL_FAILED;
  }
}

/** The notice for a refused or rejected call (O2, O6). */
export function failureNotice(res: ReturnsRefused | typeof CALL_FAILED): FlowNotice {
  return res === CALL_FAILED ? { kind: 'failed' } : { kind: 'refused', reason: res.reason };
}

/**
 * D1/D2/U3: one call at a time. The ref closes the gap before React re-renders
 * the disabled control, so a second click in the same frame is dropped.
 */
export function useSingleFlight<Op extends string>(): {
  readonly busy: Op | null;
  readonly run: (op: Op, fn: () => Promise<void>) => Promise<void>;
} {
  const flying = useRef(false);
  const [busy, setBusy] = useState<Op | null>(null);
  const run = useCallback(async (op: Op, fn: () => Promise<void>) => {
    if (flying.current) return;
    flying.current = true;
    setBusy(op);
    try {
      await fn();
    } finally {
      flying.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
