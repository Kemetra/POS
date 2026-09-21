import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import type { OperatorBridgeAPI, BranchRosterCashier } from '../../shared/bridge-api.js';
import type { Role } from '../../shared/operator/role.js';
import { useOperatorSessionStore } from '../stores/operator-session-store.js';
import { RosterList, type RosterEntry } from '../ui/operator/RosterList.js';
import { ManagerAdminSignInForm } from '../ui/operator/ManagerAdminSignInForm.js';
import { PinPad } from '../ui/operator/PinPad.js';
import { TakeoverPrompt } from '../ui/operator/TakeoverPrompt.js';
import { SIGN_IN_REFUSAL_COPY } from '../ui/operator/messages.js';

/**
 * 004-operator-session T029 / T075 / T077 — `/sign-in` route.
 *
 * S4 activates:
 *   - Roster fetch on mount via `operator.listBranchRoster()`.
 *   - Cashier selection → PinPad shown (Surface 4).
 *   - PIN submit → `operator.signIn({kind:'cashier',...})`.
 *   - `signed_in`        → resolveSignedIn (router redirects to /app/*)
 *   - `takeover_required` → promptTakeover (TakeoverPrompt modal shown)
 *   - `refused`          → inline alert (Note 1 invariant: alert XOR spinner)
 *   - `cancelTakeover`   → back to cashier PIN entry
 *
 * #101 boundary: no terminal-A invalidation, no 30-second assertion,
 * no T056 assertion. Terminal A discovers session invalidation only after
 * a backend-validated call fails, an app restart, or once #101 implements
 * backend probe/push. getCurrentSession is local-only until #101.
 */

export interface SignInRouteProps {
  operator: OperatorBridgeAPI;
}

/**
 * Role → Arabic business name (Arabic-first copy, v3.5 recompose).
 *
 * The prototype `SignInScreen` carries a `ROLE_NAMES` map; we re-declare the
 * mapping locally (do NOT import prototype code) so the route renders the
 * operator's role in Arabic. This is purely presentational — it never feeds
 * auth, which stays IPC-backed (`operator.signIn`).
 */
const ROLE_NAME_AR: Readonly<Record<Role, string>> = Object.freeze({
  cashier: 'صيدلي',
  manager: 'مدير الصيدلية',
  admin: 'مشرف',
});

