import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerOperatorHandlers } from '../../../src/main/ipc/operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../src/shared/operator/channels.js';
import { ShiftClosedBanner } from '../../../src/renderer/ui/operator/ShiftClosedBanner.js';
import { V5AppLayout } from '../../../src/renderer/v5/frame/V5AppLayout.js';
import { SalesWorkspace } from '../../../src/renderer/routes/app/SalesWorkspace.js';
import { useOperatorSessionStore } from '../../../src/renderer/stores/operator-session-store.js';
import type { OperatorSessionView } from '../../../src/renderer/stores/operator-session-store.js';
import type { PairingStore } from '../../../src/main/pairing/store.js';

/**
 * 004-operator-session T091 — ShiftClosedBanner + forced-close notice tests.
 *
 * Covers:
 *  - ShiftClosedBanner renders message and dismiss button.
 *  - Dismiss click propagates.
 *  - No forbidden content (financial totals, counts, IDs).
 *  - OperatorSessionStore.resolveSignedIn sets forced_close_notice.
 *  - OperatorSessionStore.dismissShiftClosedNotice clears notice + calls bridge.
 *  - DashboardPlaceholder renders banner when notice is present.
 *  - DashboardPlaceholder does not render banner when notice is absent.
 *  - DISMISS_SHIFT_CLOSED_NOTICE IPC handler.
 *
 * The main-side notice resolution (sign-in) and dismiss record read the real
 * cash-up tables and are covered in
 * tests/integration/main/operator/forced-close-notice.test.ts (RT-554).
 */

// ── Constants ──────────────────────────────────────────────────────────────

const CLOSED_AT = '2026-04-01T10:00:00.000Z';
const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term1';
const CASHIER_ID = 'cashier-t091';

const SESSION_VIEW: OperatorSessionView = {
  id: 'sess-t091',
  operator_id: CASHIER_ID,
  display_name: 'Terry Cashier',
  role: 'cashier',
  tenant_id: TENANT,
  branch_id: BRANCH,
  started_at: '2026-05-10T09:00:00.000Z',
};

function makePairedStore(): PairingStore {
  return {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id: TERMINAL,
        terminal_label: 'T1',
        paired_at: 0,
      }),
    persist: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

// ── IPC test helper ────────────────────────────────────────────────────────

function makeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, (e: IpcMainInvokeEvent) => unknown>;
} {
  const handlers = new Map<string, (e: IpcMainInvokeEvent) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((ch: string, fn: (e: IpcMainInvokeEvent) => unknown) => {
        handlers.set(ch, fn);
      }),
    } as unknown as IpcMain,
    handlers,
  };
}

// ── window.api mock helper ─────────────────────────────────────────────────

function stubDismissBridgeCall(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve());
  Object.assign(window, {
    api: {
      operator: {
        dismissShiftClosedNotice: fn,
      },
    },
  });
  return fn;
}

function renderAllowedFrameRoute(): void {
  render(
    <MemoryRouter initialEntries={['/app/sales']}>
      <Routes>
        <Route element={<V5AppLayout />}>
          <Route path="/app/sales" element={<SalesWorkspace />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// ── Test lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
  delete (window as Record<string, unknown>).api;
});

// ── ShiftClosedBanner component ────────────────────────────────────────────

describe('ShiftClosedBanner — component', () => {
  it('renders the banner with a human-readable date', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    expect(screen.getByTestId('shift-closed-banner')).toBeInTheDocument();
    expect(screen.getByTestId('shift-closed-banner').textContent).toContain('2026');
  });

  it('renders the dismiss button', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    expect(screen.getByTestId('shift-closed-banner-dismiss')).toBeInTheDocument();
  });

  it('calls onDismiss when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={onDismiss} />);
    await user.click(screen.getByTestId('shift-closed-banner-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('does not expose financial totals, declared count, variance, shortage, or overage', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    const text = screen.getByTestId('shift-closed-banner').textContent || '';
    for (const forbidden of ['total', 'variance', 'shortage', 'overage', 'count', '₺', '$', '£']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('does not expose shift_id, tenant_id, branch_id, or IDs', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    const html = document.body.innerHTML;
    expect(html).not.toContain(TENANT);
    expect(html).not.toContain(BRANCH);
    expect(html).not.toContain(CASHIER_ID);
  });
});

// ── V5 frame — cashier-reachable banner integration ────────────────────────

describe('V5 frame — banner from store', () => {
  it('renders banner when signedIn state has forced_close_notice', () => {
    stubDismissBridgeCall();
    // Manually transition store to signingIn then resolveSignedIn with notice
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    renderAllowedFrameRoute();
    expect(screen.getByTestId('shift-closed-banner')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'المبيعات' })).toBeInTheDocument();
  });

  it('does not render banner when signedIn state has no notice', () => {
    stubDismissBridgeCall();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW);
    renderAllowedFrameRoute();
    expect(screen.queryByTestId('shift-closed-banner')).not.toBeInTheDocument();
  });

  it('dismiss button clears the banner from the DOM', async () => {
    const dismissFn = stubDismissBridgeCall();
    const user = userEvent.setup();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    renderAllowedFrameRoute();
    expect(screen.getByTestId('shift-closed-banner')).toBeInTheDocument();
    await user.click(screen.getByTestId('shift-closed-banner-dismiss'));
    expect(screen.queryByTestId('shift-closed-banner')).not.toBeInTheDocument();
    expect(dismissFn).toHaveBeenCalled();
  });
});

