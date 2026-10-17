import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type {
  SaleHistoryBridgeAPI,
  SaleHistoryZoneStatusResponse,
} from '../../../../../../shared/sale-history/types';
import { expectNoAxeViolations } from '../../../../../test-utils/axe-config';
import { SalesHistory } from '../SalesHistory';
import { HISTORY_COPY as C } from '../history-copy';

afterEach(() => {
  cleanup();
});

const NOW = (): Date => new Date('2026-10-16T08:00:00.000Z');

const ok = (
  status: 'unknown' | 'match' | 'mismatch',
  reported: string | null = null,
): SaleHistoryZoneStatusResponse => ({
  kind: 'ok',
  status,
  expected: 'Africa/Cairo',
  reported,
});

function bridgeWith(
  zone: SaleHistoryZoneStatusResponse | (() => Promise<SaleHistoryZoneStatusResponse>),
): SaleHistoryBridgeAPI & { zoneStatus: Mock<SaleHistoryBridgeAPI['zoneStatus']> } {
  return {
    list: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        source: 'local' as const,
        coverage: 'this_device_only' as const,
        offline_reason: 'no_connection' as const,
        rows: [],
        next_cursor: null,
      }),
    ),
    read: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'unavailable' as const }),
    ),
    reprint: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'unavailable' as const }),
    ),
    zoneStatus: vi.fn<SaleHistoryBridgeAPI['zoneStatus']>(
      typeof zone === 'function' ? zone : () => Promise.resolve(zone),
    ),
  };
}

describe('RT-553 zone mismatch notice', () => {
  it('shows a non-blocking Arabic warning naming both zones on a mismatch', async () => {
    render(<SalesHistory _testBridge={bridgeWith(ok('mismatch', 'UTC'))} _now={NOW} />);
    const notice = await screen.findByTestId('history-zone-mismatch');
    expect(notice).toHaveTextContent(C.zoneMismatchTitle);
    expect(notice).toHaveTextContent('UTC');
    expect(notice).toHaveTextContent('Africa/Cairo');
    expect(notice).toHaveTextContent(C.zoneMismatchBody);
    expect(notice.textContent).toContain('متابعة البيع');
    // Selling and searching stay available.
    expect(screen.getByRole('button', { name: C.show })).toBeEnabled();
    await expectNoAxeViolations(notice);
  });

  it('says the zone is unreadable when the server’s zone is not a valid name', async () => {
    render(<SalesHistory _testBridge={bridgeWith(ok('mismatch', null))} _now={NOW} />);
    expect(await screen.findByTestId('history-zone-mismatch')).toHaveTextContent(C.zoneUnreadable);
  });

  it.each(['match', 'unknown'] as const)('is absent when the status is %s', async (status) => {
    const bridge = bridgeWith(ok(status));
    render(<SalesHistory _testBridge={bridge} _now={NOW} />);
    await waitFor(() => {
      expect(bridge.zoneStatus).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('history-zone-mismatch')).toBeNull();
  });

  it('is absent when main refuses (locked, no role) or the call fails', async () => {
    const refused = bridgeWith({ kind: 'refused', reason: 'no_session' });
    const failing = bridgeWith(() => Promise.reject(new Error('boom')));
    for (const bridge of [refused, failing]) {
      render(<SalesHistory _testBridge={bridge} _now={NOW} />);
      await waitFor(() => {
        expect(bridge.zoneStatus).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('history-zone-mismatch')).toBeNull();
      cleanup();
    }
  });

  it('re-reads after a history answer, so a flag raised by that page appears', async () => {
    let calls = 0;
    const bridge = bridgeWith(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? ok('unknown') : ok('mismatch', 'UTC'));
    });
    render(<SalesHistory _testBridge={bridge} _now={NOW} />);
    await waitFor(() => {
      expect(bridge.zoneStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('history-zone-mismatch')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: C.show }));
    expect(await screen.findByTestId('history-zone-mismatch')).toBeInTheDocument();
  });

  it.each([
    ['is refused', () => Promise.resolve({ kind: 'refused', reason: 'session_changed' } as const)],
    ['fails', () => Promise.reject(new Error('boom'))],
  ])('keeps a shown warning when a later read %s', async (_label, later) => {
    let calls = 0;
    const bridge = bridgeWith(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(ok('mismatch', 'UTC')) : later();
    });
    render(<SalesHistory _testBridge={bridge} _now={NOW} />);
    expect(await screen.findByTestId('history-zone-mismatch')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: C.show }));
    await waitFor(() => {
      expect(bridge.zoneStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('history-zone-mismatch')).toBeInTheDocument();
  });

  it('asks main with an empty request and no bridge means no call', async () => {
    const bridge = bridgeWith(ok('match'));
    render(<SalesHistory _testBridge={bridge} _now={NOW} />);
    await waitFor(() => {
      expect(bridge.zoneStatus).toHaveBeenCalledWith({});
    });
  });
});
