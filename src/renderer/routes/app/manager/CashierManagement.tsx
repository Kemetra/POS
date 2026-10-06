import { type JSX, useEffect, useRef, useState } from 'react';

import type {
  OperatorBridgeAPI,
  BranchRosterCashier,
  ProvisionCashierPinRequest,
  ResetCashierPinRequest,
  UnlockCashierRequest,
} from '../../../../shared/bridge-api.js';
import { Workspace } from '../../../shell/regions/Workspace.js';

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
 */

interface Props {
  operator: Pick<
    OperatorBridgeAPI,
    'listBranchRoster' | 'resetCashierPin' | 'provisionCashierPin' | 'unlockCashier'
  >;
}

type ActionState =
  | { kind: 'idle' }
  | { kind: 'resetPin'; cashier: BranchRosterCashier; pin: string }
  | { kind: 'setFirstPin'; cashier: BranchRosterCashier; pin: string }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message?: string };

const PIN_ALREADY_SET_MESSAGE = 'This cashier already has a PIN. Use Reset PIN to change it.';
const CASHIER_NOT_READY_MESSAGE = "This cashier can't be activated yet.";

export function CashierManagement({ operator }: Props): JSX.Element {
  const [cashiers, setCashiers] = useState<BranchRosterCashier[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });
  // Provisioning is create-only: a second in-flight Save would race the first and
  // could replace its success with `state_invalid`, and any other action taken
  // meanwhile would be overwritten when the response lands. While a call is in
  // flight the ref blocks re-entry and Escape synchronously; the state disables
  // Save, Cancel and every row action.
  const provisioningRef = useRef(false);
  const [provisioning, setProvisioning] = useState(false);

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
      if (e.key === 'Escape' && !provisioningRef.current) {
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
    const res = await operator.unlockCashier(req);
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
    const res = await operator.resetCashierPin(req);
    if (res.kind === 'pin_reset') {
      setAction({ kind: 'success', message: 'PIN reset.' });
    } else {
      setAction({ kind: 'error' });
    }
  }

  async function handleSetFirstPinConfirm(): Promise<void> {
    if (action.kind !== 'setFirstPin' || provisioningRef.current) return;
    provisioningRef.current = true;
    setProvisioning(true);
    const req: ProvisionCashierPinRequest = {
      event_id: crypto.randomUUID(),
      target_cashier_id: action.cashier.id,
      initial_pin: action.pin,
    };
    let res: Awaited<ReturnType<typeof operator.provisionCashierPin>>;
    try {
      res = await operator.provisionCashierPin(req);
    } finally {
      provisioningRef.current = false;
      setProvisioning(false);
    }
    if (res.kind === 'pin_provisioned') {
      setAction({ kind: 'success', message: 'First PIN set.' });
    } else if (res.category === 'state_invalid') {
      setAction({ kind: 'error', message: PIN_ALREADY_SET_MESSAGE });
    } else if (res.category === 'not_ready') {
      setAction({ kind: 'error', message: CASHIER_NOT_READY_MESSAGE });
    } else {
      setAction({ kind: 'error' });
    }
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
                  disabled={provisioning}
                  onClick={() => {
                    setAction({ kind: 'setFirstPin', cashier: c, pin: '' });
                  }}
                >
                  Set first PIN
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--md"
                  disabled={provisioning}
                  onClick={() => {
                    setAction({ kind: 'resetPin', cashier: c, pin: '' });
                  }}
                >
                  Reset PIN
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--md"
                  disabled={provisioning}
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
              onClick={() => {
                void handleResetPinConfirm();
              }}
            >
              Confirm Reset
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--md"
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
              disabled={provisioning}
              onClick={() => {
                void handleSetFirstPinConfirm();
              }}
            >
              Save PIN
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--md"
              disabled={provisioning}
              onClick={() => {
                setAction({ kind: 'idle' });
              }}
            >
              Cancel
            </button>
          </div>
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
