import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnJournalView, ReturnsResolveResponse } from '../../../shared/returns/types.js';
import { OUTCOME_COPY, refusalMessage } from '../returns-messages.js';
import {
  deferred,
  fakeBridge,
  journal,
  renderReturns,
  resetStores,
  RETURN_REF,
  settle,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — U1..U3: "check again" reads the journal truth, once at a time. */
afterEach(() => {
  cleanup();
  resetStores();
});

const LOST = journal({ state: 'unknown', returnRef: null, returnTotalMinor: null });

async function unconfirmedThen(rows: ReturnJournalView[]) {
  const bridge = fakeBridge();
  bridge.submit.mockResolvedValueOnce({ kind: 'unconfirmed', ret: LOST });
  bridge.list.mockResolvedValue({ kind: 'ok', returns: rows });
  const user = userEvent.setup();
  renderReturns({ bridge });
  await submitReturn(user);
  await screen.findByRole('button', { name: 'تحقّق مجددًا' });
  return { bridge, user };
}

describe('check again (U1)', () => {
  it('shows success once the journal says the return was confirmed', async () => {
    const { bridge, user } = await unconfirmedThen([journal({ state: 'confirmed' })]);
    await user.click(screen.getByRole('button', { name: 'تحقّق مجددًا' }));
    expect(await screen.findByRole('status')).toHaveTextContent(OUTCOME_COPY.confirmed);
    expect(screen.getAllByText(RETURN_REF).length).toBeGreaterThan(0);
    expect(bridge.resolve).toHaveBeenCalledTimes(1);
  });

  it('shows the refusal when the journal says it was refused', async () => {
    const row = journal({ state: 'refused', returnRef: null, refusalReason: 'over_return' });
    const { user } = await unconfirmedThen([row]);
    await user.click(screen.getByRole('button', { name: 'تحقّق مجددًا' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(refusalMessage('over_return'));
  });

  it.each([
    ['still unknown', [LOST]],
    ['missing from the list', []],
    ['unknown while another return is confirmed', [journal({ returnId: 'other' }), LOST]],
  ])('stays unconfirmed when the return is %s', async (_, rows) => {
    const { user } = await unconfirmedThen(rows);
    await user.click(screen.getByRole('button', { name: 'تحقّق مجددًا' }));
    expect(await screen.findByText(OUTCOME_COPY.stillUnconfirmed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تحقّق مجددًا' })).toBeEnabled();
  });
});

describe('check again failures (U2)', () => {
  it.each([
    ['refused', { kind: 'refused', reason: 'offline' }, refusalMessage('offline')],
    ['rejected', new Error('session_locked'), OUTCOME_COPY.callFailed],
  ])('a %s resolve keeps the return unconfirmed with its message', async (_, answer, text) => {
    const { bridge, user } = await unconfirmedThen([]);
    bridge.resolve.mockImplementationOnce(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never),
    );
    await user.click(screen.getByRole('button', { name: 'تحقّق مجددًا' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(OUTCOME_COPY.unconfirmed)).toBeInTheDocument();
  });
});

describe('check again is single-flight (U3)', () => {
  it('a double click resolves once, and the flow cannot be left until main answers', async () => {
    const { bridge, user } = await unconfirmedThen([journal({ state: 'confirmed' })]);
    const pending = deferred<ReturnsResolveResponse>();
    bridge.resolve.mockImplementationOnce(() => pending.promise);
    const check = screen.getByRole('button', { name: 'تحقّق مجددًا' });
    await user.dblClick(check);
    expect(check).toBeDisabled();
    expect(bridge.resolve).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'مرتجع جديد' })).toBeDisabled();
    await settle(pending, { kind: 'ok', confirmed: 1, refused: 0, unresolved: 0 });
    expect(await screen.findByRole('status')).toHaveTextContent(OUTCOME_COPY.confirmed);
    expect(screen.getByRole('button', { name: 'مرتجع جديد' })).toBeEnabled();
  });
});
