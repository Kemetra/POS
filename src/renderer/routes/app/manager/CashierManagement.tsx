import { type JSX, useEffect, useRef, useState } from 'react';

import type {
  OperatorBridgeAPI,
  BranchRosterCashier,
  ProvisionCashierPinRequest,
  ProvisionCashierPinResponse,
  ResetCashierPinRequest,
  UnlockCashierRequest,
} from '../../../../shared/bridge-api.js';
import type { OperatorRefusal, RefusalCategory } from '../../../../shared/audit/event-shape.js';
import { SIGN_IN_REFUSAL_COPY } from '../../../ui/operator/messages.js';
import { Workspace } from '../../../shell/regions/Workspace.js';
import { ReauthDialog, ReauthRequiredNotice } from '../../../ui/operator/ReauthDialog.js';

/**
 * T078 — Manager/admin cashier management surface.
 *
 * Route: /app/manager/cashiers  — manager and admin only (AD-1 primary
 * enforced by requireRole in main-process bridge; OperatorRouteGuard is
 * the secondary UX layer here).
 *
 * PR-1 / FR-006 compliance:
 *   - Cashier ids never render in the DOM (minimum disclosure).
 *   - PIN is collected in type="password" input, consumed once, never stored.
 *   - Error messages are generic; refusal categories never reach the DOM.
 *   - unlockCashier request carries no PIN field.
 *
 * RT-235 — first-PIN provisioning (019): a cashier with no PIN record on this
 * terminal cannot sign in, and Reset PIN refuses when no record exists. "Set
 * first PIN" is the manager/admin entry point to `provisionCashierPin`. The
 * request names the cashier by the roster `id` only; the provider-neutral
 * `user_id` stays main-side. Two refusals get a truthful message (a PIN
 * already exists / the cashier is not ready, 019 FR-5 / FR-11); the refusal
 * category itself never reaches the DOM.
 *
 * RT-358 (RT-247 D-A1) — when the manager's sign-in has expired, Save PIN is
 * refused `reauth_required`: the Arabic notice offers only «تسجيل الدخول»,
 * which opens the re-auth dialog on this surface. The typed PIN stays in this
 * component's state meanwhile; on success it is submitted again exactly once,
 * on cancel it is cleared. A second `reauth_required` right after a re-auth is
 * a plain error, never a new prompt (main fails closed on the marked retry).
 */

interface Props {
  operator: Pick<
    OperatorBridgeAPI,
    | 'listBranchRoster'
    | 'resetCashierPin'
    | 'provisionCashierPin'
    | 'unlockCashier'
    | 'reauthenticate'
  >;
}

type ActionState =
  | { kind: 'idle' }
  | { kind: 'resetPin'; cashier: BranchRosterCashier; pin: string }
  | { kind: 'setFirstPin'; cashier: BranchRosterCashier; pin: string }
  | { kind: 'reauthRequired'; cashier: BranchRosterCashier; pin: string; dialogOpen: boolean }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message?: string };

const PIN_ALREADY_SET_MESSAGE = 'This cashier already has a PIN. Use Reset PIN to change it.';
const CASHIER_NOT_READY_MESSAGE = "This cashier can't be activated yet.";

/**
 * The surface state for a provisioning answer. RT-358: `reauth_required`
 * prompts once; any refusal right after a re-auth uses the Arabic sign-in copy
 * (never the English generic retry, never a second prompt).
 */
function firstPinOutcome(
  res: ProvisionCashierPinResponse | OperatorRefusal,
  ctx: { cashier: BranchRosterCashier; pin: string; afterReauth: boolean },
): ActionState {
  if (res.kind === 'pin_provisioned') return { kind: 'success', message: 'First PIN set.' };
  // After a re-auth, `state_invalid` may also mean the session locked or was
  // latched before the retry ran, so it gets the neutral sign-in copy, never
  // the create-only "already has a PIN" message.
  if (ctx.afterReauth) return { kind: 'error', message: refusalAfterReauth(res.category) };
  if (res.category === 'state_invalid') return { kind: 'error', message: PIN_ALREADY_SET_MESSAGE };
  if (res.category === 'not_ready') return { kind: 'error', message: CASHIER_NOT_READY_MESSAGE };
  if (res.category === 'reauth_required') {
    return { kind: 'reauthRequired', cashier: ctx.cashier, pin: ctx.pin, dialogOpen: false };
  }
  return { kind: 'error' };
}

/** A refusal right after a re-auth: never a new prompt, so `reauth_required` reads as signed out. */
function refusalAfterReauth(category: RefusalCategory): string {
  return SIGN_IN_REFUSAL_COPY[category === 'reauth_required' ? 'not_signed_in' : category];
}

