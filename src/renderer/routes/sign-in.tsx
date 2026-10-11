import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import type {
  OperatorBridgeAPI,
  BranchRosterCashier,
  PairingBridgeAPI,
} from '../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../stores/operator-session-store.js';
import { completeHydratedSignIn, completeSignIn } from '../session/complete-sign-in.js';
import { RosterList, type RosterEntry } from '../ui/operator/RosterList.js';
import { ManagerAdminSignInForm } from '../ui/operator/ManagerAdminSignInForm.js';
import { PinPad, PinPadPreview } from '../ui/operator/PinPad.js';
import { TakeoverPrompt } from '../ui/operator/TakeoverPrompt.js';
import { SIGN_IN_REFUSAL_COPY } from '../ui/operator/messages.js';
import { EntryStrip, useTerminalLabel } from '../v5/entry/EntryStrip.js';
import { RefusalNotice } from '../v5/entry/RefusalNotice.js';
import {
  AuthHeading,
  AuthPanel,
  BackButton,
  PickedCashier,
  RosterPanel,
  pinPromptFor,
  type RosterState,
} from '../v5/entry/SignInPanels.js';
import { SIGN_IN_COPY } from '../v5/entry/entry-copy.js';
import '../v5/entry/entry.css';

/**
 * 004-operator-session T029 / T075 / T077 — `/sign-in` route.
 *
 *   - Roster fetch on mount via `operator.listBranchRoster()`.
 *   - Cashier selection → PinPad shown (Surface 4).
 *   - PIN submit → `operator.signIn({kind:'cashier',...})`.
 *   - `signed_in`        → resolveSignedIn (router redirects to /app/*)
 *   - `takeover_required` → promptTakeover (TakeoverPrompt modal shown)
 *   - `refused`          → inline alert (Note 1 invariant: alert XOR spinner)
 *   - `cancelTakeover`   → back to cashier PIN entry
 *
 * RT-244 (VNext W1-D) recomposes the screen on the owner-approved G-1
 * references (RT-246): one stage, two zones. The roster ("who are you") is the
 * inline start; the inline end is one fixed column that holds the PIN pad, or
 * the manager form when «دخول المدير» is pressed. The keypad is in view before a
 * name is picked (disabled), so picking never reflows the layout. Behaviour is
 * unchanged: no roster retry, no offline sign-in, one generic message per
 * refusal category (P11 / PR-2).
 *
 * #101 boundary: no terminal-A invalidation, no 30-second assertion,
 * no T056 assertion. getCurrentSession is local-only until #101.
 */

export interface SignInRouteProps {
  operator: OperatorBridgeAPI;
  /** Read once for the terminal label in the context strip. Optional. */
  pairing?: PairingBridgeAPI;
}

type Mode = 'cashier' | 'manager';

