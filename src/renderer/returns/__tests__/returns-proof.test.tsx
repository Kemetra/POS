/**
 * RT-660 — the DEV-only Returns harness (`#/dev/returns-proof`). It must reach
 * the G6R states with the real screen; these tests drive it the way the
 * capture script does. Presentation scaffolding only, not evidence about main.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { RETURNS_PROOF_STATES, ReturnsProof, readReturnsProofState } from '../dev/ReturnsProof';
import { PROOF_SALE_NUMBER } from '../dev/returns-proof-data';
import { PAYOUT_COPY } from '../returns-messages';

function at(state: string): void {
  window.location.hash = `#/dev/returns-proof?state=${state}`;
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

type User = ReturnType<typeof userEvent.setup>;

async function confirm(user: User): Promise<void> {
  await user.type(await screen.findByLabelText('رقم البيع'), `${PROOF_SALE_NUMBER}{Enter}`);
  await user.click(await screen.findByRole('button', { name: /^زيادة بنادول/ }));
  await user.click(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
  await user.click(await screen.findByRole('button', { name: 'تأكيد الإرجاع' }));
}

describe('readReturnsProofState', () => {
  it('reads one of the 32 G6R states, else LookupEmpty', () => {
    expect(RETURNS_PROOF_STATES).toHaveLength(32);
    at('PayoutWait');
    expect(readReturnsProofState()).toBe('PayoutWait');
    at('nope');
    expect(readReturnsProofState()).toBe('LookupEmpty');
  });
});

describe('ReturnsProof', () => {
  it('shows the real Returns screen in the frame, with the drawn journal', async () => {
    at('LookupEmpty');
    render(<ReturnsProof />);
    expect(await screen.findByRole('heading', { level: 1, name: 'المرتجعات' })).toBeVisible();
    expect(await screen.findAllByRole('row')).toHaveLength(3);
  });

  it('HistoryRows: one row of each state', async () => {
    at('HistoryRows');
    render(<ReturnsProof />);
    expect(await screen.findAllByRole('row')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'تحقّق من غير المؤكدة' })).toBeVisible();
  });

  it('Disabled: the fail-closed gate, no call', async () => {
    at('Disabled');
    render(<ReturnsProof />);
    expect(await screen.findByText('المرتجعات غير مفعّلة على هذا الجهاز.')).toBeVisible();
  });

  it('PayoutDrawerFailed: a confirmed return whose drawer did not open offers retry or manual', async () => {
    at('PayoutDrawerFailed');
    render(<ReturnsProof />);
    const user = userEvent.setup();
    await confirm(user);
    await user.click(await screen.findByRole('button', { name: PAYOUT_COPY.start }));
    expect(await screen.findByText(PAYOUT_COPY.drawerFailed)).toBeVisible();
    expect(screen.getByRole('button', { name: PAYOUT_COPY.retryDrawer })).toBeVisible();
    expect(screen.getByRole('button', { name: PAYOUT_COPY.manual })).toBeVisible();
  });

  it('PayoutInterrupted: the started payout is completed, never started afresh', async () => {
    at('PayoutInterrupted');
    render(<ReturnsProof />);
    const user = userEvent.setup();
    await confirm(user);
    expect(await screen.findByText(PAYOUT_COPY.interrupted)).toBeVisible();
    expect(screen.queryByRole('button', { name: PAYOUT_COPY.start })).toBeNull();
  });
});
