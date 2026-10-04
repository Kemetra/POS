import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { LockStateView, SessionStateEvent } from '../../../shared/bridge-api.js';
import type {
  ReturnsLookupResponse,
  ReturnsSubmitResponse,
} from '../../../shared/returns/types.js';
import { SessionLockGate } from '../../session/SessionLockGate';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { ReturnsRoute } from '../ReturnsRoute.js';
import {
  deferred,
  settle,
  fakeBridge,
  journal,
  L1,
  lookUpSale,
  renderReturns,
  resetStores,
  SALE,
  SALE_NUMBER,
  session,
  signIn,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — S1..S4: a flow belongs to one operator session. */
afterEach(() => {
  cleanup();
  resetStores();
});

const switchOperator = (): void => {
  act(() => {
    signIn(session('manager', 'sess-other-manager'));
  });
};

describe('operator switch (S1, S2)', () => {
  it('resets the flow: the next operator never sees the previous sale', async () => {
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    switchOperator();
    expect(screen.queryByText('بانادول 500 مجم')).not.toBeInTheDocument();
    expect(screen.getByLabelText('رقم البيع')).toHaveValue('');
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });

  it('drops a lookup answer that arrives after the switch', async () => {
    const bridge = fakeBridge();
    const late = deferred<ReturnsLookupResponse>();
    bridge.lookup.mockImplementationOnce(() => late.promise);
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), `${SALE_NUMBER}{Enter}`);
    switchOperator();
    await settle(late, { kind: 'ok', sale: SALE });
    expect(screen.queryByText('بانادول 500 مجم')).not.toBeInTheDocument();
  });

  it('drops a submit outcome that arrives after the switch', async () => {
    const bridge = fakeBridge();
    const late = deferred<ReturnsSubmitResponse>();
    bridge.submit.mockImplementationOnce(() => late.promise);
    const user = userEvent.setup();
    renderReturns({ bridge });
    await submitReturn(user);
    switchOperator();
    await settle(late, { kind: 'confirmed', ret: journal(), replayed: false });
    expect(screen.queryByRole('heading', { name: 'نتيجة المرتجع' })).not.toBeInTheDocument();
  });
});

describe('sign-out (S3)', () => {
  it('removes the flow; the next manager starts fresh', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    act(() => {
      useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
    });
    expect(screen.queryByText('بانادول 500 مجم')).not.toBeInTheDocument();
    switchOperator();
    expect(screen.getByLabelText('رقم البيع')).toHaveValue('');
  });
});

const LOCKED: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-04T09:00:00.000Z',
  role: 'manager',
  display_name: 'مدير الفرع',
  summary: null,
};

describe('inactivity lock (S4)', () => {
  it('keeps the same operator flow exactly as it was across lock and unlock', async () => {
    let push: (e: SessionStateEvent) => void = () => undefined;
    let view: LockStateView = { ...LOCKED, state: 'active', locked_at: null };
    const operator = {
      getLockState: vi.fn(() => Promise.resolve(view)),
      unlockSession: vi.fn(),
      onSessionStateChanged: vi.fn((cb: (e: SessionStateEvent) => void) => {
        push = cb;
        return () => {
          push = () => undefined;
        };
      }),
    };
    useFeatureFlagsStore.getState().hydrate({ returns: true });
    signIn(session('manager'));
    const user = userEvent.setup();
    render(
      <SessionLockGate operator={operator}>
        <ReturnsRoute bridge={fakeBridge()} />
      </SessionLockGate>,
    );
    await lookUpSale(user);
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    view = LOCKED;
    act(() => {
      push({ state: 'locked' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-lock-app')).toHaveAttribute('inert');
    });
    act(() => {
      push({ state: 'active' });
    });
    expect(screen.getByTestId(`qty-${L1}`)).toHaveTextContent('1');
  });
});