export function SignInRoute(props: SignInRouteProps): JSX.Element {
  const { operator } = props;
  const fsm = useOperatorSessionStore((s) => s.state);
  const navigate = useNavigate();
  const terminalLabel = useTerminalLabel(props.pairing);

  // Once the FSM reaches `signedIn` the router is still parked on /sign-in;
  // this effect is the seam that moves a signed-in operator into /app.
  useEffect(() => {
    if (fsm.kind === 'signedIn') {
      void navigate('/app', { replace: true });
    }
  }, [fsm.kind, navigate]);

  const [cashiers, setCashiers] = useState<ReadonlyArray<BranchRosterCashier>>([]);
  const [rosterState, setRosterState] = useState<RosterState>('loading');
  const [mode, setMode] = useState<Mode>('cashier');
  const [selectedCashier, setSelectedCashier] = useState<RosterEntry | undefined>(undefined);
  const [pin, setPin] = useState('');
  const [cashierError, setCashierError] = useState<string | undefined>(undefined);

  // Boot hydration: a session the main process already holds (e.g. seeded by
  // the dev bypass) routes past /sign-in without user input.
  useEffect(() => {
    let cancelled = false;
    operator
      .getCurrentSession()
      .then(async (session) => {
        if (cancelled || session === null) return;
        // RT-352 — adopt the session's draft cart too (e.g. after a renderer reload).
        await completeHydratedSignIn(operator, session);
      })
      .catch(() => {
        // IPC failure — keep current signedOut state silently.
      });
    return () => {
      cancelled = true;
    };
  }, [operator]);

  // Fetch the roster once on mount (no retry: RT-246 decision). The screen
  // states what the fetch proved — tiles, offline, refused or empty.
  useEffect(() => {
    let cancelled = false;
    operator
      .listBranchRoster()
      .then((res) => {
        if (cancelled) return;
        if (res.kind === 'roster') {
          setCashiers(res.cashiers);
          setRosterState(res.cashiers.length > 0 ? 'ready' : 'empty');
        } else {
          setRosterState(res.category === 'no_connection' ? 'offline' : 'refused');
        }
      })
      .catch(() => {
        if (!cancelled) setRosterState('refused');
      });
    return () => {
      cancelled = true;
    };
  }, [operator]);

  const clearCashier = (): void => {
    setSelectedCashier(undefined);
    setPin('');
    setCashierError(undefined);
  };

  // A sign-in in flight owns the column: switching it would unmount the form
  // that is waiting for the answer, and the answer would land on the wrong
  // panel (or nowhere). The tiles and the manager toggle are inert meanwhile.
  const handleCashierSelect = (cashier: RosterEntry): void => {
    if (fsm.kind === 'signingIn') return;
    // Clear PIN and error whenever a new cashier is selected.
    if (mode === 'manager') useOperatorSessionStore.getState().clearRefusal();
    setMode('cashier');
    setSelectedCashier(cashier);
    setPin('');
    setCashierError(undefined);
  };

  const switchMode = (next: Mode): void => {
    if (fsm.kind === 'signingIn') return;
    // The refusal lives in the shared FSM: never carry one path's refusal
    // into the other path's panel.
    useOperatorSessionStore.getState().clearRefusal();
    clearCashier();
    setMode(next);
  };

  const handleManagerEntry = (): void => {
    switchMode(mode === 'manager' ? 'cashier' : 'manager');
  };

  const handlePinChange = (newPin: string): void => {
    setPin(newPin);
    // Clear error on first new digit (Note 1 parity for cashier path).
    if (cashierError !== undefined) setCashierError(undefined);
  };

  const handleCashierSubmit = (): void => {
    if (fsm.kind === 'signingIn') return; // re-entry guard
    if (selectedCashier === undefined || pin.length === 0) return;
    useOperatorSessionStore.getState().beginSignIn();
    void runCashierSignIn(selectedCashier, pin);
  };

  const runCashierSignIn = async (cashier: RosterEntry, pinValue: string): Promise<void> => {
    try {
      const response = await operator.signIn({
        kind: 'cashier',
        cashier_clerk_user_id: cashier.id,
        pin: pinValue,
        display_name: cashier.display_name,
      });
      // Clear PIN immediately on resolution (PR-1 defence in depth).
      setPin('');
      if (response.kind === 'signed_in') {
        // RT-352 — adopt the re-attached draft before routing into the Sale.
        await completeSignIn(operator, response.session, response.forced_close_notice);
      } else if (response.kind === 'takeover_required') {
        useOperatorSessionStore.getState().promptTakeover(response.pending_takeover_id);
      } else {
        useOperatorSessionStore.getState().refuseSignIn(response.category);
        setCashierError(SIGN_IN_REFUSAL_COPY[response.category]);
      }
    } catch {
      // IPC panic — generic refusal (PR-1: no message echo).
      setPin('');
      useOperatorSessionStore.getState().refuseSignIn('invalid_input');
      setCashierError(SIGN_IN_REFUSAL_COPY.invalid_input);
    }
  };

  const isSigningIn = fsm.kind === 'signingIn';

  // When the FSM transitions back to signedOut (after cancel or refusal),
  // clear the PIN; the selected cashier stays so the user can retry.
  useEffect(() => {
    if (fsm.kind === 'signedOut') {
      setPin('');
    }
  }, [fsm.kind]);

  // TakeoverPrompt overlay — rendered when FSM is in takeoverPrompt state.
  if (fsm.kind === 'takeoverPrompt') {
    return (
      <main data-testid="route-sign-in" className="v4-screen" dir="rtl">
        <TakeoverPrompt operator={operator} pending_takeover_id={fsm.pending_takeover_id} />
      </main>
    );
  }

  const rosterEntries: RosterEntry[] = cashiers.map((c) => ({
    id: c.id,
    display_name: c.display_name,
    role: c.role,
  }));

  return (
    <main data-testid="route-sign-in" className="v5-entry" dir="rtl" lang="ar">
      <EntryStrip {...(terminalLabel !== undefined ? { terminalLabel } : {})} />
      <div className="v5-entry__stage">
        <div className="v5-entry__head">
          <h1 className="v5-entry__title">{SIGN_IN_COPY.title}</h1>
          <p className="v5-entry__subtitle">{SIGN_IN_COPY.subtitle}</p>
        </div>

        <RosterPanel
          state={rosterState}
          managerMode={mode === 'manager'}
          onManagerEntry={handleManagerEntry}
          disabled={isSigningIn}
          roster={
            <RosterList
              cashiers={rosterEntries}
              inert={rosterState !== 'ready'}
              onSelect={handleCashierSelect}
              selectedId={selectedCashier?.id}
              disabled={isSigningIn}
            />
          }
        />

        {mode === 'manager' ? (
          <AuthPanel
            head={
              <>
                <div className="v5-entry__auth-who">
                  <AuthHeading>{SIGN_IN_COPY.managerHeading}</AuthHeading>
                </div>
                <BackButton
                  testId="sign-in-manager-back"
                  disabled={isSigningIn}
                  onClick={() => {
                    switchMode('cashier');
                  }}
                />
              </>
            }
          >
            <ManagerAdminSignInForm operator={operator} />
          </AuthPanel>
        ) : selectedCashier === undefined ? (
          <AuthPanel head={<AuthHeading>{SIGN_IN_COPY.pinHeading}</AuthHeading>}>
            <div className="v5-entry__auth-body">
              <PinPadPreview prompt={pinPromptFor(rosterState)} />
            </div>
          </AuthPanel>
        ) : (
          <AuthPanel
            head={
              <>
                <PickedCashier name={selectedCashier.display_name} />
                <BackButton
                  testId="cashier-pin-cancel"
                  disabled={isSigningIn}
                  onClick={clearCashier}
                />
              </>
            }
          >
            <div
              className="v5-entry__auth-body"
              data-testid="pin-section"
              data-error={cashierError !== undefined || undefined}
            >
              <PinPad
                value={pin}
                onChange={handlePinChange}
                onSubmit={handleCashierSubmit}
                disabled={isSigningIn}
                error={cashierError !== undefined}
                submitLabel={SIGN_IN_COPY.submit}
                autoFocus
                {...(cashierError !== undefined ? { describedBy: 'cashier-sign-in-error' } : {})}
                feedback={
                  // Note 1 invariant — alert XOR spinner, one live region.
                  <div role="status" aria-live="polite">
                    {isSigningIn ? (
                      <span className="v5-entry__status" data-testid="cashier-sign-in-spinner">
                        {SIGN_IN_COPY.signingIn}
                      </span>
                    ) : cashierError !== undefined ? (
                      <RefusalNotice testId="cashier-sign-in-error" id="cashier-sign-in-error">
                        {cashierError}
                      </RefusalNotice>
                    ) : null}
                  </div>
                }
              />
            </div>
          </AuthPanel>
        )}
      </div>
    </main>
  );
}
