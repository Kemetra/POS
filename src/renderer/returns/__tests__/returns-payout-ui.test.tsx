import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnsPayoutResponse } from '../../../shared/returns/types.js';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config.js';
import { PAYOUT_COPY, drawerFailureMessage, refusalMessage } from '../returns-messages.js';
import {
  deferred,
  fakeBridge,
  fakeSessionEvents,
  journal,
  renderReturns,
  resetStores,
  settle,
  submitReturn,
  type FakeReturnsBridge,
} from './returns-test-kit.js';

/**
 * RT-15 S4 — the payout on the confirmed outcome (R1, R2, R3, R4, R6).
 * Payout is shown as done only on main's `paid_out`; every other answer says
 * what is true and offers the one safe next step.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

/** A payout started whose kick provably never left (no drawer): may be retried. */
const STARTED = {
  startedAt: '2026-10-04T09:06:00.000Z',
  paidAt: null,
  method: null,
  kick: 'failed_before_send' as const,
  kickCount: 1,
  kickPending: false,
};
const PAID_ROW = journal({
  state: 'paid_out',
  payout: { ...STARTED, paidAt: '2026-10-04T09:06:05.000Z', method: 'drawer' },
});
const PAID_BY_DRAWER: ReturnsPayoutResponse = {
  kind: 'paid_out',
  ret: PAID_ROW,
  method: 'drawer',
  slip: 'printed',
};
const START_NAME = 'افتح الدرج واصرف النقد';

async function confirmedOutcome(bridge: FakeReturnsBridge): Promise<UserEvent> {
  const user = userEvent.setup();
  renderReturns({ bridge });
  await submitReturn(user);
  await screen.findByRole('heading', { name: 'صرف النقد' });
  return user;
}

function payoutRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'صرف النقد' });
}

describe('pay out from the confirmed outcome', () => {
  it('the payout is the one filled commit: "new return" is secondary beside it', async () => {
    await confirmedOutcome(fakeBridge());
    expect(screen.getByRole('button', { name: START_NAME })).toHaveClass('rt-btn--primary');
    expect(screen.getByRole('button', { name: 'مرتجع جديد' })).not.toHaveClass('rt-btn--primary');
  });

  it('a paid payout with a printed slip is success green', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect((await screen.findByText(PAYOUT_COPY.paid)).parentElement).toHaveClass(
      'rt-outcome--success',
    );
  });

  it('R6: shows main’s confirmed amount and pays out with only the return id and an action', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    const user = await confirmedOutcome(bridge);
    expect(within(payoutRegion()).getByText('24.99 EGP')).toBeInTheDocument();
    const listsBefore = bridge.list.mock.calls.length;
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(bridge.payout).toHaveBeenCalledWith({ returnId: 'ret-1', action: 'start' });
    expect(await screen.findByText(PAYOUT_COPY.paid)).toBeInTheDocument();
    expect(screen.getByText(PAYOUT_COPY.slipPrinted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
    expect(bridge.list.mock.calls.length).toBeGreaterThan(listsBefore);
  });

  it('R1: a failed drawer says nothing was paid and offers retry or a manual payout', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'drawer_failed',
      ret: journal({ payout: STARTED }),
      reason: 'no_drawer_configured',
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.drawerFailed)).toBeInTheDocument();
    expect(screen.getByText(drawerFailureMessage('no_drawer_configured'))).toBeInTheDocument();
    expect(screen.queryByText(PAYOUT_COPY.paid)).toBeNull();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.retryDrawer }));
    expect(bridge.payout).toHaveBeenLastCalledWith({ returnId: 'ret-1', action: 'retry_drawer' });
    expect(await screen.findByText(PAYOUT_COPY.paid)).toBeInTheDocument();
  });

  it('R2: a manual payout needs a second, explicit confirmation; cancel goes back', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'drawer_failed',
      ret: journal({ payout: STARTED }),
      reason: 'timeout',
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    await user.click(await screen.findByRole('button', { name: PAYOUT_COPY.manual }));
    expect(screen.getByText(PAYOUT_COPY.confirmManual)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PAYOUT_COPY.cancel })).toHaveFocus();
    expect(bridge.payout).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.cancel }));
    expect(screen.getByText(PAYOUT_COPY.drawerUnknown)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.manual }));
    bridge.payout.mockResolvedValueOnce({
      kind: 'paid_out',
      ret: PAID_ROW,
      method: 'manual',
      slip: 'printed',
    });
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.confirmManualYes }));
    expect(bridge.payout).toHaveBeenLastCalledWith({ returnId: 'ret-1', action: 'manual' });
    expect(await screen.findByText(PAYOUT_COPY.paidManual)).toBeInTheDocument();
  });

  it('R3: a payout started elsewhere is completed, never started afresh', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'payout_started',
      ret: journal({ payout: STARTED }),
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.interrupted)).toBeInTheDocument();
    expect(screen.getByText(PAYOUT_COPY.interruptedCheck)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.interruptedRetry }));
    expect(bridge.payout).toHaveBeenLastCalledWith({ returnId: 'ret-1', action: 'retry_drawer' });
  });

  it('R1: a rejected call is an unknown result; refreshing reads the journal', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockRejectedValueOnce(new Error('session_locked'));
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.unknown)).toBeInTheDocument();
    expect(screen.queryByText(PAYOUT_COPY.paid)).toBeNull();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [PAID_ROW] });
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.refresh }));
    expect(await screen.findByText(PAYOUT_COPY.paidEarlier)).toBeInTheDocument();
  });

  it('shows a refusal with its own message', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'already_paid_out',
      ret: PAID_ROW,
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(refusalMessage('already_paid_out'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
  });

  it('R4: a double click sends one payout', async () => {
    const bridge = fakeBridge();
    const pending = deferred<ReturnsPayoutResponse>();
    bridge.payout.mockReturnValueOnce(pending.promise);
    const user = await confirmedOutcome(bridge);
    const start = screen.getByRole('button', { name: START_NAME });
    await user.dblClick(start);
    expect(start).toBeDisabled();
    expect(screen.getByText(PAYOUT_COPY.opening)).toBeInTheDocument();
    await settle(pending, PAID_BY_DRAWER);
    expect(bridge.payout).toHaveBeenCalledTimes(1);
  });
});