export function SignInRoute(props: SignInRouteProps): JSX.Element {
  const { operator } = props;
  const fsm = useOperatorSessionStore((s) => s.state);
  const navigate = useNavigate();

  // Once the FSM reaches `signedIn` — via the manager/admin form, the
  // cashier PIN path, a confirmed takeover, or boot-time hydration — the
  // operator is authenticated but the router is still parked on
  // `/sign-in`. The path-based router only pulls a signed-out user OUT of
  // `/app` (OperatorRouteGuard); nothing pushes a signed-in user IN. This
  // effect is that missing seam — the sign-in counterpart to the pairing
  // flow's `navigate('/paired')`. `replace` mirrors the `<Navigate replace>`
  // convention so Back does not return to the sign-in screen.
  useEffect(() => {
    if (fsm.kind === 'signedIn') {
      void navigate('/app', { replace: true });
    }
  }, [fsm.kind, navigate]);

  const [cashiers, setCashiers] = useState<ReadonlyArray<BranchRosterCashier>>([]);
  const [rosterError, setRosterError] = useState<string | undefined>(undefined);
  const [selectedCashier, setSelectedCashier] = useState<RosterEntry | undefined>(undefined);
  const [pin, setPin] = useState('');
  const [cashierError, setCashierError] = useState<string | undefined>(undefined);

  // On mount, check whether the main process already holds an operator session
  // (e.g. seeded by the dev bypass). If so, hydrate the store directly so
  // existing guard/router logic can route past /sign-in without user input.
  useEffect(() => {
    let cancelled = false;
    operator
      .getCurrentSession()
      .then((session) => {
        if (cancelled) return;
        if (session !== null) {
          useOperatorSessionStore.getState().hydrateSignedIn(session);
        }
      })
      .catch(() => {
        // IPC failure — keep current signedOut state silently.
      });
    return () => {
      cancelled = true;
    };
  }, [operator]);

  // Fetch roster on mount. Failure is soft — the roster renders inert
  // and the manager/admin form remains available.
  useEffect(() => {
    let cancelled = false;
    operator
      .listBranchRoster()
      .then((res) => {
        if (cancelled) return;
        if (res.kind === 'roster') {
          setCashiers(res.cashiers);
        } else {
          // Roster unavailable (not signed in, role mismatch, etc.)
          // Render inert — not an error the user needs to act on here.
          setRosterError(
            res.category === 'no_connection' ? SIGN_IN_REFUSAL_COPY.no_connection : undefined,
          );
        }
      })
      .catch(() => {
        // Swallow — roster is best-effort at this screen.
        if (!cancelled) setRosterError(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [operator]);

  const handleCashierSelect = (cashier: RosterEntry): void => {
    // Clear PIN and error whenever a new cashier is selected.
    setSelectedCashier(cashier);
    setPin('');
    setCashierError(undefined);
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
        useOperatorSessionStore
          .getState()
          .resolveSignedIn(response.session, response.forced_close_notice);
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
  // clear the selected cashier and PIN so the UI resets cleanly.
  useEffect(() => {
    if (fsm.kind === 'signedOut') {
      setPin('');
      // Don't clear selectedCashier — allow the user to retry.
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
    // 022 hard reset — v4 composition. Three RTL column tracks, reading from the
    // inline start: identity/staff-code rail, cashier roster (the widest track,
    // it carries the primary choice), and the PIN column.
    //
    // The v3.5 shape was a two-column split where the PIN pad appeared INLINE
    // beneath the roster, so choosing a cashier reflowed the surface and pushed
    // the keypad below the fold. The reference gives the keypad its own
    // persistent column; that is the structural change, not a restyle.
    //
    // Geometry comes from the shared v4 layout vocabulary (`.v4-*`), not from
    // per-screen BEM. No `sign-in-route__*` / `sign-in-pane__*` / `sign-in-split`
    // class survives here.
    <main data-testid="route-sign-in" className="v4-screen" dir="rtl">
      <header className="v4-screen__header">
        <div>
          <h1 className="v4-screen__title">تسجيل دخول الصيدلي</h1>
          <p className="v4-screen__subtitle">كل عمليات الوردية تُسجَّل باسمك.</p>
        </div>
        {/* NO STEPPER HERE — deliberate.
         *
         * The reference sign-in shows a 3-step progress rail
         * (تسجيل الدخول → بدء الوردية → جاهز للبيع). That product has a
         * shift-start step; POS-Pulse does not. `SignInRoute` navigates
         * straight to `/app` on `signedIn` (see the effect above), and
         * `specs/015-shift-cash-management` has not shipped — RECONCILIATION
         * §B lists shift close as explicitly NOT authorised.
         *
         * Rendering two pending steps would be a layout filled with a
         * behaviour claim: RECONCILIATION §A — "it does not invent a
         * behaviour to fill a layout" — and PRODUCT.md principle 1,
         * "honest surfaces". The stepper's visual treatment is kept in the
         * v4 layout layer for checkout, which has a real multi-step flow. */}
      </header>

      {/* Roster is the widest track: selecting the operator is the primary act.
          The PIN column holds a fixed 300px so the keypad never reflows. */}
      <div className="v4-columns v4-columns--sign-in">
        <section className="v4-panel v4-col--rail" aria-labelledby="signin-staff-code">
          <div className="v4-panel__head">
            {/* Bilingual section label retained verbatim: `sign-in-route.test.tsx`
                pins this exact string. The rebuild changes composition, not copy —
                re-pointing a passing assertion to fit new markup would weaken it. */}
            <h2 className="v4-panel__title" id="signin-staff-code">
              كود الموظف · Staff code
            </h2>
          </div>
          <p className="v4-panel__hint">للمدير أو المشرف — الدخول بكود الموظف وكلمة السر.</p>
          <ManagerAdminSignInForm operator={operator} />
        </section>

        <section className="v4-panel v4-col--roster" aria-label="قائمة الكاشير">
          <div className="v4-panel__head">
            <h2 className="v4-panel__title">صيادلة هذا الفرع</h2>
          </div>
          {rosterError !== undefined && (
            <p className="v4-feedback__error" role="alert">
              {rosterError}
            </p>
          )}
          <RosterList
            cashiers={rosterEntries}
            inert={cashiers.length === 0}
            onSelect={handleCashierSelect}
            selectedId={selectedCashier?.id}
          />
        </section>

        {/* PIN column. Persistent track: it holds its width whether or not a
            cashier is selected, so selection never reflows the two columns
            beside it. Before selection it states what it is waiting for. */}
        <aside className="v4-panel v4-col--pin" aria-label="إدخال الرقم السري">
          {selectedCashier === undefined ? (
            <>
              <div className="v4-panel__head">
                <h2 className="v4-panel__title">الرقم السري</h2>
              </div>
              <p className="v4-panel__hint" data-testid="pin-awaiting-selection">
                اختر صيدليًا من القائمة لإدخال الرقم السري.
              </p>
            </>
          ) : (
            <div
              className="v4-stack"
              data-testid="pin-section"
              data-error={cashierError !== undefined || undefined}
            >
              <div className="v4-panel__head">
                <h2 className="v4-panel__title" data-testid="pin-cashier-name">
                  {selectedCashier.display_name}
                </h2>
              </div>
              <p className="v4-panel__hint">{ROLE_NAME_AR[selectedCashier.role]}</p>

              {/* Note 1 invariant — alert XOR spinner. One live region, one
                  message at a time; the box is reserved so a refusal never
                  reflows the keypad beneath it. */}
              <div className="v4-feedback" role="status" aria-live="polite">
                {isSigningIn ? (
                  <span data-testid="cashier-sign-in-spinner">جارٍ تسجيل الدخول…</span>
                ) : cashierError !== undefined ? (
                  <span
                    role="alert"
                    data-testid="cashier-sign-in-error"
                    className="v4-feedback__error"
                  >
                    {cashierError}
                  </span>
                ) : null}
              </div>

              <PinPad
                value={pin}
                onChange={handlePinChange}
                onSubmit={handleCashierSubmit}
                disabled={isSigningIn}
              />

              <button
                type="button"
                className="btn btn--ghost btn--md"
                data-testid="cashier-pin-cancel"
                disabled={isSigningIn}
                onClick={() => {
                  setSelectedCashier(undefined);
                  setPin('');
                  setCashierError(undefined);
                }}
              >
                رجوع
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
