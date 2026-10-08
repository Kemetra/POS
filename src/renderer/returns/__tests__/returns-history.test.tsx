import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnsResolveResponse } from '../../../shared/returns/types.js';
import { OUTCOME_COPY, refusalMessage, stateLabel } from '../returns-messages.js';
import {
  deferred,
  fakeBridge,
  journal,
  renderReturns,
  resetStores,
  RETURN_REF,
} from './returns-test-kit.js';

/** RT-15 S3 — H1..H3: the terminal's return journal, as main lists it. */
afterEach(() => {
  cleanup();
  resetStores();
});

const ROWS = [
  journal({ returnId: 'a', saleNumber: 'T1-000001', state: 'confirmed', returnTotalMinor: 1500 }),
  journal({
    returnId: 'b',
    saleNumber: 'T1-000002',
    state: 'unknown',
    quotedTotalMinor: 700,
    returnTotalMinor: null,
    returnRef: null,
  }),
  journal({
    returnId: 'c',
    saleNumber: 'T1-000003',
    state: 'refused',
    returnRef: null,
    returnTotalMinor: null,
    refusalReason: 'over_return',
  }),
];

function history(): HTMLElement {
  return screen.getByRole('region', { name: 'سجل المرتجعات على هذا الجهاز' });
}

describe('history rows (H1)', () => {
  it('shows each return with its sale, state, amount, time and server reference', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: ROWS });
    renderReturns({ bridge });
    const rows = await within(history()).findAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('T1-000001');
    expect(rows[1]).toHaveTextContent(stateLabel('confirmed'));
    expect(rows[1]).toHaveTextContent('15.00 EGP');
    expect(within(rows[1] as HTMLElement).getByText(RETURN_REF)).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent(stateLabel('unknown'));
    expect(rows[2]).toHaveTextContent('7.00 EGP');
    expect(rows[3]).toHaveTextContent(refusalMessage('over_return'));
    const time = (rows[1] as HTMLElement).querySelector('time');
    expect(time).toHaveAttribute('dateTime', '2026-10-04T09:05:00.000Z');
  });
});

describe('history states (H3)', () => {
  it.each([
    ['empty', () => Promise.resolve({ kind: 'ok', returns: [] }), OUTCOME_COPY.historyEmpty],
    [
      'refused',
      () => Promise.resolve({ kind: 'refused', reason: 'session_changed' }),
      refusalMessage('session_changed'),
    ],
    ['rejected', () => Promise.reject(new Error('x')), OUTCOME_COPY.callFailed],
  ])('%s list shows its message', async (_, answer, text) => {
    const bridge = fakeBridge();
    bridge.list.mockImplementation(answer as never);
    renderReturns({ bridge });
    expect(await within(history()).findByText(text)).toBeInTheDocument();
  });
});

describe('check unresolved from the history (H2, U3)', () => {
  it('appears only with unresolved rows, resolves once, then re-reads the journal', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: ROWS });
    const pending = deferred<ReturnsResolveResponse>();
    bridge.resolve.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    renderReturns({ bridge });
    const check = await within(history()).findByRole('button', { name: 'تحقّق من غير المؤكدة' });
    await user.dblClick(check);
    expect(bridge.resolve).toHaveBeenCalledTimes(1);
    expect(check).toBeDisabled();
    pending.resolve({ kind: 'refused', reason: 'offline' });
    expect(await within(history()).findByRole('alert')).toHaveTextContent(
      refusalMessage('offline'),
    );
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });

  it('is absent when every return is settled', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [ROWS[0] ?? journal()] });
    renderReturns({ bridge });
    await within(history()).findAllByRole('row');
    expect(screen.queryByRole('button', { name: 'تحقّق من غير المؤكدة' })).toBeNull();
  });
});