describe('P1 + reviewer P2-1: no retry when the drawer may have opened', () => {
  it('a timeout says the drawer state is unknown and offers only the attested manual payout', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'drawer_failed',
      ret: journal({ payout: { ...STARTED, kick: 'unknown' } }),
      reason: 'timeout',
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.drawerUnknown)).toBeInTheDocument();
    expect(screen.getByText(drawerFailureMessage('timeout'))).toBeInTheDocument();
    expect(screen.queryByText(PAYOUT_COPY.drawerFailed)).toBeNull();
    expect(screen.queryByRole('button', { name: PAYOUT_COPY.retryDrawer })).toBeNull();
    expect(screen.getByRole('button', { name: PAYOUT_COPY.manual })).toBeInTheDocument();
  });

  it('an interrupted payout whose drawer may have opened offers no retry', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'drawer_retry_unsafe',
      ret: journal({ payout: { ...STARTED, kick: 'opened' } }),
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.interrupted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PAYOUT_COPY.interruptedRetry })).toBeNull();
    expect(screen.getByRole('button', { name: PAYOUT_COPY.interruptedManual })).toBeInTheDocument();
  });
});

describe('the slip after a payout', () => {
  it('S4: a failed slip keeps the payout and offers a reprint, single-flight', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'paid_out',
      ret: PAID_ROW,
      method: 'drawer',
      slip: 'failed',
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.slipFailed)).toBeInTheDocument();
    expect(screen.getByText(PAYOUT_COPY.paid)).toBeInTheDocument();
    // DESIGN.md: a printer failure after a completed payout is degraded amber, not green.
    expect(screen.getByText(PAYOUT_COPY.paid).parentElement).toHaveClass('rt-outcome--warning');
    const pending = deferred<{ kind: 'printed' }>();
    bridge.reprintSlip.mockReturnValueOnce(pending.promise);
    await user.dblClick(screen.getByRole('button', { name: PAYOUT_COPY.reprint }));
    await settle(pending, { kind: 'printed' });
    expect(bridge.reprintSlip).toHaveBeenCalledTimes(1);
    expect(bridge.reprintSlip).toHaveBeenCalledWith({ returnId: 'ret-1' });
    expect(screen.getByText(PAYOUT_COPY.reprinted)).toBeInTheDocument();
  });

  it('a failed reprint says so', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    bridge.reprintSlip.mockResolvedValueOnce({ kind: 'print_failed' });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    await user.click(await screen.findByRole('button', { name: PAYOUT_COPY.reprint }));
    expect(await screen.findByText(PAYOUT_COPY.reprintFailed)).toBeInTheDocument();
  });
});

