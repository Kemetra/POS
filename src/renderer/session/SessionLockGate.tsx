import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import type { LockStateView, OperatorBridgeAPI } from '../../shared/bridge-api';
import { useOperatorSessionStore } from '../stores/operator-session-store';
import { focusScanOwner } from '../scan/scan-anchor';
import { LockScreen } from './LockScreen';

/**
 * RT-117 (RT-116 §2, §7.2) — renderer side of the inactivity lock.
 *
 * Main owns the lock. This gate only reflects it:
 *   • on mount it reads `getLockState()` (the renderer may reload while locked);
 *   • on every `onSessionStateChanged` push it shows or clears the lock screen
 *     immediately (RT-112 RC-2: the renderer used to learn nothing).
 *
 * The app stays MOUNTED under the lock and is made `inert`, so the exact sale
 * on screen — cart, checkout, entered amounts — is preserved for the same
 * operator. It is also concealed (RT-161): the lock shows totals only, so the
 * sale behind it must not be readable on an unattended till. The operator-session store is untouched (still signed in), so the
 * cart/payment reset hook never fires on a lock.
 *
 * RT-113 P2 — main can now END a session on its own (the cashier admission
 * heartbeat: taken over on another till, account refused, device revoked). An
 * `ended` push therefore also moves a signed-in renderer to signed-out, so the
 * route guard returns it to /sign-in instead of leaving a dead screen. A
 * renderer-initiated sign-out reaches the same state; both paths are no-ops
 * once signed out. An `ended` push during an in-flight sign-in or takeover
 * confirm is recorded against that attempt, so its late `signed_in` is
 * discarded (Codex P2 4179701431).
 */

export type SessionLockOperator = Pick<
  OperatorBridgeAPI,
  'getLockState' | 'unlockSession' | 'onSessionStateChanged'
>;

export interface SessionLockGateProps {
  operator: SessionLockOperator;
  children: ReactNode;
}

export function SessionLockGate({ operator, children }: SessionLockGateProps): JSX.Element {
  const [lockView, setLockView] = useState<LockStateView | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const view = await operator.getLockState();
      setLockView(view.state === 'locked' ? view : null);
    } catch {
      // A failed read leaves the current display; main still enforces the lock.
    }
  }, [operator]);

  useEffect(() => {
    void refresh();
    const unsubscribe = operator.onSessionStateChanged((event) => {
      if (event.state === 'locked') {
        void refresh();
        return;
      }
      setLockView(null);
      if (event.state === 'ended') useOperatorSessionStore.getState().sessionEndedByMain();
    });
    return unsubscribe;
  }, [operator, refresh]);

  const locked = lockView !== null;

  // RT-239 rule 6: the Sale stays mounted under the lock, so its own mount focus
  // never runs again. When the lock closes, the scan owner takes focus back
  // (a no-op on any screen that has no scan anchor).
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && !locked) focusScanOwner();
    wasLocked.current = locked;
  }, [locked]);
  return (
    <>
      <div
        data-testid="session-lock-app"
        inert={locked}
        className={locked ? 'session-lock-app session-lock-app--concealed' : 'session-lock-app'}
      >
        {children}
      </div>
      {lockView !== null && (
        <LockScreen
          view={lockView}
          unlock={(req) => operator.unlockSession(req)}
          onUnlocked={() => {
            setLockView(null);
          }}
        />
      )}
    </>
  );
}
