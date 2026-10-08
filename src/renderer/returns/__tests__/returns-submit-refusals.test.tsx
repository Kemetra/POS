import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnsRefusalReason } from '../../../shared/returns/types.js';
import { OUTCOME_COPY, refusalMessage } from '../returns-messages.js';
import {
  fakeBridge,
  journal,
  renderReturns,
  resetStores,
  SALE_NUMBER,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — O5..O7: refused, ambiguous and failed submits; nothing re-armed. */
afterEach(() => {
  cleanup();
  resetStores();
});

async function submitWith(answer: () => Promise<never>) {
  const bridge = fakeBridge();
  bridge.submit.mockImplementationOnce(answer);
  const user = userEvent.setup();
  renderReturns({ bridge });
  await submitReturn(user);
  await screen.findByRole('heading', { name: 'نتيجة المرتجع' });
  return { bridge, user };
}

const refused = (reason: ReturnsRefusalReason, withRet: boolean) => () =>
  Promise.resolve({
    kind: 'refused',
    reason,
    ret: withRet ? journal({ state: 'refused', returnRef: null, refusalReason: reason }) : null,
  } as never);

describe('refused submits (O5)', () => {
  it.each<ReturnsRefusalReason>([
    'session_changed',
    'offline',
    'no_session',
    'role_denied',
    'feature_disabled',
  ])('%s with no journaled return may have been recorded: says so', async (reason) => {
    const { bridge } = await submitWith(refused(reason, false));
    expect(screen.getByRole('alert')).toHaveTextContent(refusalMessage(reason));
    expect(screen.getByRole('alert')).toHaveTextContent(OUTCOME_COPY.mayBeRecorded);
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });

  it('a server refusal of a journaled return names the sale, without the may-be note', async () => {
    await submitWith(refused('over_return', true));
    expect(screen.getByRole('alert')).toHaveTextContent(refusalMessage('over_return'));
    expect(screen.queryByText(OUTCOME_COPY.mayBeRecorded)).not.toBeInTheDocument();
    expect(screen.getByText(SALE_NUMBER)).toBeInTheDocument();
  });

  it('a pre-send refusal with no journaled return carries no may-be note', async () => {
    await submitWith(refused('sale_voided', false));
    expect(screen.getByRole('alert')).toHaveTextContent(refusalMessage('sale_voided'));
    expect(screen.queryByText(OUTCOME_COPY.mayBeRecorded)).not.toBeInTheDocument();
  });
});

describe('a rejected submit (O6)', () => {
  it('is an unknown result that sends the operator to the refreshed history', async () => {
    const { bridge } = await submitWith(() => Promise.reject(new Error('session_locked')));
    expect(screen.getByRole('alert')).toHaveTextContent(OUTCOME_COPY.submitFailed);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });
});

describe('no outcome re-arms the selection (O7)', () => {
  it.each([
    ['confirmed', () => Promise.resolve({ kind: 'confirmed', ret: journal(), replayed: false })],
    [
      'unconfirmed',
      () => Promise.resolve({ kind: 'unconfirmed', ret: journal({ state: 'unknown' }) }),
    ],
    ['refused', refused('conflict', true)],
    ['rejected', () => Promise.reject(new Error('x'))],
  ])('after %s the only way on is a fresh lookup', async (_, answer) => {
    const { bridge, user } = await submitWith(answer as () => Promise<never>);
    expect(screen.queryByRole('button', { name: 'تأكيد الإرجاع' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'مرتجع جديد' }));
    expect(screen.getByLabelText('رقم البيع')).toHaveValue('');
    expect(screen.queryByText('بانادول 500 مجم')).not.toBeInTheDocument();
    expect(bridge.submit).toHaveBeenCalledTimes(1);
  });
});
