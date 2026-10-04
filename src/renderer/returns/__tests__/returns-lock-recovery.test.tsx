import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnsSubmitResponse } from '../../../shared/returns/types.js';
import { OUTCOME_COPY, stateLabel } from '../returns-messages.js';
import {
  deferred,
  fakeBridge,
  fakeSessionEvents,
  journal,
  renderReturns,
  resetStores,
  settle,
  submitReturn,
} from './returns-test-kit.js';

/**
 * RT-15 S3 — H4 (review P1): a lock during the submit POST must not leave a
 * dead end. Main answers `session_changed` with no return, and the list read
 * right after is refused while locked; the journal must still become visible
 * after unlock, and a failed list always offers a reload.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const JOURNALED = journal({ state: 'unknown', returnRef: null, returnTotalMinor: null });

function history(): HTMLElement {
  return screen.getByRole('region', { name: 'سجل المرتجعات على هذا الجهاز' });
}

describe('lock during submit (H4)', () => {
  it('re-reads the journal on unlock, showing the journaled return', async () => {
    const bridge = fakeBridge();
    const events = fakeSessionEvents();
    const answer = deferred<ReturnsSubmitResponse>();
    bridge.submit.mockImplementationOnce(() => answer.promise);
    const user = userEvent.setup();
    renderReturns({ bridge, sessionEvents: events });
    await submitReturn(user);
    events.push({ state: 'locked' });
    bridge.list.mockRejectedValueOnce(new Error('session_locked'));
    await settle(answer, { kind: 'refused', reason: 'session_changed', ret: null });
    expect(await within(history()).findByText(OUTCOME_COPY.callFailed)).toBeInTheDocument();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [JOURNALED] });
    events.push({ state: 'active' });
    expect(await within(history()).findByText(stateLabel('unknown'))).toBeInTheDocument();
    expect(screen.getByText(OUTCOME_COPY.mayBeRecorded)).toBeInTheDocument();
  });

  it.each([
    ['rejected', () => Promise.reject(new Error('x'))],
    ['refused', () => Promise.resolve({ kind: 'refused', reason: 'offline' })],
  ])('a %s list offers a reload that reads the journal again', async (_, failure) => {
    const bridge = fakeBridge();
    bridge.list.mockImplementationOnce(failure as never);
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [JOURNALED] });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.click(await within(history()).findByRole('button', { name: 'إعادة تحميل السجل' }));
    expect(await within(history()).findByText(stateLabel('unknown'))).toBeInTheDocument();
    expect(within(history()).queryByRole('button', { name: 'إعادة تحميل السجل' })).toBeNull();
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });
});
