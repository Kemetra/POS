import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { SignInProof, makeProofOperator, readSignInProofParams } from '../dev/SignInProof';
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
    window.location.hash = '#/dev/sign-in-proof?roster=long&signin=rate_limited';
    expect(readSignInProofParams()).toEqual({ roster: 'long', signin: 'rate_limited' });
    window.location.hash = '#/dev/sign-in-proof?signin=role_mismatch';
    expect(readSignInProofParams()).toEqual({ roster: 'typical', signin: 'invalid_input' });
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

describe('makeProofOperator — the in-memory bridge', () => {
  it('serves each roster kind', async () => {
    const roster = (kind: string): ReturnType<OperatorBridgeAPI['listBranchRoster']> =>
      makeProofOperator({ roster: kind, signin: 'invalid_input' }).listBranchRoster();
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
    const operator = makeProofOperator({ roster: 'typical', signin: 'rate_limited' });
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
    const operator = makeProofOperator({ roster: 'typical', signin: 'invalid_input' });
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
