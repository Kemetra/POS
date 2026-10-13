/**
 * RT-441 (RT-116 §5.2, RT-114) — one recovery action, confirmed with the
 * signed-in manager's own PIN. The approval is bound to the action's subject;
 * a refused approval never reaches the action; the PIN is cleared on press.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { RecoveryActionDialog, type RecoveryAction } from '../RecoveryActionDialog';
import { RECOVERY_COPY, recoveryRefusalMessage } from '../recovery-copy';
import {
  MANAGER,
  fakeBridges,
  heldCart,
  stuckAttempt,
  type FakeBridges,
} from './__helpers__/recovery-fixtures';

afterEach(cleanup);

const PIN = '246810';

function show(action: RecoveryAction, bridges: FakeBridges = fakeBridges()) {
  const onDismiss = vi.fn();
  const onDone = vi.fn();
  render(
    <RecoveryActionDialog
      action={action}
      bridges={bridges}
      onDismiss={onDismiss}
      onDone={onDone}
    />,
  );
  return { bridges, onDismiss, onDone };
}

const approve = () => screen.getByRole('button', { name: RECOVERY_COPY.approve });
const pinBox = () => screen.findByLabelText(new RegExp(RECOVERY_COPY.pinLabel));

describe('RecoveryActionDialog — the approver', () => {
  it('asks for approvers of the action’s own kind and names the signed-in manager', async () => {
    const { bridges } = show({ kind: 'cancel_cart', cart: heldCart() });
    expect(screen.getByRole('status')).toHaveTextContent(RECOVERY_COPY.loading);
    expect(await pinBox()).toBeInTheDocument();
    expect(screen.getByText(MANAGER.display_name)).toBeInTheDocument();
    expect(bridges.approval.listApprovers).toHaveBeenCalledWith({
      action_kind: 'recovery.cancel_held_cart',
    });
  });

  it('says the manager has no PIN when no approver is listed', async () => {
    const bridges = fakeBridges();
    bridges.approval.listApprovers.mockResolvedValueOnce({ kind: 'approvers', approvers: [] });
    show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
    expect(await screen.findByRole('alert')).toHaveTextContent(RECOVERY_COPY.noPin);
    expect(approve()).toBeDisabled();
  });

  it('keeps a refused read’s own reason instead of claiming there is no PIN', async () => {
    const bridges = fakeBridges();
    bridges.approval.listApprovers.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'session_locked',
    });
    show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(recoveryRefusalMessage('session_locked'));
    expect(alert).not.toHaveTextContent(RECOVERY_COPY.noPin);
    expect(screen.queryByLabelText(new RegExp(RECOVERY_COPY.pinLabel))).not.toBeInTheDocument();
  });

  it('says the action is unavailable when the approver read fails', async () => {
    const bridges = fakeBridges();
    bridges.approval.listApprovers.mockRejectedValueOnce(new Error('ipc down'));
    show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
    expect(await screen.findByRole('alert')).toHaveTextContent(RECOVERY_COPY.unavailable);
  });
});

describe('RecoveryActionDialog — cancel a held sale', () => {
  it('stays disabled until the PIN matches the pattern', async () => {
    show({ kind: 'cancel_cart', cart: heldCart() });
    const user = userEvent.setup();
    await user.type(await pinBox(), '123');
    expect(approve()).toBeDisabled();
    await user.type(await pinBox(), '456');
    expect(approve()).toBeEnabled();
  });

  it('binds the approval to the cart, spends it, clears the PIN and reports done', async () => {
    const { bridges, onDone } = show({ kind: 'cancel_cart', cart: heldCart() });
    const user = userEvent.setup();
    const box = await pinBox();
    await user.type(box, PIN);
    await user.click(approve());
    expect(box).toHaveValue('');
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(RECOVERY_COPY.cancelledSale);
    });
    expect(bridges.approval.request).toHaveBeenCalledWith({
      action_kind: 'recovery.cancel_held_cart',
      subject_ref: 'cart-held-1',
      reason_code: 'manager_recovery',
      approver_ref: MANAGER.approver_ref,
      pin: PIN,
    });
    expect(bridges.recovery.cancelHeldCart).toHaveBeenCalledWith({
      cart_id: 'cart-held-1',
      approval_id: 'approval-1',
    });
  });

  it('sends Arabic-Indic PIN digits as ASCII', async () => {
    const { bridges } = show({ kind: 'cancel_cart', cart: heldCart() });
    const user = userEvent.setup();
    await user.type(await pinBox(), '٢٤٦٨١٠');
    await user.click(approve());
    await waitFor(() => {
      expect(bridges.approval.request).toHaveBeenCalledWith(expect.objectContaining({ pin: PIN }));
    });
  });

  const refuseApproval = (b: FakeBridges) =>
    b.approval.request.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_unavailable' });
  const refuseAction = (b: FakeBridges) =>
    b.recovery.cancelHeldCart.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_stale' });

  it.each([
    ['the approval', refuseApproval, 'approval_unavailable', 0],
    ['the action', refuseAction, 'approval_stale', 1],
  ] as const)(
    'shows %s’s refusal and stays open (a refused approval never reaches the action)',
    async (_who, refuse, reason, actionCalls) => {
      const bridges = fakeBridges();
      refuse(bridges);
      const { onDone } = show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
      const user = userEvent.setup();
      await user.type(await pinBox(), PIN);
      await user.click(approve());
      expect(await screen.findByRole('alert')).toHaveTextContent(recoveryRefusalMessage(reason));
      expect(bridges.recovery.cancelHeldCart).toHaveBeenCalledTimes(actionCalls);
      expect(onDone).not.toHaveBeenCalled();
    },
  );

  it('says unavailable when the bridge throws', async () => {
    const bridges = fakeBridges();
    bridges.approval.request.mockRejectedValueOnce(new Error('ipc down'));
    show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
    const user = userEvent.setup();
    await user.type(await pinBox(), PIN);
    await user.click(approve());
    expect(await screen.findByRole('alert')).toHaveTextContent(RECOVERY_COPY.unavailable);
  });

  it('goes back on رجوع, but not while the action is in flight', async () => {
    const bridges = fakeBridges();
    let release: (v: { kind: 'approved'; approval_id: string }) => void = () => undefined;
    bridges.approval.request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { onDismiss } = show({ kind: 'cancel_cart', cart: heldCart() }, bridges);
    const user = userEvent.setup();
    await user.type(await pinBox(), PIN);
    await user.click(approve());
    const back = screen.getByRole('button', { name: RECOVERY_COPY.back });
    expect(back).toBeDisabled();
    release({ kind: 'approved', approval_id: 'approval-1' });
    await waitFor(() => {
      expect(back).toBeEnabled();
    });
    await user.click(back);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('RecoveryActionDialog — complete a stuck payment', () => {
  it('asks for the cash for the remainder and sends it', async () => {
    const bridges = fakeBridges();
    bridges.recovery.completeAttempt.mockResolvedValueOnce({
      kind: 'completed',
      change_due_minor: 0,
    });
    const { onDone } = show({ kind: 'complete', stuck: stuckAttempt() }, bridges);
    const user = userEvent.setup();
    await user.type(await pinBox(), PIN);
    expect(approve()).toBeDisabled();
    await user.type(screen.getByLabelText(RECOVERY_COPY.cashReceived), '100');
    expect(approve()).toBeEnabled();
    await user.click(approve());
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(RECOVERY_COPY.completed);
    });
    expect(bridges.approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        action_kind: 'recovery.complete_attempt',
        subject_ref: 'attempt-1',
      }),
    );
    expect(bridges.recovery.completeAttempt).toHaveBeenCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'approval-1',
      cash_received_minor: 10_000,
    });
  });

  it('asks for no cash when nothing remains', async () => {
    show({ kind: 'complete', stuck: stuckAttempt({ remaining_minor: 0 }) });
    await pinBox();
    expect(screen.queryByLabelText(RECOVERY_COPY.cashReceived)).not.toBeInTheDocument();
  });
});

describe('RecoveryActionDialog — cancel a stuck payment', () => {
  it('needs both live-tender confirmations, then sends them', async () => {
    const stuck = stuckAttempt({ cash_minor: 5_000, card_minor: 7_000 });
    const { bridges, onDone } = show({ kind: 'cancel_attempt', stuck });
    const user = userEvent.setup();
    await user.type(await pinBox(), PIN);
    expect(approve()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: new RegExp(RECOVERY_COPY.confirmCash) }));
    expect(approve()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: RECOVERY_COPY.confirmCard }));
    expect(approve()).toBeEnabled();
    await user.click(approve());
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(RECOVERY_COPY.cancelledPayment);
    });
    expect(bridges.recovery.cancelAttempt).toHaveBeenCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'approval-1',
      cash_returned_confirmed: true,
      card_void_confirmed_on_terminal: true,
    });
  });

  it('offers no confirmation for tender that is not live', async () => {
    show({ kind: 'cancel_attempt', stuck: stuckAttempt({ cash_minor: 0, card_minor: 0 }) });
    await pinBox();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
