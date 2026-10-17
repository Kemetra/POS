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
import {
  RETURNS_PROOF_STATES,
  ReturnsProof,
  readReturnsProofState,
  returnsProofBridge,
  type ReturnsProofState,
} from '../dev/ReturnsProof';
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

/** What a bridge call settles to: its kind (and refusal reason), a rejection, or nothing yet. */
async function outcomeOf(call: Promise<unknown>): Promise<string> {
  const PENDING = Symbol('pending');
  const settled = await Promise.race([
    call.then(
      (res) => {
        const r = res as { kind: string; reason?: string };
        return r.reason === undefined ? r.kind : `${r.kind}:${r.reason}`;
      },
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(resolve, 0, PENDING)),
  ]);
  return settled === PENDING ? 'pending' : (settled as string);
}

const LOOKUP: Partial<Record<ReturnsProofState, string>> = {
  LookupNotFound: 'refused:sale_not_found',
  LookupRefused: 'refused:card_tender_blocked',
  LookupOffline: 'refused:offline',
};
const QUOTE: Partial<Record<ReturnsProofState, string>> = {
  SelectQuoting: 'pending',
  SelectRefused: 'refused:quantity_out_of_range',
};
const SUBMIT: Partial<Record<ReturnsProofState, string>> = {
  OutcomeUnconfirmed: 'unconfirmed',
  OutcomeRefused: 'refused:over_return',
  OutcomeFailed: 'rejected',
  OutcomeMayBeRecorded: 'refused:session_changed',
};
const PAYOUT: Partial<Record<ReturnsProofState, string>> = {
  PayoutPaid: 'paid_out',
  PayoutNoDrawer: 'paid_out',
  PayoutSlipFailed: 'paid_out',
  PayoutReprintFailed: 'paid_out',
  PayoutDrawerFailed: 'drawer_failed:no_drawer_configured',
  PayoutConfirmManual: 'drawer_failed:no_drawer_configured',
  PayoutDrawerUnknown: 'drawer_failed:timeout',
  PayoutWait: 'refused:another_payout_in_progress',
  PayoutRefused: 'refused:already_paid_out',
  PayoutUnknown: 'rejected',
};
const REPRINT: Partial<Record<ReturnsProofState, string>> = {
  PayoutReprintFailed: 'print_failed',
  HistoryReprintFailed: 'print_failed',
};

describe('returnsProofBridge: what main answers in each G6R state', () => {
  it.each(RETURNS_PROOF_STATES)('%s', async (state) => {
    const bridge = returnsProofBridge(state);
    const answers = {
      lookup: await outcomeOf(bridge.lookup({ saleNumber: PROOF_SALE_NUMBER })),
      quote: await outcomeOf(bridge.quote({ saleNumber: PROOF_SALE_NUMBER, lines: [] })),
      submit: await outcomeOf(bridge.submit({ saleNumber: PROOF_SALE_NUMBER, lines: [] })),
      resolve: await outcomeOf(bridge.resolve()),
      list: await outcomeOf(bridge.list()),
      payout: await outcomeOf(bridge.payout({ returnId: 'r', action: 'start' })),
      reprint: await outcomeOf(bridge.reprintSlip({ returnId: 'r' })),
    };
    expect(answers).toEqual({
      lookup: LOOKUP[state] ?? 'ok',
      quote: QUOTE[state] ?? 'ok',
      submit: SUBMIT[state] ?? 'confirmed',
      resolve: 'ok',
      list: state === 'HistoryFailed' ? 'rejected' : 'ok',
      // Without a scripted answer the payout never settles: the harness never offers one.
      payout: PAYOUT[state] ?? 'pending',
      reprint: REPRINT[state] ?? 'printed',
    });
  });
});
