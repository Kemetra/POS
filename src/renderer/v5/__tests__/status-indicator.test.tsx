/**
 * RT-604 (VN-S6 S6-3, doc 24 §4.1 / §4.2) — the StatusIndicator in the V5
 * navigation footer: a connection row, a sync row when there is something to
 * say, and a printer row only while the last print failed (D-6-7). Fed by the
 * `terminalStatus` bridge push; it never polls the status itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { SYNC_ATTENTION_AGE_MS } from '../../terminal-status/status-mapping';
import { useTerminalStatusStore } from '../../terminal-status/terminal-status-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { V5Frame } from '../frame/V5Frame';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

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
let unsubscribe: ReturnType<typeof vi.fn>;
let printFailed = false;

function installApi(first: TerminalStatusSnapshot | 'reject'): void {
  unsubscribe = vi.fn();
  getStatus = vi.fn(() =>
    first === 'reject' ? Promise.reject(new Error('unavailable')) : Promise.resolve(first),
  );
  const bridge: TerminalStatusBridgeAPI = {
    get: getStatus as TerminalStatusBridgeAPI['get'],
    onChanged: (cb) => {
      push = cb;
      return unsubscribe as () => void;
    },
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

function signIn(): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'د. سارة',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-17T09:00:00Z',
  });
}

async function renderAt(path = '/app/dashboard'): Promise<ReturnType<typeof render>> {
  signIn();
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={[path]}>
        <V5Frame>
          <section aria-labelledby="t">
            <h1 id="t">شاشة</h1>
          </section>
        </V5Frame>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  return result;
}

function indicator(): HTMLElement {
  return screen.getByTestId('v5-status-indicator');
}

function row(name: 'connection' | 'sync' | 'printer'): HTMLElement | null {
  return indicator().querySelector(`[data-row="${name}"]`);
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
  delete (window as unknown as { api?: unknown }).api;
});

describe('StatusIndicator — placement', () => {
  it('lives in the navigation footer, before the operator block', async () => {
    installApi(snap('online'));
    await renderAt();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).getByTestId('v5-status-indicator')).toBeInTheDocument();
    const operator = screen.getByTestId('v5-frame-operator');
    expect(
      indicator().compareDocumentPosition(operator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('StatusIndicator — connection row', () => {
  it('shows «جارٍ التحقق من الاتصال» until the first snapshot, never «متصل»', async () => {
    installApi('reject');
    await renderAt();
    expect(row('connection')).toHaveTextContent('جارٍ التحقق من الاتصال');
    expect(row('connection')).toHaveAttribute('data-tone', 'neutral');
    expect(indicator()).not.toHaveTextContent('متصل');
  });

  it.each([
    ['online', 'متصل', 'success'],
    ['offline', 'غير متصل', 'warning'],
    ['degraded', 'غير متصل', 'warning'],
    ['checking', 'جارٍ التحقق من الاتصال', 'neutral'],
  ] as const)('%s → «%s» (%s)', async (connection, text, tone) => {
    installApi(snap(connection));
    await renderAt();
    expect(row('connection')).toHaveTextContent(text);
    expect(row('connection')).toHaveAttribute('data-tone', tone);
  });

  it('follows the push', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(row('connection')).toHaveTextContent('متصل');
    await pushNow(snap('offline'));
    expect(row('connection')).toHaveTextContent('غير متصل');
  });

  it('pairs every tone with a glyph, so it is never told by colour alone', async () => {
    installApi(snap('offline'));
    await renderAt();
    const glyph = row('connection')?.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('is the only polite live region: a connection change is announced, a count change is not', async () => {
    installApi(snap('online', { pending: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    await renderAt();
    expect(row('connection')).toHaveAttribute('role', 'status');
    expect(row('connection')).toHaveAttribute('aria-live', 'polite');
    expect(row('sync')?.closest('[aria-live]')).toBeNull();
  });
});

describe('StatusIndicator — sync row', () => {
  const oldest = '2026-10-17T11:00:00.000Z';

  it('shows no sync row when nothing is pending (idle)', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(row('sync')).toBeNull();
  });

  it('shows S16 «جارٍ إرسال ‹n› عملية…» while online and sending', async () => {
    installApi(snap('online', { pending: 3, oldestPendingAt: oldest }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('جارٍ إرسال 3 عملية…');
    expect(row('sync')).toHaveAttribute('data-tone', 'info');
  });

  it('shows M-O2 «‹n› عمليات بانتظار الإرسال» while paused — never «sending» (D-6-6)', async () => {
    installApi(
      snap('online', { pending: 2, oldestPendingAt: oldest, paused: 'no_operator_credential' }),
    );
    await renderAt();
    expect(row('sync')).toHaveTextContent('2 عمليات بانتظار الإرسال');
    expect(row('sync')).not.toHaveTextContent('جارٍ إرسال');
  });

  it('shows M-O2 while offline', async () => {
    installApi(snap('offline', { pending: 4, oldestPendingAt: oldest }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('4 عمليات بانتظار الإرسال');
  });

  it('shows «تحتاج مراجعة» on a dead letter', async () => {
    installApi(snap('online', { deadLetter: 1 }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('تحتاج مراجعة');
    expect(row('sync')).toHaveAttribute('data-tone', 'danger');
  });

  it('isolates the count as an LTR run in Western digits', async () => {
    installApi(snap('online', { pending: 12, oldestPendingAt: oldest }));
    await renderAt();
    const num = row('sync')?.querySelector('.v5-status__num');
    expect(num).toHaveTextContent(/^12$/);
    expect(num).toHaveAttribute('dir', 'ltr');
  });

  it('turns to «تحتاج مراجعة» once the oldest pending sale passes 24 h, with no extra read', async () => {
    const since = NOW - SYNC_ATTENTION_AGE_MS + 60_000;
    installApi(snap('online', { pending: 1, oldestPendingAt: new Date(since).toISOString() }));
    await renderAt();
    expect(row('sync')).toHaveTextContent('جارٍ إرسال 1 عملية…');
    await act(async () => {
      vi.advanceTimersByTime(60_001);
      await Promise.resolve();
    });
    expect(row('sync')).toHaveTextContent('تحتاج مراجعة');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('StatusIndicator — printer row (D-6-7)', () => {
  it('shows «فشل آخر إيصال» only while the last print failed', async () => {
    printFailed = true;
    installApi(snap('online'));
    await renderAt();
    await act(async () => {
      await Promise.resolve();
    });
    expect(row('printer')).toHaveTextContent('فشل آخر إيصال');
    expect(row('printer')).toHaveAttribute('data-tone', 'warning');
  });

  it('shows no printer row otherwise, and never «جاهز»', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(row('printer')).toBeNull();
    expect(indicator()).not.toHaveTextContent('جاهز');
  });
});

describe('StatusIndicator — slim rail and lifetime', () => {
  it('keeps the row text in the slim rail (shown as dots, read by assistive tech)', async () => {
    installApi(snap('offline', { pending: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    await renderAt('/app/cart');
    expect(screen.getByTestId('v5-frame')).toHaveAttribute('data-nav', 'slim');
    expect(row('connection')).toHaveTextContent('غير متصل');
    expect(row('sync')).toHaveTextContent('2 عمليات بانتظار الإرسال');
  });

  it('unsubscribes from the push on unmount', async () => {
    installApi(snap('online'));
    const { unmount } = await renderAt();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean in the labelled panel and the slim rail', async () => {
    printFailed = true;
    installApi(snap('offline', { pending: 2, oldestPendingAt: '2026-10-17T11:00:00.000Z' }));
    const panel = await renderAt();
    await expectNoAxeViolations(panel.container);
    cleanup();
    installApi(snap('online', { deadLetter: 1 }));
    const slim = await renderAt('/app/cart');
    await expectNoAxeViolations(slim.container);
  });
});

describe('StatusIndicator CSS', () => {
  const css = readFileSync(resolve(__dirname, '../frame/status-indicator.css'), 'utf8');

  it('uses tabular Western digits for counts', () => {
    expect(css).toMatch(/\.v5-status__num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it('keeps a visible edge for each glyph in forced colours', () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/);
  });

  it('never sets indicator text below 12px', () => {
    expect(css).not.toMatch(/font-size:\s*(?:var\(--font-size-2xs\)|1[01]px|[0-9]px)/);
  });
});
