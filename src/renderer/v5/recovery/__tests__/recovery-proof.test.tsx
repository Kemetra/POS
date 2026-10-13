import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import {
  RecoveryProof,
  makeRecoveryProofBridges,
  readRecoveryProofParams,
  resetRecoveryProofForTests,
  type RecoveryProofParams,
} from '../dev/RecoveryProof';
import { RECOVERY_COPY, recoveryRefusalMessage } from '../recovery-copy';

/**
 * RT-441 — the DEV-only recovery harness: its query parameters, its in-memory
 * bridges, and that it renders the real screen inside the real frame.
 */

afterEach(() => {
  cleanup();
  resetRecoveryProofForTests();
  useOperatorSessionStore.getState().reset();
  window.location.hash = '';
});

/** The held-sales list (the frame's nav has list items of its own). */
async function heldRows(): Promise<HTMLElement[]> {
  const panel = await screen.findByRole('region', { name: RECOVERY_COPY.heldTitle });
  return within(panel).findAllByRole('listitem');
}

const DEFAULTS: RecoveryProofParams = { view: 'typical', approver: 'ok', approval: 'ok' };

describe('RT-441 RecoveryProof — parameters', () => {
  it('defaults to the typical page and accepting approvals', () => {
    window.location.hash = '#/dev/recovery-proof';
    expect(readRecoveryProofParams()).toEqual(DEFAULTS);
  });

  it('reads every parameter, and ignores unknown values', () => {
    window.location.hash = '#/dev/recovery-proof?view=long&approver=locked&approval=wrong_pin';
    expect(readRecoveryProofParams()).toEqual({
      view: 'long',
      approver: 'locked',
      approval: 'wrong_pin',
    });
    window.location.hash = '#/dev/recovery-proof?view=x&approver=x&approval=x';
    expect(readRecoveryProofParams()).toEqual(DEFAULTS);
  });
});

describe('RT-441 RecoveryProof — the in-memory bridges', () => {
  it.each([
    ['typical', true, 4],
    ['recovery', true, 0],
    ['long', false, 9],
    ['empty', false, 0],
  ] as const)('seeds the %s page', async (view, hasStuck, heldCount) => {
    const answer = await makeRecoveryProofBridges({ ...DEFAULTS, view }).recovery.listHeld();
    expect(answer.kind).toBe('held');
    if (answer.kind !== 'held') return;
    expect(answer.stuck !== null).toBe(hasStuck);
    expect(answer.held).toHaveLength(heldCount);
    expect(answer.recovery_mode).toBe(view === 'recovery');
  });

  it('refuses the read on the refused page', async () => {
    await expect(
      makeRecoveryProofBridges({ ...DEFAULTS, view: 'refused' }).recovery.listHeld(),
    ).resolves.toEqual({ kind: 'refused', reason: 'role_mismatch' });
  });

  it('clears what an action resolves, and answers the change due', async () => {
    const { recovery } = makeRecoveryProofBridges(DEFAULTS);
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: 'proof-attempt',
        approval_id: 'a',
        cash_received_minor: 12_000,
      }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 2_000 });
    await expect(
      recovery.cancelAttempt({ payment_attempt_id: 'x', approval_id: 'a' }),
    ).resolves.toEqual({ kind: 'cancelled' });
    await recovery.cancelHeldCart({ cart_id: 'proof-held-1', approval_id: 'a' });
    const after = await recovery.listHeld();
    expect(after).toMatchObject({ stuck: null, recovery_mode: false });
    expect(after.kind === 'held' && after.held.map((c) => c.cart_id)).not.toContain('proof-held-1');
    await expect(
      makeRecoveryProofBridges({ ...DEFAULTS, view: 'empty' }).recovery.completeAttempt({
        payment_attempt_id: 'x',
        approval_id: 'a',
      }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 0 });
  });

  it.each([
    ['ok', 'approvers', 1],
    ['none', 'approvers', 0],
    ['locked', 'refused', 0],
  ] as const)('answers approvers for %s', async (approver, kind, count) => {
    const { approval } = makeRecoveryProofBridges({ ...DEFAULTS, approver });
    const answer = await approval.listApprovers({ action_kind: 'recovery.cancel_held_cart' });
    expect(answer.kind).toBe(kind);
    expect(answer.kind === 'approvers' ? answer.approvers : []).toHaveLength(count);
  });

  it('accepts or refuses the PIN', async () => {
    const req = {
      action_kind: 'recovery.cancel_held_cart' as const,
      subject_ref: 'proof-held-1',
      reason_code: 'manager_recovery',
      approver_ref: 'proof-approver',
      pin: '246810',
    };
    await expect(makeRecoveryProofBridges(DEFAULTS).approval.request(req)).resolves.toEqual({
      kind: 'approved',
      approval_id: 'proof-approval',
    });
    await expect(
      makeRecoveryProofBridges({ ...DEFAULTS, approval: 'wrong_pin' }).approval.request(req),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
  });
});

describe('RT-441 RecoveryProof — the page', () => {
  it('renders the real screen inside the v5 frame as a manager, with roster names', async () => {
    window.location.hash = '#/dev/recovery-proof';
    render(<RecoveryProof />);
    expect(screen.getByTestId('v5-frame')).toBeInTheDocument();
    expect(await heldRows()).toHaveLength(4);
    expect(screen.getByText('منى عبد الرحمن')).toBeInTheDocument();
    expect(screen.getByText(RECOVERY_COPY.someoneElse)).toBeInTheDocument();
  });

  it('opens the action dialog in the frame’s dialog host, outside <main>', async () => {
    window.location.hash = '#/dev/recovery-proof?approval=wrong_pin';
    const user = userEvent.setup();
    render(<RecoveryProof />);
    const [first] = await heldRows();
    await user.click(
      within(first as HTMLElement).getByRole('button', { name: RECOVERY_COPY.cancelSale }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('main')).toBeNull();
    expect(dialog.closest('[data-testid="v5-frame"]')).not.toBeNull();
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      recoveryRefusalMessage('approval_unavailable'),
    );
  });
});
