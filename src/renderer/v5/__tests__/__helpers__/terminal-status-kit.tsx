import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi, type Mock } from 'vitest';
import type { TerminalStatusBridgeAPI } from '../../../../shared/bridge-api';
import type { TerminalStatusSnapshot } from '../../../../shared/terminal-status/types';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { STATUS_NOW } from '../../../terminal-status/__tests__/__helpers__/snapshot';
import { useTerminalStatusStore } from '../../../terminal-status/terminal-status-store';
import { V5Frame } from '../../frame/V5Frame';

/**
 * RT-604 / RT-605 — the shared fake `window.api` for the status indicator and
 * status banner tests: an in-memory `terminalStatus` bridge (one read, then
 * pushes) and a `sales.subscribe` that answers `banner_state`.
 */
export interface StatusApi {
  readonly getStatus: Mock;
  readonly onChanged: Mock;
  readonly unsubscribe: Mock;
  push(snapshot: TerminalStatusSnapshot): Promise<void>;
}

export function installStatusApi(
  first: TerminalStatusSnapshot | 'reject',
  { printFailed = false }: { printFailed?: boolean } = {},
): StatusApi {
  let listener: (s: TerminalStatusSnapshot) => void = () => undefined;
  const unsubscribe = vi.fn();
  const getStatus = vi.fn(() =>
    first === 'reject' ? Promise.reject(new Error('unavailable')) : Promise.resolve(first),
  );
  const onChanged = vi.fn((cb: (s: TerminalStatusSnapshot) => void) => {
    listener = cb;
    return unsubscribe as () => void;
  });
  const terminalStatus: TerminalStatusBridgeAPI = {
    get: getStatus,
    onChanged: onChanged,
  };
  const printerFailure = printFailed
    ? { sale_id: 's-1', failure_reason: 'printer_offline', has_successful_print: false }
    : null;
  (window as unknown as { api?: unknown }).api = {
    terminalStatus,
    sales: {
      subscribe: vi.fn(() =>
        Promise.resolve({
          kind: 'ok',
          subscription_token: 't',
          banner_state: { printer_failure: printerFailure, drawer_failure: null },
        }),
      ),
      unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    },
  };
  return {
    getStatus,
    onChanged,
    unsubscribe,
    async push(snapshot) {
      await act(async () => {
        listener(snapshot);
        await Promise.resolve();
      });
    },
  };
}

/** Signs a cashier in, optionally carrying a forced-close notice. */
export function signInCashier(forcedClose = false): void {
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

/** Renders the V5 frame at `path`, with an optional notices stack. */
export async function renderStatusFrame(
  path = '/app/dashboard',
  notices?: ReactNode,
): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={[path]}>
        <V5Frame notices={notices}>
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

/** Fake Date/setTimeout at STATUS_NOW, so the 24 h line can be crossed. */
export function useStatusClock(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(STATUS_NOW);
}

export function resetStatusKit(): void {
  vi.useRealTimers();
  useOperatorSessionStore.getState().reset();
  useTerminalStatusStore.setState({ snapshot: null });
  delete (window as unknown as { api?: unknown }).api;
}
