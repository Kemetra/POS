import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnJournalView } from '../../../shared/returns/types.js';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config.js';
import { PAYOUT_COPY, refusalMessage } from '../returns-messages.js';
import { usePayout } from '../usePayout.js';
import { useReturnHistory } from '../useReturnHistory.js';
import {
  deferred,
  fakeBridge,
  journal,
  renderReturns,
  fakeSessionEvents,
  resetStores,
  settle,
} from './returns-test-kit.js';

/**
 * RT-15 S4 — R5: the return journal offers the one payout action each row
 * allows. Confirmed: pay out. Started but unpaid: complete (never a fresh
 * start). Paid out: reprint the slip (a copy). Anything else: nothing.
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
const ROWS: ReturnJournalView[] = [
  journal({ returnId: 'r-ready', saleNumber: 'T1-000001' }),
  journal({ returnId: 'r-started', saleNumber: 'T1-000002', payout: STARTED }),
  journal({
    returnId: 'r-paid',
    saleNumber: 'T1-000003',
    state: 'paid_out',
    payout: { ...STARTED, paidAt: '2026-10-04T09:06:05.000Z', method: 'manual' },
  }),
  journal({
    returnId: 'r-unknown',
    saleNumber: 'T1-000004',
    state: 'unknown',
    returnRef: null,
    returnTotalMinor: null,
  }),
  journal({
    returnId: 'r-refused',
    saleNumber: 'T1-000005',
    state: 'refused',
    refusalReason: 'over_return',
    returnRef: null,
    returnTotalMinor: null,
  }),
];

function rowOf(saleNumber: string): HTMLElement {
  // The open payout's facts show the sale number too: the row is the one in a table.
  const row = screen
    .getAllByText(saleNumber)
    .map((cell) => cell.closest('tr'))
    .find((tr) => tr !== null);
  if (row == null) throw new Error(`no row for ${saleNumber}`);
  return row;
}

async function renderHistory() {
  const bridge = fakeBridge();
  bridge.list.mockResolvedValue({ kind: 'ok', returns: ROWS });
  const user = userEvent.setup();
  const view = renderReturns({ bridge });
  await screen.findByText('T1-000001');
  return { bridge, user, view };
}

describe('history payout actions (R5)', () => {
  it('offers exactly one fitting action per row, and none for unconfirmed rows', async () => {
    await renderHistory();
    expect(within(rowOf('T1-000001')).getByRole('button')).toHaveTextContent(
      PAYOUT_COPY.historyPay,
    );
    expect(within(rowOf('T1-000002')).getByRole('button')).toHaveTextContent(
      PAYOUT_COPY.historyComplete,
    );
    expect(within(rowOf('T1-000003')).getByRole('button')).toHaveTextContent(
      PAYOUT_COPY.historyReprint,
    );
    expect(within(rowOf('T1-000004')).queryByRole('button')).toBeNull();
    expect(within(rowOf('T1-000005')).queryByRole('button')).toBeNull();
  });

  it('names each row action with its sale number', async () => {
    await renderHistory();
    expect(
      screen.getByRole('button', { name: `${PAYOUT_COPY.historyPay} T1-000001` }),
    ).toBeInTheDocument();
  });

  it('pay out opens the payout for that return', async () => {
    const { user } = await renderHistory();
    await user.click(within(rowOf('T1-000001')).getByRole('button'));
    expect(await screen.findByRole('heading', { name: 'صرف النقد' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'افتح الدرج واصرف النقد' })).toBeInTheDocument();
  });

  it('R3: complete opens the interrupted payout, with no fresh start', async () => {
    const { user } = await renderHistory();
    await user.click(within(rowOf('T1-000002')).getByRole('button'));
    expect(await screen.findByText(PAYOUT_COPY.interrupted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'افتح الدرج واصرف النقد' })).toBeNull();
  });

  it('reprint prints a copy of that return’s slip, once per click burst', async () => {
    const { bridge, user } = await renderHistory();
    const pending = deferred<{ kind: 'printed' }>();
    bridge.reprintSlip.mockReturnValueOnce(pending.promise);
    await user.dblClick(within(rowOf('T1-000003')).getByRole('button'));
    await settle(pending, { kind: 'printed' });
    expect(bridge.reprintSlip).toHaveBeenCalledTimes(1);
    expect(bridge.reprintSlip).toHaveBeenCalledWith({ returnId: 'r-paid' });
    expect(screen.getByText(PAYOUT_COPY.reprinted)).toBeInTheDocument();
  });

  it.each<[string, () => Promise<unknown>, string]>([
    [
      'a printer failure',
      () => Promise.resolve({ kind: 'print_failed' }),
      PAYOUT_COPY.reprintFailed,
    ],
    [
      'a refusal',
      () => Promise.resolve({ kind: 'refused', reason: 'session_changed' }),
      refusalMessage('session_changed'),
    ],
    ['a rejected call', () => Promise.reject(new Error('locked')), PAYOUT_COPY.reprintUnknown],
  ])('%s is reported as itself (Codex P2)', async (_label, answer, expected) => {
    const { bridge, user } = await renderHistory();
    bridge.reprintSlip.mockImplementationOnce(answer as never);
    await user.click(within(rowOf('T1-000003')).getByRole('button'));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('has no axe violations with the action column', async () => {
    const { view } = await renderHistory();
    await expectNoAxeViolations(view.container);
  });
});

/**
 * Codex P2 (c21d7e2): the open payout follows a newer journal view of the
 * same return (another window or instance started it), so it never offers a
 * stale fresh start; the same view keeps what the panel just learned live.
 */
