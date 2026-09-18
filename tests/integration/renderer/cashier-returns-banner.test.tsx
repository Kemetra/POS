import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerOperatorHandlers } from '../../../src/main/ipc/operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../src/shared/operator/channels.js';
import { ShiftClosedBanner } from '../../../src/renderer/ui/operator/ShiftClosedBanner.js';
import { AppShell } from '../../../src/renderer/shell/AppShell.js';
import { SalesWorkspace } from '../../../src/renderer/routes/app/SalesWorkspace.js';
import { useOperatorSessionStore } from '../../../src/renderer/stores/operator-session-store.js';
import type { OperatorSessionView } from '../../../src/renderer/stores/operator-session-store.js';
import {
  CashierSignInHandler,
  makeShiftDismissKey,
} from '../../../src/main/operator/sign-in-handler.js';
import type { CashierSignInRequest } from '../../../src/main/operator/sign-in-handler.js';
import { hashPin } from '../../../src/main/operator/pin-credential.js';
import { sealPinMaterial } from '../../../src/main/operator/pin-seal.js';
import type { SafeStorageLike } from '../../../src/main/secrets/safe-storage.js';
import type { DatabaseHandle } from '../../../src/main/db/client.js';
import type { PairingStore } from '../../../src/main/pairing/store.js';
import { SessionManager } from '../../../src/main/operator/session-manager.js';
import { ProtoSessionStore } from '../../../src/main/operator/takeover-handler.js';
import type { CheckActiveSessionHandler } from '../../../src/main/operator/check-active-session.js';
import type { SecretKey, SecretStore } from '../../../src/shared/secret-store.js';

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
 *  - CashierSignInHandler.dismissForcedCloseNotice writes dismiss record.
 *  - CashierSignInHandler.signIn returns notice when forced-close shift exists.
 *  - CashierSignInHandler.signIn omits notice when dismiss record matches.
 *  - CashierSignInHandler.signIn omits notice when no forced-close shift.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const CLOSED_AT = '2026-04-01T10:00:00.000Z';
const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term1';
const CASHIER_ID = 'cashier-t091';
const PIN = '4321';

const SESSION_VIEW: OperatorSessionView = {
  id: 'sess-t091',
  operator_id: CASHIER_ID,
  display_name: 'Terry Cashier',
  role: 'cashier',
  tenant_id: TENANT,
  branch_id: BRANCH,
  started_at: '2026-05-10T09:00:00.000Z',
};

// ── Fake safeStorage (prefix-seal scheme matching existing tests) ──────────

const PREFIX = Buffer.from('SEALED:', 'utf8');

function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.concat([PREFIX, Buffer.from(plain, 'utf8')]),
    decryptString: (buf) => {
      if (!buf.subarray(0, PREFIX.length).equals(PREFIX)) {
        throw new Error('invalid ciphertext');
      }
      return buf.subarray(PREFIX.length).toString('utf8');
    },
  };
}

const ss = makeFakeSafeStorage();

// ── DB row type ────────────────────────────────────────────────────────────

interface TestDbRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  cashier_clerk_user_id: string;
  pin_hash: Buffer;
  pin_salt: Buffer;
  failed_attempt_count: number;
  lockout_until: string | null;
}

interface TestShiftRow {
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  opening_operator_id: string;
  closed_at: string;
}

let baseRow: TestDbRow;

beforeAll(async () => {
  const { pin_hash, pin_salt } = await hashPin(PIN);
  const sealed = sealPinMaterial({ pin_hash, pin_salt }, ss);
  baseRow = {
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    cashier_clerk_user_id: CASHIER_ID,
    pin_hash: sealed.pin_hash,
    pin_salt: sealed.pin_salt,
    failed_attempt_count: 0,
    lockout_until: null,
  };
}, 15_000);

// ── Fakes ──────────────────────────────────────────────────────────────────

function makeShiftRow(overrides: Partial<TestShiftRow> = {}): TestShiftRow {
  return {
    tenant_id: TENANT,
    branch_id: BRANCH,
    originating_terminal_id: TERMINAL,
    opening_operator_id: CASHIER_ID,
    closed_at: CLOSED_AT,
    ...overrides,
  };
}

function makeDb(pinRow: TestDbRow, shiftRow: TestShiftRow | undefined): DatabaseHandle {
  return {
    pragma: () => undefined,
    prepare(sql: string) {
      if (/shifts/i.test(sql)) {
        return {
          get: (tenantId: string, branchId: string, terminalId: string, cashierId: string) => {
            if (shiftRow === undefined) return undefined;
            if (shiftRow.tenant_id !== tenantId) return undefined;
            if (shiftRow.branch_id !== branchId) return undefined;
            if (shiftRow.originating_terminal_id !== terminalId) return undefined;
            if (shiftRow.opening_operator_id !== cashierId) return undefined;
            return { closed_at: shiftRow.closed_at };
          },
        };
      }
      if (/^\s*SELECT/i.test(sql)) {
        return { get: () => pinRow };
      }
      return { run: () => undefined };
    },
    exec: () => undefined,
    transaction: <T,>(fn: T) => fn,
    close: () => undefined,
  };
}

function makeMemorySecretStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn((key: SecretKey) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: SecretKey, val: string) => {
      data.set(key, val);
      return Promise.resolve();
    }),
    delete: vi.fn((key: SecretKey) => {
      data.delete(key);
      return Promise.resolve();
    }),
    isProductionBacked: () => false,
  };
}

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

