/**
 * RT-605 (VN-S6 S6-4, doc 24 §4.3) — the offline banner M-O1 and the
 * sync-attention banner M-O3 in the `V5OperationalNotices` stack. They read
 * the S6-3 terminal-status store (one subscription, owned by the indicator)
 * and the S6-3 mapping, so there is no second subscription and no second 24 h
 * rule. The connection banner has moved out of the frame's 007 StatusBanner,
 * so offline is never shown twice.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusBridgeAPI } from '../../../shared/bridge-api';
import type {
  ConnectionStateCode,
  TerminalStatusSnapshot,
  TerminalStatusSync,
} from '../../../shared/terminal-status/types';
import { useConnectionStateStore } from '../../connection/connection-state';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { SYNC_ATTENTION_AGE_MS } from '../../terminal-status/status-mapping';
import { useTerminalStatusStore } from '../../terminal-status/terminal-status-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { V5Frame } from '../frame/V5Frame';
import { V5OperationalNotices } from '../frame/V5OperationalNotices';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const M_O1 = 'غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.';

function snap(
  connection: ConnectionStateCode,
  sync: Partial<TerminalStatusSync> = {},
): TerminalStatusSnapshot {
  return {
    v: 1,
    connection,
    connectionSince: '2026-10-17T11:59:00.000Z',
    lastContactAt: null,
    sync: {
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: null,
      ...sync,
    },
  };
}

let push: (s: TerminalStatusSnapshot) => void = () => undefined;
let getStatus: ReturnType<typeof vi.fn>;
let onChanged: ReturnType<typeof vi.fn>;
let printFailed = false;

function installApi(first: TerminalStatusSnapshot): void {
  getStatus = vi.fn(() => Promise.resolve(first));
  onChanged = vi.fn((cb: (s: TerminalStatusSnapshot) => void) => {
    push = cb;
    return () => undefined;
  });
  const bridge: TerminalStatusBridgeAPI = {
    get: getStatus as TerminalStatusBridgeAPI['get'],
    onChanged: onChanged as TerminalStatusBridgeAPI['onChanged'],
  };
  (window as unknown as { api?: unknown }).api = {
    terminalStatus: bridge,
    sales: {
      subscribe: vi.fn(() =>
        Promise.resolve({
          kind: 'ok',
          subscription_token: 't',
          banner_state: {
            printer_failure: printFailed
              ? { sale_id: 's-1', failure_reason: 'printer_offline', has_successful_print: false }
              : null,
            drawer_failure: null,
          },
        }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    },
  };
}

function signIn(forcedClose = false): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'session-1',
        operator_id: 'op-1',
        display_name: 'د. سارة',
        role: 'cashier',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        started_at: '2026-10-17T09:00:00Z',
      },
      ...(forcedClose ? { forced_close_notice: { closed_at: '2026-10-17T08:00:00Z' } } : {}),
    },
  });
}

async function renderAt(path = '/app/dashboard', forcedClose = false): Promise<void> {
  signIn(forcedClose);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <V5Frame notices={<V5OperationalNotices />}>
          <section aria-labelledby="t">
            <h1 id="t">شاشة</h1>
          </section>
        </V5Frame>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
}

function notices(): HTMLElement {
  return screen.getByTestId('v5-frame-notices');
}

function offlineBanner(): HTMLElement | null {
  return screen.queryByTestId('v5-offline-banner');
}

function attentionBanner(): HTMLElement | null {
  return screen.queryByTestId('v5-sync-attention-banner');
}

async function pushNow(s: TerminalStatusSnapshot): Promise<void> {
  await act(async () => {
    push(s);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  printFailed = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useOperatorSessionStore.getState().reset();
  useTerminalStatusStore.setState({ snapshot: null });
  useConnectionStateStore.getState().setState('online');
  delete (window as unknown as { api?: unknown }).api;
});

describe('offline banner M-O1 (U3)', () => {
  it.each(['offline', 'degraded'] as const)(
    'shows the frozen M-O1 as a persistent warning while %s',
    async (connection) => {
      installApi(snap(connection));
      await renderAt();
      const banner = offlineBanner();
      expect(banner).not.toBeNull();
      expect(banner).toHaveAttribute('data-tone', 'warning');
      expect(banner).toHaveAttribute('role', 'status');
      expect(banner).toHaveTextContent(M_O1);
      expect(within(notices()).getByTestId('v5-offline-banner')).toBe(banner);
      // Persistent: no dismiss, it leaves only when the connection is back.
      expect(within(banner as HTMLElement).queryByRole('button')).toBeNull();
    },
  );

  it.each(['online', 'checking'] as const)('shows nothing while %s', async (connection) => {
    installApi(snap(connection));
    await renderAt();
    expect(offlineBanner()).toBeNull();
  });

  it('shows nothing before the first snapshot (never a guess)', async () => {
    installApi(snap('offline'));
    getStatus.mockReturnValue(new Promise(() => undefined));
    await renderAt();
    expect(offlineBanner()).toBeNull();
  });

  it('follows the push: appears when the connection drops and leaves when it is back', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(offlineBanner()).toBeNull();
    await pushNow(snap('offline'));
    expect(offlineBanner()).toHaveTextContent(M_O1);
    await pushNow(snap('online'));
    expect(offlineBanner()).toBeNull();
  });

  it('lists no online-only actions (D-6-9)', async () => {
    installApi(snap('offline'));
    await renderAt();
    const banner = offlineBanner() as HTMLElement;
    expect(banner.querySelectorAll('li')).toHaveLength(0);
    expect(within(banner).queryByRole('link')).toBeNull();
  });
});

describe('sync-attention banner M-O3 (U2)', () => {
  it('shows the frozen M-O3 as a persistent danger on a dead letter', async () => {
    installApi(snap('online', { deadLetter: 2 }));
    await renderAt();
    const banner = attentionBanner();
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('تعذّر إرسال 2 عمليات. راجع المدير.');
    expect(within(banner as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('isolates the count as an LTR run in Western digits', async () => {
    installApi(snap('online', { deadLetter: 12 }));
    await renderAt();
    const num = attentionBanner()?.querySelector('[dir="ltr"]');
    expect(num).toHaveTextContent(/^12$/);
  });

  it('shows when the oldest pending sale is older than 24 h', async () => {
    const oldest = new Date(NOW - SYNC_ATTENTION_AGE_MS - 60_000).toISOString();
    installApi(snap('online', { pending: 3, oldestPendingAt: oldest }));
    await renderAt();
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال 3 عمليات. راجع المدير.');
  });

  it('appears once the oldest pending sale passes 24 h, with no extra read', async () => {
    const since = NOW - SYNC_ATTENTION_AGE_MS + 60_000;
    installApi(snap('online', { pending: 1, oldestPendingAt: new Date(since).toISOString() }));
    await renderAt();
    expect(attentionBanner()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_001);
      await Promise.resolve();
    });
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال 1 عمليات. راجع المدير.');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for pending sales younger than 24 h, or for a paused queue', async () => {
    const oldest = new Date(NOW - 60_000).toISOString();
    installApi(
      snap('online', { pending: 2, oldestPendingAt: oldest, paused: 'no_operator_credential' }),
    );
    await renderAt();
    expect(attentionBanner()).toBeNull();
  });
});

describe('the stack (doc 24 §4.3)', () => {
  it('orders: sync attention, shift closed, offline, then the printer banner', async () => {
    printFailed = true;
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt('/app/dashboard', true);
    const printer = await screen.findByTestId('printer-failure-banner');
    const attention = attentionBanner() as HTMLElement;
    const offline = offlineBanner() as HTMLElement;
    const shiftClosed = within(notices())
      .getAllByRole('status')
      .find((el) => el !== offline && !printer.contains(el) && el !== printer) as HTMLElement;
    expect(shiftClosed).toBeDefined();
    const pairs: [HTMLElement, HTMLElement][] = [
      [attention, shiftClosed],
      [shiftClosed, offline],
      [offline, printer],
    ];
    for (const [before, after] of pairs) {
      expect(before.compareDocumentPosition(after)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('never shows offline twice: the frame no longer renders the 007 connection banner', async () => {
    useConnectionStateStore.getState().setState('offline');
    installApi(snap('offline'));
    await renderAt();
    expect(screen.getAllByText(/^غير متصل —/)).toHaveLength(1);
    expect(document.querySelector('[data-state="offline"]')).toBeNull();
    expect(screen.queryByText('غير متصل — البيع من قائمة الانتظار المحلية')).toBeNull();
  });

  it('reads the indicator’s store: one get and one push subscription for the whole frame', async () => {
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt();
    expect(offlineBanner()).not.toBeNull();
    expect(attentionBanner()).not.toBeNull();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each(['/app/dashboard', '/app/cart'])(
    'shows both banners in the frame at %s',
    async (path) => {
      installApi(snap('offline', { deadLetter: 1 }));
      await renderAt(path);
      expect(within(notices()).getByTestId('v5-offline-banner')).toBeInTheDocument();
      expect(within(notices()).getByTestId('v5-sync-attention-banner')).toBeInTheDocument();
    },
  );

  it('is axe-clean with both banners, in the labelled panel and the slim rail', async () => {
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt('/app/dashboard');
    await expectNoAxeViolations(notices());
    cleanup();
    await renderAt('/app/cart');
    await expectNoAxeViolations(notices());
  });
});