describe('the open payout follows a newer view of its return', () => {
  const START_NAME = 'افتح الدرج واصرف النقد';
  const STARTED_READY = journal({ returnId: 'r-ready', saleNumber: 'T1-000001', payout: STARTED });
  const UNKNOWN_READY = journal({
    returnId: 'r-ready',
    saleNumber: 'T1-000001',
    payout: { ...STARTED, kick: 'unknown' },
  });

  async function openReady() {
    const events = fakeSessionEvents();
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: ROWS });
    const user = userEvent.setup();
    renderReturns({ bridge, sessionEvents: events });
    await screen.findByText('T1-000001');
    await user.click(within(rowOf('T1-000001')).getByRole('button'));
    await screen.findByRole('button', { name: START_NAME });
    return { bridge, events, user };
  }

  it('a history reload with the payout started elsewhere drops the fresh start', async () => {
    const { bridge, events } = await openReady();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [STARTED_READY, ...ROWS.slice(1)] });
    events.push({ state: 'active' });
    expect(await screen.findByText(PAYOUT_COPY.interrupted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
  });

  it('the same view after its own payout call keeps the live answer', async () => {
    const { bridge, user } = await openReady();
    bridge.payout.mockResolvedValueOnce({
      kind: 'drawer_failed',
      reason: 'timeout',
      ret: UNKNOWN_READY,
    });
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [UNKNOWN_READY, ...ROWS.slice(1)] });
    await user.click(screen.getByRole('button', { name: START_NAME }));
    expect(await screen.findByText(PAYOUT_COPY.drawerUnknown)).toBeInTheDocument();
    expect(await within(rowOf('T1-000001')).findByRole('button')).toHaveTextContent(
      PAYOUT_COPY.historyComplete,
    );
    expect(screen.getByText(PAYOUT_COPY.drawerUnknown)).toBeInTheDocument();
    expect(screen.queryByText(PAYOUT_COPY.interrupted)).toBeNull();
  });
});

describe('usePayout follows a newer prop of the same return (Codex P2)', () => {
  const READY = journal({ returnId: 'r1' });
  const STARTED_R1 = journal({ returnId: 'r1', payout: STARTED });

  function hook(initial: ReturnJournalView) {
    const bridge = fakeBridge();
    const reload = () => Promise.resolve(null);
    return renderHook(({ ret }: { ret: ReturnJournalView }) => usePayout(bridge, ret, reload), {
      initialProps: { ret: initial },
    });
  }

  it('a newer view replaces a stale ready panel: no fresh start', () => {
    const { result, rerender } = hook(READY);
    expect(result.current.state.phase).toEqual({ kind: 'ready' });
    rerender({ ret: STARTED_R1 });
    expect(result.current.state.phase).toEqual({ kind: 'interrupted', retryable: true });
    expect(result.current.state.ret).toBe(STARTED_R1);
  });

  it('a new object with the same revision keeps the live phase', () => {
    const { result, rerender } = hook(STARTED_R1);
    act(() => {
      result.current.askManual();
    });
    rerender({ ret: { ...STARTED_R1 } });
    expect(result.current.state.phase.kind).toBe('confirm_manual');
  });
});

describe('the open payout is fed the last good journal rows (reviewer P2 on 49e0277)', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['refused', () => Promise.resolve({ kind: 'refused', reason: 'session_changed' })],
    ['failed', () => Promise.reject(new Error('locked'))],
  ])('a reload that is %s keeps the last listed rows', async (_l, answer) => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: ROWS });
    const { result } = renderHook(() => useReturnHistory(bridge, null));
    await waitFor(() => {
      expect(result.current.known).toEqual(ROWS);
    });
    bridge.list.mockImplementation(answer as never);
    await act(() => result.current.reload());
    expect(result.current.state.status).not.toBe('ok');
    expect(result.current.known).toEqual(ROWS);
  });
});