function makeCheckActive(): CheckActiveSessionHandler {
  return {
    checkActiveSession: vi.fn().mockResolvedValue({ kind: 'none' }),
  } as unknown as CheckActiveSessionHandler;
}

function makeRequest(): CashierSignInRequest {
  return {
    kind: 'cashier',
    cashier_clerk_user_id: CASHIER_ID,
    pin: PIN,
    display_name: 'Terry Cashier',
  };
}

function makeHandler(
  shiftRow: TestShiftRow | undefined,
  store?: SecretStore,
): CashierSignInHandler {
  return new CashierSignInHandler({
    db: makeDb(baseRow, shiftRow),
    safeStorage: ss,
    sessionManager: new SessionManager(),
    checkActiveSession: makeCheckActive(),
    pairingStore: makePairedStore(),
    protoStore: new ProtoSessionStore(),
    secretStore: store,
  });
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

function renderAllowedShellRoute(): void {
  render(
    <MemoryRouter initialEntries={['/app/sales']}>
      <Routes>
        <Route element={<AppShell />}>
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

// ── AppShell — cashier-reachable banner integration ────────────────────────

describe('AppShell — banner from store', () => {
  it('renders banner when signedIn state has forced_close_notice', () => {
    stubDismissBridgeCall();
    // Manually transition store to signingIn then resolveSignedIn with notice
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    renderAllowedShellRoute();
    expect(screen.getByTestId('shift-closed-banner')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('does not render banner when signedIn state has no notice', () => {
    stubDismissBridgeCall();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW);
    renderAllowedShellRoute();
    expect(screen.queryByTestId('shift-closed-banner')).not.toBeInTheDocument();
  });

  it('dismiss button clears the banner from the DOM', async () => {
    const dismissFn = stubDismissBridgeCall();
    const user = userEvent.setup();
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SESSION_VIEW, { closed_at: CLOSED_AT });
    renderAllowedShellRoute();
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

// ── CashierSignInHandler — forced-close notice injection ───────────────────

describe('CashierSignInHandler.signIn — notice injection', () => {
  it('returns forced_close_notice when forced-close shift exists and no dismiss record', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(makeShiftRow(), store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toEqual({ closed_at: CLOSED_AT });
    }
  });

  it('omits forced_close_notice when dismiss record matches closed_at', async () => {
    const store = makeMemorySecretStore();
    const dismissKey = makeShiftDismissKey(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    await store.set(dismissKey, JSON.stringify({ dismissed_closed_at: CLOSED_AT }));
    const handler = makeHandler(makeShiftRow(), store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toBeUndefined();
    }
  });

  it('shows notice when dismiss record exists for a different closed_at', async () => {
    const store = makeMemorySecretStore();
    const dismissKey = makeShiftDismissKey(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    await store.set(
      dismissKey,
      JSON.stringify({ dismissed_closed_at: '2026-01-01T00:00:00.000Z' }),
    );
    const handler = makeHandler(makeShiftRow(), store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toEqual({ closed_at: CLOSED_AT });
    }
  });

  it('omits forced_close_notice when no forced-close shift exists', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(undefined, store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toBeUndefined();
    }
  });

  it('ignores forced-close notices from another branch', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(makeShiftRow({ branch_id: 'branch-other' }), store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toBeUndefined();
    }
  });

  it('ignores forced-close notices from another terminal', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(makeShiftRow({ originating_terminal_id: 'terminal-other' }), store);
    const result = await handler.signIn(makeRequest());
    expect(result.kind).toBe('signed_in');
    if (result.kind === 'signed_in') {
      expect(result.forced_close_notice).toBeUndefined();
    }
  });
});

// ── CashierSignInHandler.dismissForcedCloseNotice ─────────────────────────

describe('CashierSignInHandler.dismissForcedCloseNotice', () => {
  it('writes dismiss record to secretStore with correct key and closed_at', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(makeShiftRow(), store);
    await handler.dismissForcedCloseNotice(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(store.set)).toHaveBeenCalledOnce();
    const dismissKey = makeShiftDismissKey(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    const stored = store.data.get(dismissKey);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(String(stored)) as { dismissed_closed_at: string };
    expect(parsed.dismissed_closed_at).toBe(CLOSED_AT);
  });

  it('is a no-op when no forced-close shift exists', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(undefined, store);
    await handler.dismissForcedCloseNotice(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
  });

  it('is a no-op when secretStore is absent (test environments)', async () => {
    const handler = makeHandler(makeShiftRow(), undefined);
    await expect(
      handler.dismissForcedCloseNotice(TENANT, BRANCH, TERMINAL, CASHIER_ID),
    ).resolves.toBeUndefined();
  });

  it('does not dismiss a notice from another branch or terminal', async () => {
    const store = makeMemorySecretStore();
    const handler = makeHandler(makeShiftRow({ branch_id: 'branch-other' }), store);
    await handler.dismissForcedCloseNotice(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();

    const terminalHandler = makeHandler(
      makeShiftRow({ originating_terminal_id: 'terminal-other' }),
      store,
    );
    await terminalHandler.dismissForcedCloseNotice(TENANT, BRANCH, TERMINAL, CASHIER_ID);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(store.set)).not.toHaveBeenCalled();
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
