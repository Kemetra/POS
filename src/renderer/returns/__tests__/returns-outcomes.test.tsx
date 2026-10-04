import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import {
  LOCAL_RETURN_REFUSALS,
  SERVER_RETURN_REFUSALS,
  type ReturnsRefusalReason,
} from '../../../shared/returns/types.js';
import { OUTCOME_COPY, refusalMessage } from '../returns-messages.js';
import {
  fakeBridge,
  journal,
  lookUpSale,
  renderReturns,
  resetStores,
  RETURN_REF,
  SALE_NUMBER,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — O2..O7: every answer has its own honest outcome (AC9, AC10). */
afterEach(() => {
  cleanup();
  resetStores();
});

const ALL: ReturnsRefusalReason[] = [...SERVER_RETURN_REFUSALS, ...LOCAL_RETURN_REFUSALS];

async function outcomeFor(submit: unknown): Promise<ReturnType<typeof fakeBridge>> {
  const bridge = fakeBridge();
  bridge.submit.mockImplementationOnce(() =>
    submit instanceof Error ? Promise.reject(submit) : Promise.resolve(submit as never),
  );
  const user = userEvent.setup();
  renderReturns({ bridge });
  await submitReturn(user);
  await screen.findByRole('heading', { name: 'نتيجة المرتجع' });
  return bridge;
}

describe('refusals before submit (O2)', () => {
  it.each(ALL)('lookup refused %s shows its own alert and no line picker', async (reason) => {
    const bridge = fakeBridge();
    bridge.lookup.mockResolvedValueOnce({ kind: 'refused', reason });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), `${SALE_NUMBER}{Enter}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(refusalMessage(reason));
    expect(screen.queryByRole('heading', { name: 'اختر الأصناف المرتجعة' })).toBeNull();
  });

  it('a quote refusal stays on the picker with its alert', async () => {
    const bridge = fakeBridge();
    bridge.quote.mockResolvedValueOnce({ kind: 'refused', reason: 'quantity_out_of_range' });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    await user.click(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      refusalMessage('quantity_out_of_range'),
    );
    expect(screen.getByRole('heading', { name: 'اختر الأصناف المرتجعة' })).toBeInTheDocument();
  });

  it('a rejected lookup or quote call is a failure, never a result (O6)', async () => {
    const bridge = fakeBridge();
    bridge.lookup.mockRejectedValueOnce(new Error('session_locked'));
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), `${SALE_NUMBER}{Enter}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(OUTCOME_COPY.callFailed);
    await lookUpSale(user, '');
    bridge.quote.mockRejectedValueOnce(new Error('boom'));
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    await user.click(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(OUTCOME_COPY.callFailed);
  });
});

describe('submit outcomes (O3, O4)', () => {
  it('confirmed shows the server reference and the server total as success', async () => {
    const ret = journal({ quotedTotalMinor: 2600, returnTotalMinor: 2499 });
    await outcomeFor({ kind: 'confirmed', ret, replayed: false });
    expect(screen.getByRole('status')).toHaveTextContent(OUTCOME_COPY.confirmed);
    expect(screen.getByText(RETURN_REF)).toBeInTheDocument();
    expect(screen.getByText('24.99 EGP')).toBeInTheDocument();
    expect(screen.queryByText('26.00 EGP')).not.toBeInTheDocument();
  });

  it('a replay says it was already recorded, not recorded again', async () => {
    await outcomeFor({ kind: 'confirmed', ret: journal(), replayed: true });
    expect(screen.getByRole('status')).toHaveTextContent(OUTCOME_COPY.replayed);
    expect(screen.queryByText(OUTCOME_COPY.confirmed)).not.toBeInTheDocument();
  });

  it('unconfirmed is an alert, never success, and offers check again', async () => {
    const ret = journal({ state: 'unknown', returnRef: null, returnTotalMinor: null });
    await outcomeFor({ kind: 'unconfirmed', ret });
    expect(screen.getByRole('alert')).toHaveTextContent(OUTCOME_COPY.unconfirmed);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(OUTCOME_COPY.confirmed)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تحقّق مجددًا' })).toBeInTheDocument();
    expect(screen.getByText('المبلغ المطلوب')).toBeInTheDocument();
  });
});
