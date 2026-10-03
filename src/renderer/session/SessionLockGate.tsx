import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import type { LockStateView, OperatorBridgeAPI } from '../../shared/bridge-api';
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
      } else {
        setLockView(null);
      }
    });
    return unsubscribe;
  }, [operator, refresh]);

  const locked = lockView !== null;
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
