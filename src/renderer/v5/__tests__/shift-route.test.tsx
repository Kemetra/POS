/**
 * RT-17 slice 4 part 3 — the cashier's v5 shift screen (`/app/shift`): open
 * with a float, pay-in / pay-out, and the blind-count close with the manager
 * approval step for a non-zero variance. Hidden entirely with the flag off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ShiftCloseResponse, ShiftStatusResponse } from '../../../shared/shift-cashup/types';
import { V5ShiftRoute } from '../shift/V5ShiftRoute';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';
import {
  MANAGERS,
  MONEY_TEXT,
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
  type FakeShiftBridge,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
  delete (window as unknown as { api?: unknown }).api;
});

const OPEN: ShiftStatusResponse = {
  kind: 'status',
  status: statusView({ openShift: openShiftView() }),
};

function renderRoute(bridge: FakeShiftBridge | null | undefined) {
  return renderAt({
    path: '/app/shift',
    pattern: '/app/shift',
    element: bridge === undefined ? <V5ShiftRoute /> : <V5ShiftRoute bridge={bridge} />,
  });
}

function openBridge(): FakeShiftBridge {
  return fakeShiftBridge(OPEN.kind === 'status' ? OPEN.status : statusView());
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function press(name: string, scope: HTMLElement = document.body): void {
  fireEvent.click(within(scope).getByRole('button', { name }));
}

describe('V5ShiftRoute — gating', () => {
  it('leaves the screen (no call) with the flag off', async () => {
    signIn('cashier');
    enableShiftFlag(false);
    const bridge = fakeShiftBridge();
    renderRoute(bridge);
    expect(await screen.findByTestId('where')).toHaveTextContent('/app');
    expect(bridge.status).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: SHIFT_COPY.title })).not.toBeInTheDocument();
  });

  it.each(['manager', 'admin'] as const)(
    'turns a %s away before any call (the device path is cashier-only)',
    async (role) => {
      signIn(role);
      enableShiftFlag();
      const bridge = fakeShiftBridge();
      renderRoute(bridge);
      expect(await screen.findByTestId('where')).toHaveTextContent('/app');
      expect(screen.queryByRole('heading', { name: SHIFT_COPY.title })).not.toBeInTheDocument();
      for (const member of Object.values(bridge)) expect(member).not.toHaveBeenCalled();
    },
  );

  it('renders nothing while signed out', () => {
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    const { container } = renderRoute(bridge);
    expect(container).toBeEmptyDOMElement();
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('says so when this build has no shift bridge', () => {
    signIn('cashier');
    enableShiftFlag();
    renderRoute(null);
    expect(screen.getByText(SHIFT_COPY.bridgeMissing)).toBeInTheDocument();
  });

  it('reads the bridge from window.api by default', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    (window as unknown as { api: unknown }).api = { shiftCashup: bridge };
    renderRoute(undefined);
    expect(await screen.findByLabelText(SHIFT_COPY.floatLabel)).toBeInTheDocument();
    expect(bridge.status).toHaveBeenCalledTimes(1);
  });

  it('shows a refused status read with a retry', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    bridge.status.mockResolvedValueOnce({ kind: 'refused', reason: 'session_locked' });
    renderRoute(bridge);
    expect(await screen.findByText(shiftRefusalMessage('session_locked'))).toBeInTheDocument();
    press(SHIFT_COPY.retry);
    expect(await screen.findByLabelText(SHIFT_COPY.floatLabel)).toBeInTheDocument();
  });
});

describe('V5ShiftRoute — open a shift', () => {
  it('opens with the float in minor units (Arabic digits accepted), then shows the shift', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    bridge.status
      .mockResolvedValueOnce({ kind: 'status', status: statusView() })
      .mockResolvedValue(OPEN);
    renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, '٥٠٠.٥');
    press(SHIFT_COPY.openCommit);
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith({ openingFloatMinor: 50_050 });
    });
    expect(await screen.findByText(SHIFT_COPY.opened)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: SHIFT_COPY.goToSale })).toHaveAttribute(
      'href',
      '/app/cart',
    );
    expect(await screen.findByTestId('shift-summary')).toHaveTextContent('500.00 EGP');
  });

  it.each(['', '12.345', '-5', 'abc'])('refuses to send an invalid float %j', async (value) => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, value);
    press(SHIFT_COPY.openCommit);
    expect(await screen.findByText(SHIFT_COPY.invalidAmount)).toBeInTheDocument();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it('accepts a zero float', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, '0');
    press(SHIFT_COPY.openCommit);
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith({ openingFloatMinor: 0 });
    });
  });

  it.each(['no_cashier_identity', 'drawer_activity_pending', 'clock_regressed'] as const)(
    'shows the %s refusal as its user message',
    async (reason) => {
      signIn('cashier');
      enableShiftFlag();
      const bridge = fakeShiftBridge();
      bridge.open.mockResolvedValue({ kind: 'refused', reason });
      renderRoute(bridge);
      await screen.findByLabelText(SHIFT_COPY.floatLabel);
      type(SHIFT_COPY.floatLabel, '100');
      press(SHIFT_COPY.openCommit);
      expect(await screen.findByRole('alert')).toHaveTextContent(shiftRefusalMessage(reason));
    },
  );

  it('maps a rejected open call to the generic unavailable message', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    bridge.open.mockRejectedValue(new Error('boom: secret detail'));
    renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, '100');
    press(SHIFT_COPY.openCommit);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(shiftRefusalMessage('unavailable'));
    expect(alert).not.toHaveTextContent('secret');
  });
});

describe('V5ShiftRoute — pay-in / pay-out', () => {
  async function openDialog(kind: 'payIn' | 'payOut', bridge = openBridge()) {
    signIn('cashier');
    enableShiftFlag();
    renderRoute(bridge);
    press(SHIFT_COPY[kind], await screen.findByTestId('shift-actions'));
    const dialog = screen.getByRole('dialog', { name: SHIFT_COPY[kind] });
    return { bridge, dialog };
  }

  it('records a pay-in with amount, reason and note, then closes the dialog', async () => {
    const { bridge, dialog } = await openDialog('payIn');
    type(SHIFT_COPY.amountLabel, '25');
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.reasonLabel), {
      target: { value: 'float_top_up' },
    });
    type(SHIFT_COPY.noteLabel, '  فكة  ');
    press(SHIFT_COPY.record, dialog);
    await waitFor(() => {
      expect(bridge.payIn).toHaveBeenCalledWith({
        amountMinor: 2_500,
        reasonCode: 'float_top_up',
        note: 'فكة',
      });
    });
    expect(await screen.findByText(SHIFT_COPY.recordedIn)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.status).toHaveBeenCalledTimes(2);
  });

  it('sends a pay-out without a note when none is typed', async () => {
    const { bridge, dialog } = await openDialog('payOut');
    type(SHIFT_COPY.amountLabel, '10');
    press(SHIFT_COPY.record, dialog);
    await waitFor(() => {
      expect(bridge.payOut).toHaveBeenCalledWith({ amountMinor: 1_000, reasonCode: 'bank_drop' });
    });
    expect(await screen.findByText(SHIFT_COPY.recordedOut)).toBeInTheDocument();
  });

  it('offers the four contract reasons, in Arabic', async () => {
    const { dialog } = await openDialog('payIn');
    const options = within(within(dialog).getByLabelText(SHIFT_COPY.reasonLabel)).getAllByRole(
      'option',
    );
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'bank_drop',
      'float_top_up',
      'petty_expense',
      'other',
    ]);
    options.forEach((o) => {
      expect(o.textContent).toMatch(/[؀-ۿ]/);
    });
  });

  it('answers a refused pay-out generically: no amount, no bound', async () => {
    const bridge = openBridge();
    bridge.payOut.mockResolvedValue({ kind: 'refused', reason: 'pay_out_not_accepted' });
    const { dialog } = await openDialog('payOut', bridge);
    type(SHIFT_COPY.amountLabel, '999');
    press(SHIFT_COPY.record, dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(shiftRefusalMessage('pay_out_not_accepted'));
    expect(alert.textContent).not.toMatch(/\d/);
  });

  it.each([
    ['a zero amount', '0'],
    ['an empty amount', ''],
  ])('does not send %s', async (_name, value) => {
    const { bridge, dialog } = await openDialog('payIn');
    type(SHIFT_COPY.amountLabel, value);
    press(SHIFT_COPY.record, dialog);
    expect(await within(dialog).findByText(SHIFT_COPY.invalidAmount)).toBeInTheDocument();
    expect(bridge.payIn).not.toHaveBeenCalled();
  });

  it('cancels without a call', async () => {
    const { bridge, dialog } = await openDialog('payIn');
    press(SHIFT_COPY.cancel, dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.payIn).not.toHaveBeenCalled();
  });

  describe('while the movement is being recorded', () => {
    async function pendingMovement() {
      const bridge = openBridge();
      let answer: () => void = () => undefined;
      bridge.payIn.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = () => {
              resolve({ kind: 'recorded', movementId: 'm-1', shiftId: 'shift-1' });
            };
          }),
      );
      const { dialog } = await openDialog('payIn', bridge);
      type(SHIFT_COPY.amountLabel, '25');
      press(SHIFT_COPY.record, dialog);
      await waitFor(() => {
        expect(bridge.payIn).toHaveBeenCalledTimes(1);
      });
      return {
        bridge,
        dialog,
        answer: () => {
          answer();
        },
      };
    }

    it('cannot be cancelled', async () => {
      const { dialog } = await pendingMovement();
      const cancel = within(dialog).getByRole('button', { name: SHIFT_COPY.cancel });
      expect(cancel).toBeDisabled();
      fireEvent.click(cancel);
      expect(screen.getByRole('dialog', { name: SHIFT_COPY.payIn })).toBeInTheDocument();
    });

    it('cannot be dismissed with Escape', async () => {
      const { dialog } = await pendingMovement();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: SHIFT_COPY.payIn })).toBeInTheDocument();
    });

    it('closes once the answer arrives, after exactly one call', async () => {
      const { bridge, answer } = await pendingMovement();
      answer();
      expect(await screen.findByText(SHIFT_COPY.recordedIn)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(bridge.payIn).toHaveBeenCalledTimes(1);
    });
  });

  it('caps the note at the contract bound', async () => {
    const { dialog } = await openDialog('payIn');
    expect(within(dialog).getByLabelText(SHIFT_COPY.noteLabel)).toHaveAttribute('maxlength', '200');
  });
});

describe('V5ShiftRoute — the blind-count close', () => {
  async function startClose(bridge = openBridge()) {
    signIn('cashier');
    enableShiftFlag();
    renderRoute(bridge);
    const panel = await screen.findByTestId('shift-close-panel');
    return { bridge, panel };
  }

  it('shows no amount at all before the count is committed', async () => {
    const { panel } = await startClose();
    expect(panel.textContent).not.toMatch(MONEY_TEXT);
    expect(panel).toHaveTextContent(SHIFT_COPY.blindHint);
    type(SHIFT_COPY.countLabel, '520');
    expect(panel.textContent).not.toMatch(MONEY_TEXT);
  });

  it('closes a matching count and shows no variance', async () => {
    const { bridge, panel } = await startClose();
    bridge.status.mockResolvedValue({ kind: 'status', status: statusView() });
    type(SHIFT_COPY.countLabel, '515');
    press(SHIFT_COPY.closeCommit, panel);
    await waitFor(() => {
      expect(bridge.close).toHaveBeenCalledWith({ countedCashMinor: 51_500 });
    });
    const outcome = await screen.findByTestId('shift-closed-outcome');
    expect(outcome).toHaveTextContent(SHIFT_COPY.closed);
    expect(screen.queryByTestId('shift-variance')).not.toBeInTheDocument();
    expect(await screen.findByLabelText(SHIFT_COPY.floatLabel)).toBeInTheDocument();
  });

  it('does not send an invalid count', async () => {
    const { bridge, panel } = await startClose();
    type(SHIFT_COPY.countLabel, '1.234');
    press(SHIFT_COPY.closeCommit, panel);
    expect(await within(panel).findByText(SHIFT_COPY.invalidAmount)).toBeInTheDocument();
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('shows another close refusal in the panel', async () => {
    const { bridge, panel } = await startClose();
    bridge.close.mockResolvedValue({ kind: 'refused', reason: 'drawer_activity_pending' });
    type(SHIFT_COPY.countLabel, '515');
    press(SHIFT_COPY.closeCommit, panel);
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      shiftRefusalMessage('drawer_activity_pending'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('V5ShiftRoute — manager approval of a non-zero variance', () => {
  const NEEDS_APPROVAL: ShiftCloseResponse = {
    kind: 'refused',
    reason: 'variance_approval_required',
  };

  async function reachApproval(bridge = openBridge()) {
    bridge.close.mockResolvedValueOnce(NEEDS_APPROVAL);
    signIn('cashier');
    enableShiftFlag();
    renderRoute(bridge);
    const panel = await screen.findByTestId('shift-close-panel');
    type(SHIFT_COPY.countLabel, '520');
    press(SHIFT_COPY.closeCommit, panel);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    await within(dialog).findByRole('radio', { name: MANAGERS[1].displayName });
    return { bridge, dialog };
  }

  function approveAs(dialog: HTMLElement, managerIndex: 0 | 1, pin: string): void {
    fireEvent.click(
      within(dialog).getByRole('radio', { name: MANAGERS[managerIndex].displayName }),
    );
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.pinLabel), {
      target: { value: pin },
    });
    press(SHIFT_COPY.approveCommit, dialog);
  }

  it('lists the enrolled managers by name and masks the PIN', async () => {
    const { bridge, dialog } = await reachApproval();
    expect(bridge.listEnrolledManagers).toHaveBeenCalledTimes(1);
    const pin = within(dialog).getByLabelText(SHIFT_COPY.pinLabel);
    expect(pin).toHaveAttribute('type', 'password');
    expect(pin).toHaveAttribute('autocomplete', 'off');
    expect(dialog.textContent).not.toMatch(MONEY_TEXT);
    expect(dialog.textContent).not.toContain(MANAGERS[0].managerRef);
  });

  it('retries the close with the chosen manager and PIN, then shows the approved variance', async () => {
    const { bridge, dialog } = await reachApproval();
    bridge.close.mockResolvedValueOnce({
      kind: 'closed',
      shiftId: 'shift-1',
      closedAt: '2026-10-06T16:00:00.000Z',
      varianceMinor: -750,
    });
    approveAs(dialog, 1, '٢٤٦٨١٣');
    await waitFor(() => {
      expect(bridge.close).toHaveBeenLastCalledWith({
        countedCashMinor: 52_000,
        approver: { managerRef: MANAGERS[1].managerRef, managerPin: '246813' },
      });
    });
    expect(await screen.findByTestId('shift-variance')).toHaveTextContent('-7.50 EGP');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('246813');
  });

  it('keeps the commit unavailable until a manager and a 6–8 digit PIN are given', async () => {
    const { dialog } = await reachApproval();
    const commit = within(dialog).getByRole('button', { name: SHIFT_COPY.approveCommit });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.pinLabel), {
      target: { value: '246813' },
    });
    expect(commit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: MANAGERS[0].displayName }));
    expect(commit).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.pinLabel), {
      target: { value: '12345' },
    });
    expect(commit).toBeDisabled();
  });

  it.each(['approver_invalid', 'approver_locked', 'approver_is_closer'] as const)(
    'shows %s in the dialog and clears the PIN',
    async (reason) => {
      const { bridge, dialog } = await reachApproval();
      bridge.close.mockResolvedValueOnce({ kind: 'refused', reason });
      approveAs(dialog, 0, '246813');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        shiftRefusalMessage(reason),
      );
      expect(within(dialog).getByLabelText(SHIFT_COPY.pinLabel)).toHaveValue('');
    },
  );

  it('sends the cashier back to count again when the approval went stale', async () => {
    const { bridge, dialog } = await reachApproval();
    bridge.close.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_stale' });
    approveAs(dialog, 0, '246813');
    const panel = screen.getByTestId('shift-close-panel');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      shiftRefusalMessage('approval_stale'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(SHIFT_COPY.countLabel)).toHaveValue('');
  });

  it('cancels back to the count without a call', async () => {
    const { bridge, dialog } = await reachApproval();
    press(SHIFT_COPY.cancel, dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  describe('while the approved close is pending', () => {
    async function pendingApproval() {
      const { bridge, dialog } = await reachApproval();
      bridge.close.mockImplementationOnce(() => new Promise(() => undefined));
      approveAs(dialog, 0, '246813');
      await waitFor(() => {
        expect(bridge.close).toHaveBeenCalledTimes(2);
      });
      return { bridge, dialog };
    }

    it('cannot be cancelled', async () => {
      const { dialog } = await pendingApproval();
      const cancel = within(dialog).getByRole('button', { name: SHIFT_COPY.cancel });
      expect(cancel).toBeDisabled();
      fireEvent.click(cancel);
      expect(screen.getByRole('dialog', { name: SHIFT_COPY.approvalTitle })).toBeInTheDocument();
    });

    it('cannot be dismissed with Escape, so the close cannot be sent again', async () => {
      const { bridge, dialog } = await pendingApproval();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('dialog', { name: SHIFT_COPY.approvalTitle })).toBeInTheDocument();
      expect(
        within(screen.getByTestId('shift-close-panel')).getByRole('button', {
          name: SHIFT_COPY.closeCommit,
        }),
      ).toBeDisabled();
      expect(bridge.close).toHaveBeenCalledTimes(2);
    });
  });

  it('says so when no manager is enrolled on this terminal', async () => {
    const bridge = openBridge();
    bridge.listEnrolledManagers.mockResolvedValue({ kind: 'managers', managers: [] });
    bridge.close.mockResolvedValueOnce(NEEDS_APPROVAL);
    signIn('cashier');
    enableShiftFlag();
    renderRoute(bridge);
    const panel = await screen.findByTestId('shift-close-panel');
    type(SHIFT_COPY.countLabel, '520');
    press(SHIFT_COPY.closeCommit, panel);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    expect(await within(dialog).findByText(SHIFT_COPY.noManagers)).toBeInTheDocument();
  });

  it('shows a refused manager list as its user message', async () => {
    const bridge = openBridge();
    bridge.listEnrolledManagers.mockResolvedValue({ kind: 'refused', reason: 'session_locked' });
    bridge.close.mockResolvedValueOnce(NEEDS_APPROVAL);
    signIn('cashier');
    enableShiftFlag();
    renderRoute(bridge);
    const panel = await screen.findByTestId('shift-close-panel');
    type(SHIFT_COPY.countLabel, '520');
    press(SHIFT_COPY.closeCommit, panel);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      shiftRefusalMessage('session_locked'),
    );
  });
});