// ── OperatorSessionStore — notice lifecycle ────────────────────────────────

describe('OperatorSessionStore — notice lifecycle', () => {
  it('resolveSignedIn with notice sets forced_close_notice in signedIn state', () => {
    stubDismissBridgeCall();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.forced_close_notice).toEqual({ closed_at: CLOSED_AT });
    }
  });

  it('resolveSignedIn without notice leaves forced_close_notice undefined', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW);
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.forced_close_notice).toBeUndefined();
    }
  });

  it('dismissShiftClosedNotice clears notice from state and calls bridge', () => {
    const dismissFn = stubDismissBridgeCall();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    useOperatorSessionStore.getState().dismissShiftClosedNotice();
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.forced_close_notice).toBeUndefined();
    }
    expect(dismissFn).toHaveBeenCalledOnce();
  });

  it('dismissShiftClosedNotice catches bridge rejection after clearing local notice', async () => {
    const dismissFn = vi.fn(() => Promise.reject(new Error('SECRET-STORE-DETAIL')));
    Object.assign(window, {
      api: {
        operator: {
          dismissShiftClosedNotice: dismissFn,
        },
      },
    });
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    useOperatorSessionStore.getState().dismissShiftClosedNotice();
    await Promise.resolve();

    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.forced_close_notice).toBeUndefined();
    }
    expect(dismissFn).toHaveBeenCalledOnce();
  });
});

// ── registerOperatorHandlers — DISMISS_SHIFT_CLOSED_NOTICE IPC ───────────

describe('registerOperatorHandlers — DISMISS_SHIFT_CLOSED_NOTICE', () => {
  const FAKE_EVENT = {} as IpcMainInvokeEvent;

  function buildIpcEnv(opts: { session: { operator_id: string } | null; paired: boolean }) {
    const dismissFn = vi.fn().mockResolvedValue(undefined);
    const { ipcMain, handlers } = makeIpcMain();
    registerOperatorHandlers(ipcMain, {
      signInHandler: { signIn: vi.fn() } as unknown as never,
      cashierSignInHandler: {
        signIn: vi.fn(),
        dismissForcedCloseNotice: dismissFn,
      } as unknown as never,
      signOutHandler: { signOut: vi.fn() } as unknown as never,
      rosterHandler: { listRoster: vi.fn() } as unknown as never,
      sessionManager: {
        getCurrent: vi.fn(() => opts.session),
        getCurrentBridgeView: vi.fn(() => null),
      } as unknown as never,
      inactivityMonitor: { reportActivity: vi.fn() } as unknown as never,
      auditEmitter: { emit: vi.fn() } as unknown as never,
      pairingStore: opts.paired
        ? makePairedStore()
        : ({ getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' })) } as unknown as never),
      takeoverHandler: { confirmTakeover: vi.fn(), cancelTakeover: vi.fn() } as unknown as never,
      pinManagementHandler: {
        resetCashierPin: vi.fn(),
        provisionCashierPin: vi.fn(),
        unlockCashier: vi.fn(),
      } as unknown as never,
      forcedCloseHandler: { forceCloseShift: vi.fn() } as unknown as never,
      stuckShiftsHandler: { listStuckShifts: vi.fn() } as unknown as never,
    });

    const invoke = (): Promise<unknown> => {
      const fn = handlers.get(OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE);
      if (!fn) throw new Error('handler not registered');
      return Promise.resolve(fn(FAKE_EVENT));
    };

    return { invoke, dismissFn };
  }

  it('calls dismissForcedCloseNotice when session is set and terminal is paired', async () => {
    const { invoke, dismissFn } = buildIpcEnv({
      session: { operator_id: CASHIER_ID },
      paired: true,
    });
    await invoke();
    expect(dismissFn).toHaveBeenCalledWith(TENANT, BRANCH, TERMINAL, CASHIER_ID);
  });

  it('is a no-op when session is null', async () => {
    const { invoke, dismissFn } = buildIpcEnv({ session: null, paired: true });
    await invoke();
    expect(dismissFn).not.toHaveBeenCalled();
  });

  it('is a no-op when terminal is not paired', async () => {
    const { invoke, dismissFn } = buildIpcEnv({
      session: { operator_id: CASHIER_ID },
      paired: false,
    });
    await invoke();
    expect(dismissFn).not.toHaveBeenCalled();
  });
});
