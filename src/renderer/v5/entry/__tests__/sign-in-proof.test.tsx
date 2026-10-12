import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import {
  SignInProof,
  makeProofOperator,
  makeProofPairing,
  readSignInProofParams,
} from '../dev/SignInProof';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import type { OperatorBridgeAPI } from '../../../../shared/bridge-api';

/**
 * RT-244 W1-D — the DEV-only sign-in harness renders the real SignInRoute in
 * every G-1 roster state, so the captures come from the shipped component.
 */

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useOperatorSessionStore.getState().reset();
});

describe('SignInProof — the real sign-in screen against an in-memory bridge', () => {
  it('reads its params from the hash, with safe defaults', () => {
    window.location.hash =
      '#/dev/sign-in-proof?roster=long&signin=rate_limited&screen=ready&pair=expired_code';
    expect(readSignInProofParams()).toEqual({
      roster: 'long',
      signin: 'rate_limited',
      screen: 'ready',
      pair: 'expired_code',
    });
    window.location.hash = '#/dev/sign-in-proof?signin=role_mismatch&screen=x&pair=success';
    expect(readSignInProofParams()).toEqual({
      roster: 'typical',
      signin: 'invalid_input',
      screen: 'sign-in',
      pair: 'invalid_code',
    });
  });

  it('renders the long roster with the terminal label', async () => {
    window.location.hash = '#/dev/sign-in-proof?roster=long';
    render(<SignInProof />);
    await waitFor(() => expect(screen.getByTestId('roster-item-17')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('entry-terminal-label')).toHaveTextContent('POS-03'),
    );
  });

  it('renders the offline roster state', async () => {
    window.location.hash = '#/dev/sign-in-proof?roster=offline';
    render(<SignInProof />);
    await waitFor(() =>
      expect(screen.getByTestId('roster-state')).toHaveAttribute('data-state', 'offline'),
    );
  });
});

const DEFAULTS = {
  roster: 'typical',
  signin: 'invalid_input',
  screen: 'sign-in',
  pair: 'invalid_code',
} as const;

describe('SignInProof — the Ready and pairing screens (RT-244 PR2)', () => {
  it('renders the Ready card with the terminal label', async () => {
    window.location.hash = '#/dev/sign-in-proof?screen=ready';
    render(<SignInProof />);
    await waitFor(() =>
      expect(screen.getByTestId('route-paired')).toHaveAttribute('data-terminal-label', 'POS-03'),
    );
  });

  it('renders the pairing card, and the revoked one with its notice', () => {
    window.location.hash = '#/dev/sign-in-proof?screen=revoked';
    render(<SignInProof />);
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
    cleanup();
    window.location.hash = '#/dev/sign-in-proof?screen=pairing';
    render(<SignInProof />);
    expect(screen.getByTestId('route-pairing')).not.toHaveAttribute('data-invalid-reason');
  });

  it('answers every pairing submit with the chosen outcome, never success', async () => {
    await expect(makeProofPairing(DEFAULTS).submit('CODE')).resolves.toEqual({
      outcome: 'invalid_code',
    });
    await expect(
      makeProofPairing({ ...DEFAULTS, pair: 'rate_limited' }).submit('CODE'),
    ).resolves.toEqual({ outcome: 'rate_limited', retry_after_s: 30 });
    await expect(makeProofPairing(DEFAULTS).recheckRevocation?.()).resolves.toEqual({
      outcome: 'still_revoked',
    });
  });
});

describe('makeProofOperator — the in-memory bridge', () => {
  it('serves each roster kind', async () => {
    const roster = (kind: string): ReturnType<OperatorBridgeAPI['listBranchRoster']> =>
      makeProofOperator({ ...DEFAULTS, roster: kind }).listBranchRoster();
    await expect(roster('offline')).resolves.toEqual({
      kind: 'refused',
      category: 'no_connection',
    });
    await expect(roster('refused')).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    await expect(roster('empty')).resolves.toMatchObject({ kind: 'roster', cashiers: [] });
    const typical = await roster('typical');
    expect(typical.kind === 'roster' ? typical.cashiers : []).toHaveLength(6);
  });

  it('refuses every sign-in with the chosen category', async () => {
    const operator = makeProofOperator({ ...DEFAULTS, signin: 'rate_limited' });
    await expect(
      operator.signIn({
        kind: 'cashier',
        cashier_clerk_user_id: 'proof-cashier-0',
        pin: '1234',
        display_name: 'منى',
      }),
    ).resolves.toEqual({ kind: 'refused', category: 'rate_limited' });
  });

  it('answers the calls the sign-in screen does not make without a session', async () => {
    const operator = makeProofOperator(DEFAULTS);
    const notSignedIn = { kind: 'refused', category: 'not_signed_in' };
    await expect(operator.getCurrentSession()).resolves.toBeNull();
    await expect(operator.signOut()).resolves.toEqual({ kind: 'signed_out' });
    await expect(operator.cancelTakeover({ pending_takeover_id: 'p' })).resolves.toEqual({
      kind: 'cancelled',
    });
    await expect(operator.listStuckShifts()).resolves.toEqual({
      kind: 'stuck_shifts',
      shifts: [],
    });
    await expect(operator.dismissShiftClosedNotice()).resolves.toBeUndefined();
    await expect(operator.getLockState()).resolves.toMatchObject({ state: 'active' });
    // The request shapes do not matter: every one of these refuses unread.
    const calls = operator as unknown as Record<string, () => Promise<unknown>>;
    for (const name of [
      'emitAuditEvent',
      '_emitAuditEventSmoke',
      'confirmTakeover',
      'resetCashierPin',
      'provisionCashierPin',
      'unlockCashier',
      'forceCloseShift',
      'unlockSession',
    ]) {
      await expect(calls[name]?.(), name).resolves.toEqual(notSignedIn);
    }
    expect(() => {
      operator._reportActivity();
      operator.onSessionStateChanged(() => undefined)();
    }).not.toThrow();
  });
});