export function CashierManagement({ operator }: Props): JSX.Element {
  const [cashiers, setCashiers] = useState<BranchRosterCashier[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });
  // One pending guard shared by Unlock, Reset PIN and Set first PIN. Each handler
  // ends with an unconditional `setAction`, so a response that lands after the
  // manager started another action would overwrite it; and first-PIN
  // provisioning is create-only, so a second in-flight Save would race the first
  // and replace its success with `state_invalid`. While any call is in flight the
  // ref blocks re-entry and Escape synchronously, and the state disables every
  // row action plus the open dialog's buttons.
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  async function runExclusive<T>(call: () => Promise<T>): Promise<T | undefined> {
    if (pendingRef.current) return undefined;
    pendingRef.current = true;
    setPending(true);
    try {
      return await call();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    void operator.listBranchRoster().then((res) => {
      if (res.kind === 'roster') {
        setCashiers(res.cashiers);
      } else {
        setRosterError(true);
      }
    });
  }, [operator]);

  // Escape closes the Reset-PIN / Set-first-PIN dialog (WCAG 2.1.1), mirroring
  // its Cancel button (setAction idle). Only active while a dialog is open.
  useEffect(() => {
    if (action.kind !== 'resetPin' && action.kind !== 'setFirstPin') return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pendingRef.current) {
        setAction({ kind: 'idle' });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [action.kind]);

  async function handleUnlock(cashier: BranchRosterCashier): Promise<void> {
    const req: UnlockCashierRequest = {
      event_id: crypto.randomUUID(),
      target_cashier_id: cashier.id,
    };
    const res = await runExclusive(() => operator.unlockCashier(req));
    if (res === undefined) return;
    const isSuccessOrNoOp = res.kind === 'unlocked' || res.category === 'state_invalid';
    if (isSuccessOrNoOp) {
      setAction({ kind: 'success', message: 'Cashier unlocked.' });
    } else {
      setAction({ kind: 'error' });
    }
  }

  async function handleResetPinConfirm(): Promise<void> {
    if (action.kind !== 'resetPin') return;
    const req: ResetCashierPinRequest = {
      event_id: crypto.randomUUID(),
      target_cashier_id: action.cashier.id,
      new_pin: action.pin,
    };
    const res = await runExclusive(() => operator.resetCashierPin(req));
    if (res === undefined) return;
    if (res.kind === 'pin_reset') {
      setAction({ kind: 'success', message: 'PIN reset.' });
    } else {
      setAction({ kind: 'error' });
    }
  }

  async function submitFirstPin(
    cashier: BranchRosterCashier,
    pin: string,
    afterReauth: boolean,
  ): Promise<void> {
    const req: ProvisionCashierPinRequest = {
      event_id: crypto.randomUUID(),
      target_cashier_id: cashier.id,
      initial_pin: pin,
    };
    const res = await runExclusive(() => operator.provisionCashierPin(req));
    if (res === undefined) return;
    setAction(firstPinOutcome(res, { cashier, pin, afterReauth }));
  }

  function handleSetFirstPinConfirm(): void {
    if (action.kind !== 'setFirstPin') return;
    void submitFirstPin(action.cashier, action.pin, false);
  }

  /** RT-358 — the re-auth worked: submit the same PIN again, once. */
  function handleReauthenticated(): void {
    if (action.kind !== 'reauthRequired') return;
    const { cashier, pin } = action;
    setAction({ ...action, dialogOpen: false });
    void submitFirstPin(cashier, pin, true);
  }

  function handlePinChange(e: React.ChangeEvent<HTMLInputElement>): void {
    if (action.kind === 'resetPin' || action.kind === 'setFirstPin') {
      setAction({ ...action, pin: e.target.value });
    }
  }

  return (
    <Workspace title="Cashier Management">
      <div data-testid="cashier-management">
        {rosterError && (
          <p data-testid="cashier-management-error" role="alert">
            Unable to load cashier list. Please try again.
          </p>
        )}

        {cashiers !== null && cashiers.length === 0 && <p>No cashiers on this branch.</p>}

        {cashiers !== null && cashiers.length > 0 && (
          <ul aria-label="Cashier list">
            {cashiers.map((c) => (
              <li key={c.id}>
                <span>{c.display_name}</span>
                <button
                  type="button"
                  className="btn btn--secondary btn--md"
                  disabled={pending}
                  onClick={() => {
                    setAction({ kind: 'setFirstPin', cashier: c, pin: '' });
                  }}
                >
                  Set first PIN
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--md"
                  disabled={pending}
                  onClick={() => {
                    setAction({ kind: 'resetPin', cashier: c, pin: '' });
                  }}
                >
                  Reset PIN
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--md"
                  disabled={pending}
                  onClick={() => {
                    void handleUnlock(c);
                  }}
                >
                  Unlock
                </button>
              </li>
            ))}
          </ul>
        )}

        {action.kind === 'resetPin' && (
          <div role="dialog" aria-label="Reset PIN">
            <label htmlFor="new-pin-input">New PIN</label>
            <input
              id="new-pin-input"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={action.pin}
              onChange={handlePinChange}
            />
            <button
              type="button"
              className="btn btn--primary btn--md"
              disabled={pending}
              onClick={() => {
                void handleResetPinConfirm();
              }}
            >
              Confirm Reset
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--md"
              disabled={pending}
              onClick={() => {
                setAction({ kind: 'idle' });
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {action.kind === 'setFirstPin' && (
          <div role="dialog" aria-label="Set first PIN">
            <label htmlFor="initial-pin-input">Initial PIN</label>
            <input
              id="initial-pin-input"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={action.pin}
              onChange={handlePinChange}
            />
            <button
              type="button"
              className="btn btn--primary btn--md"
              disabled={pending}
              onClick={handleSetFirstPinConfirm}
            >
              Save PIN
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--md"
              disabled={pending}
              onClick={() => {
                setAction({ kind: 'idle' });
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Hidden while the PIN retry after a re-auth is in flight: one prompt only. */}
        {action.kind === 'reauthRequired' && !pending && (
          <ReauthRequiredNotice
            onSignIn={() => {
              setAction({ ...action, dialogOpen: true });
            }}
          />
        )}

        {action.kind === 'reauthRequired' && action.dialogOpen && (
          <ReauthDialog
            operator={operator}
            onReauthenticated={handleReauthenticated}
            onCancel={() => {
              setAction({ kind: 'idle' });
            }}
          />
        )}

        {action.kind === 'success' && (
          <p data-testid="action-success" role="status">
            {action.message}
          </p>
        )}

        {action.kind === 'error' && (
          <p data-testid="action-error" role="alert">
            {action.message ?? 'Action could not be completed. Please try again.'}
          </p>
        )}
      </div>
    </Workspace>
  );
}