describe('reprint results stay distinct (Codex P2)', () => {
  it.each<[string, () => Promise<unknown>, string]>([
    [
      'a refusal after printing',
      () => Promise.resolve({ kind: 'refused', reason: 'session_changed' }),
      refusalMessage('session_changed'),
    ],
    ['a rejected call', () => Promise.reject(new Error('locked')), PAYOUT_COPY.reprintUnknown],
  ])('%s is not reported as a printer failure', async (_label, answer, expected) => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce(PAID_BY_DRAWER);
    bridge.reprintSlip.mockImplementationOnce(answer as never);
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    await user.click(await screen.findByRole('button', { name: PAYOUT_COPY.reprint }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(PAYOUT_COPY.reprintFailed)).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no axe violations when ready, after a drawer failure, while confirming and when paid', async () => {
    const bridge = fakeBridge();
    bridge.payout.mockResolvedValueOnce({
      kind: 'drawer_failed',
      ret: journal({ payout: STARTED }),
      reason: 'os_error',
    });
    const user = userEvent.setup();
    const { container } = renderReturns({ bridge });
    await submitReturn(user);
    await screen.findByRole('heading', { name: 'صرف النقد' });
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: START_NAME }));
    await screen.findByText(PAYOUT_COPY.drawerUnknown);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.manual }));
    await expectNoAxeViolations(container);
    bridge.payout.mockResolvedValueOnce({
      kind: 'paid_out',
      ret: PAID_ROW,
      method: 'manual',
      slip: 'failed',
    });
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.confirmManualYes }));
    await screen.findByText(PAYOUT_COPY.slipFailed);
    await expectNoAxeViolations(container);
  });
});

/**
 * Reviewer P2 (49e0277): a panel never moves back to an older view. A
 * journal reload that fails or is refused (e.g. under a lock) must not put
 * the original confirmed view back and offer "pay out" on a paid return.
 */
describe('the confirmed outcome keeps its newest payout view', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['refused', () => Promise.resolve({ kind: 'refused', reason: 'session_changed' })],
    ['failed', () => Promise.reject(new Error('locked'))],
  ])('a paid panel stays paid after a journal reload that is %s', async (_l, answer) => {
    const events = fakeSessionEvents();
    const bridge = fakeBridge();
    // The journal lists the return as paid once it is paid out.
    bridge.payout.mockImplementationOnce(() => {
      bridge.list.mockResolvedValue({ kind: 'ok', returns: [PAID_ROW] });
      return Promise.resolve(PAID_BY_DRAWER);
    });
    const user = userEvent.setup();
    renderReturns({ bridge, sessionEvents: events });
    await submitReturn(user);
    await user.click(await screen.findByRole('button', { name: START_NAME }));
    await screen.findByText(PAYOUT_COPY.paid);
    bridge.list.mockImplementation(answer as never);
    events.push({ state: 'active' });
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(4);
    });
    expect(screen.getByText(PAYOUT_COPY.paid)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
  });
});

/**
 * Codex P2 (49e0277): a kick in progress (possibly another instance's) is a
 * wait, not a dead end: the panel offers a refresh, and after the lease the
 * refreshed journal offers the attested manual payout only.
 */
describe('a kick in progress elsewhere can be refreshed', () => {
  /** Another instance's retry kick: in flight, then recorded as unknown (after the lease). */
  const RETRY = { ...STARTED, kick: 'unknown' as const, kickCount: 2 };
  const SENDING = journal({ payout: { ...RETRY, kickPending: true } });
  const SETTLED = journal({ payout: { ...RETRY, kickPending: false } });

  it('drawer_kick_in_progress offers a refresh; after the lease, manual only', async () => {
    const bridge = fakeBridge();
    bridge.submit.mockResolvedValue({
      kind: 'confirmed',
      ret: journal({ payout: STARTED }),
      replayed: false,
    });
    // The other instance's kick starts while this panel asks for the manual payout.
    bridge.payout.mockImplementationOnce(() => {
      bridge.list.mockResolvedValue({ kind: 'ok', returns: [SENDING] });
      return Promise.resolve({ kind: 'refused', reason: 'drawer_kick_in_progress', ret: SENDING });
    });
    const user = await confirmedOutcome(bridge);
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.interruptedManual }));
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.confirmManualYes }));
    expect(await screen.findByText(refusalMessage('drawer_kick_in_progress'))).toBeInTheDocument();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [SETTLED] });
    await user.click(screen.getByRole('button', { name: PAYOUT_COPY.refresh }));
    expect(
      await screen.findByRole('button', { name: PAYOUT_COPY.interruptedManual }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PAYOUT_COPY.interruptedRetry })).toBeNull();
  });
});
