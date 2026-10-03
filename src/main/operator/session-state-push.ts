import type { SessionStateEvent } from '../../shared/bridge-api.js';

import type { SessionManager } from './session-manager.js';

/**
 * RT-117 (RT-116 §7.2) — main → renderer session-state push.
 *
 * The first push primitive in POS-Pulse. Main sends `{ state }` on
 * `operator:session-state` the moment the session locks, unlocks or ends, so
 * the renderer shows (or clears) the lock screen immediately (RT-112 RC-2).
 *
 * Security boundary (§A4): the payload is the state ONLY — no session id,
 * operator id, role, name or credential. Anything the lock screen needs is
 * read through `operator.getLockState()`, which applies its own projection.
 */

export interface SessionStatePushDeps {
  sessionManager: SessionManager;
  /** Delivers one event to the renderer window(s). */
  send: (event: SessionStateEvent) => void;
  logError?: (err: unknown) => void;
}

export function wireSessionStatePush(deps: SessionStatePushDeps): void {
  const { sessionManager, send, logError } = deps;
  const deliver = (event: SessionStateEvent): void => {
    try {
      send(event);
    } catch (err) {
      logError?.(err);
    }
  };
  sessionManager.onLockStateChanged((record) => {
    deliver({ state: record.lock_state });
  });
  sessionManager.onEnded(() => {
    deliver({ state: 'ended' });
  });
}
