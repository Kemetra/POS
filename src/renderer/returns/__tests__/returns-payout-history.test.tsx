import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnJournalView } from '../../../shared/returns/types.js';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config.js';
import { PAYOUT_COPY, refusalMessage } from '../returns-messages.js';
import {
  deferred,
  fakeBridge,
  journal,
  renderReturns,
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
  const row = screen.getByText(saleNumber).closest('tr');
  if (row === null) throw new Error(`no row for ${saleNumber}`);
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
