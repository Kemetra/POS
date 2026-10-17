/**
 * RT-658 — the DEV-only shift harness (`#/dev/shift-proof`). It must reach
 * every G-2 state with the real screens; these tests drive it the way the
 * capture script does. Presentation scaffolding only, not evidence about main.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import {
  SHIFT_PROOF_STATES,
  ShiftProof,
  makeShiftProofBridge,
  readShiftProofState,
} from '../shift/dev/ShiftProof';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';

function at(state: string): void {
  window.location.hash = `#/dev/shift-proof?state=${state}`;
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('readShiftProofState', () => {
  it('reads one of the 20 G-2 states, else Open', () => {
    expect(SHIFT_PROOF_STATES).toHaveLength(20);
    at('MgrStranded');
    expect(readShiftProofState()).toBe('MgrStranded');
    at('nope');
    expect(readShiftProofState()).toBe('Open');
  });
});

describe('ShiftProof', () => {
  it('opens the cashier screen with no shift on Open', async () => {
    at('Open');
    render(<ShiftProof />);
    expect(await screen.findByRole('region', { name: SHIFT_COPY.openHeading })).toBeInTheDocument();
  });

  it('shows the open shift and its totals on Status', async () => {
    at('Status');
    render(<ShiftProof />);
    const summary = await screen.findByTestId('shift-summary');
    expect(summary).toHaveTextContent('500.00 EGP');
    expect(summary).toHaveTextContent('1,250.00 EGP');
  });

  it('moves to the open shift after an open, as main answers', async () => {
    const user = userEvent.setup();
    at('Opened');
    render(<ShiftProof />);
    const card = await screen.findByRole('region', { name: SHIFT_COPY.openHeading });
    await user.type(within(card).getByLabelText(SHIFT_COPY.floatLabel), '500');
    await user.click(within(card).getByRole('button', { name: SHIFT_COPY.openCommit }));
    expect(await screen.findByText(SHIFT_COPY.opened)).toBeInTheDocument();
    expect(await screen.findByTestId('shift-summary')).toHaveTextContent('500.00 EGP');
  });

  it('refuses the close for parked sales on ParkedBlocked', async () => {
    const user = userEvent.setup();
    at('ParkedBlocked');
    render(<ShiftProof />);
    const close = await screen.findByRole('region', { name: SHIFT_COPY.closeHeading });
    await user.type(within(close).getByLabelText(SHIFT_COPY.countLabel), '2450');
    await user.click(within(close).getByRole('button', { name: SHIFT_COPY.closeCommit }));
    expect(await screen.findByTestId('shift-parked-block')).toBeInTheDocument();
  });

  it('opens the manager page with the stranded warning on MgrStranded', async () => {
    at('MgrStranded');
    render(<ShiftProof />);
    expect(await screen.findByTestId('shift-stranded-warning')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: SHIFT_COPY.managerTitle }),
    ).toBeInTheDocument();
  });

  it('refuses the status read on Unavailable', async () => {
    at('Unavailable');
    render(<ShiftProof />);
    expect(await screen.findByText(shiftRefusalMessage('unavailable'))).toBeInTheDocument();
  });
});

describe('makeShiftProofBridge — answers like main, per state', () => {
  const statusOf = async (state: Parameters<typeof makeShiftProofBridge>[0]) => {
    const answer = await makeShiftProofBridge(state).status();
    if (answer.kind !== 'status') throw new Error('refused');
    return answer.status;
  };

  it('starts with no shift on the open states, and with one elsewhere', async () => {
    expect((await statusOf('Open')).openShift).toBeNull();
    expect((await statusOf('MgrNoShift')).openShift).toBeNull();
    expect((await statusOf('Status')).openShift?.payOutTotalMinor).toBe(125_000);
  });

  it('draws quiet counts with no shift, stranded records, and a busy queue otherwise', async () => {
    const none = await statusOf('MgrNoShift');
    expect(none.queue.pending + none.probeRefusals.varianceClose).toBe(0);
    const stranded = await statusOf('MgrStranded');
    expect(stranded.stranded).toEqual({ unsyncedFacts: 3, openShifts: 1 });
    expect(stranded.queue.blocked).toBe(1);
    const open = await statusOf('MgrOpen');
    expect(open.queue.pending).toBe(2);
    expect(open.probeRefusals.varianceClose).toBe(1);
  });

  it.each(['Unavailable', 'MgrUnavailable'] as const)(
    'refuses the status read on %s',
    async (state) => {
      expect(await makeShiftProofBridge(state).status()).toEqual({
        kind: 'refused',
        reason: 'unavailable',
      });
    },
  );

  it('opens a shift with the float, then reports it', async () => {
    const bridge = makeShiftProofBridge('Open');
    await bridge.open({ openingFloatMinor: 70_000 });
    const answer = await bridge.status();
    expect(answer.kind === 'status' && answer.status.openShift?.openingFloatMinor).toBe(70_000);
  });

  it('adds a pay-in and a pay-out to the totals', async () => {
    const bridge = makeShiftProofBridge('Status');
    expect((await bridge.payIn({ amountMinor: 100, reasonCode: 'other' })).kind).toBe('recorded');
    expect((await bridge.payOut({ amountMinor: 200, reasonCode: 'other' })).kind).toBe('recorded');
    const answer = await bridge.status();
    const open = answer.kind === 'status' ? answer.status.openShift : null;
    expect([open?.payInTotalMinor, open?.payOutTotalMinor]).toEqual([20_100, 125_200]);
  });

  it('refuses the pay-out on PayOutRefused', async () => {
    const answer = await makeShiftProofBridge('PayOutRefused').payOut({
      amountMinor: 300_000,
      reasonCode: 'bank_drop',
    });
    expect(answer).toEqual({ kind: 'refused', reason: 'pay_out_not_accepted' });
  });

  it('closes a matching count on Closed and ends the shift', async () => {
    const bridge = makeShiftProofBridge('Closed');
    expect((await bridge.close({ countedCashMinor: 245_000 })).kind).toBe('closed');
    const answer = await bridge.status();
    expect(answer.kind === 'status' && answer.status.openShift).toBeNull();
  });

  it('asks for an approval, then closes with the approved variance', async () => {
    const bridge = makeShiftProofBridge('ClosedApproved');
    expect(await bridge.close({ countedCashMinor: 242_500 })).toEqual({
      kind: 'refused',
      reason: 'variance_approval_required',
    });
    const approved = await bridge.close({
      countedCashMinor: 242_500,
      approver: { managerRef: 'proof-manager-1', managerPin: '482913' },
    });
    expect(approved.kind === 'closed' && approved.varianceMinor).toBe(-2_500);
  });

  it('refuses the close for parked sales on ParkedBlocked', async () => {
    expect(await makeShiftProofBridge('ParkedBlocked').close({ countedCashMinor: 1 })).toEqual({
      kind: 'refused',
      reason: 'parked_sales_present',
      parkedCount: 3,
    });
  });

  it('lists two managers and accepts a PIN enrolment and revoke', async () => {
    const bridge = makeShiftProofBridge('MgrOpen');
    const managers = await bridge.listEnrolledManagers();
    expect(managers.kind === 'managers' && managers.managers).toHaveLength(2);
    expect((await bridge.enrollManagerPin({ managerPin: '482913' })).kind).toBe('enrolled');
    expect((await bridge.revokeManagerPin({})).kind).toBe('revoked');
  });
});
