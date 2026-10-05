/**
 * 011 T053 (RED) — `SaleSyncStatus` read-only indicator.
 *
 * Mirrors CatalogueFreshness's three-truthful-states discipline, but READ-ONLY:
 * there is NO refresh/trigger button (the drain is main-process background; the
 * renderer cannot start it — §A4 / P8). States are derived from the bridge counts:
 *   • never-synced  — pending 0, dead-letter 0, lastSuccessAt null
 *   • all-synced    — pending 0, dead-letter 0, lastSuccessAt present (absolute <time>)
 *   • pending       — pending > 0 (informational; offline is normal, not alarming)
 *   • attention     — dead-letter > 0 (visible-but-quiet; accountability, not panic)
 * The last-success time is ABSOLUTE (never "x ago") — PRODUCT.md honest-surfaces.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SaleSyncStatus, type SaleSyncStatusBridge } from '../SaleSyncStatus.js';
import type { SaleSyncStatusCounts } from '../../../../main/sales-sync/sale-sync-state-repo.js';

function bridgeReturning(counts: SaleSyncStatusCounts): SaleSyncStatusBridge {
  return { syncStatus: () => Promise.resolve(counts) };
}

afterEach(() => {
  cleanup();
});

describe('T053 — SaleSyncStatus', () => {
  it('shows the never-synced state when nothing has synced and nothing is pending', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 0,
          heldPreviousPairing: 0,
          deadLetter: 0,
          payloadDivergence: 0,
          lastSuccessAt: null,
        })}
      />,
    );
    const el = await screen.findByTestId('sale-sync-status');
    await waitFor(() => {
      expect(el.getAttribute('data-state')).toBe('never-synced');
    });
    expect(el.textContent).toContain('لم تتم المزامنة بعد');
  });

  it('shows the all-synced state with an absolute timestamp', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 0,
          heldPreviousPairing: 0,
          deadLetter: 0,
          payloadDivergence: 0,
          lastSuccessAt: '2026-06-07T10:00:00.000Z',
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('all-synced');
    });
    const time = screen.getByTestId('sale-sync-status-time');
    expect(time.getAttribute('dateTime')).toBe('2026-06-07T10:00:00.000Z');
  });

  it('shows the pending state with the count when sales await sync', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 3,
          heldPreviousPairing: 0,
          deadLetter: 0,
          payloadDivergence: 0,
          lastSuccessAt: null,
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('pending');
    });
    expect(screen.getByTestId('sale-sync-status').textContent).toContain('٣');
  });

  it('shows the attention state when sales are dead-lettered (visible, not alarming)', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 0,
          heldPreviousPairing: 0,
          deadLetter: 2,
          payloadDivergence: 0,
          lastSuccessAt: 'x',
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('attention');
    });
    expect(screen.getByTestId('sale-sync-status').textContent).toContain('مراجعة');
  });

  it('RT-190: names how many dead-lettered sales are payload divergences', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 0,
          heldPreviousPairing: 0,
          deadLetter: 3,
          payloadDivergence: 2,
          lastSuccessAt: null,
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('attention');
    });
    const text = screen.getByTestId('sale-sync-status').textContent;
    expect(text).toContain('٣ عملية بحاجة إلى مراجعة');
    expect(text).toContain('منها ٢ تختلف عن المسجَّل على الخادم');
  });

  it('RT-190: no divergence wording when no dead-letter is a divergence', async () => {
    render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 0,
          heldPreviousPairing: 0,
          deadLetter: 2,
          payloadDivergence: 0,
          lastSuccessAt: null,
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('attention');
    });
    expect(screen.getByTestId('sale-sync-status').textContent).not.toContain('منها');
  });

  it('is a polite status region and exposes NO button (read-only)', async () => {
    const { container } = render(
      <SaleSyncStatus
        bridge={bridgeReturning({
          pending: 1,
          heldPreviousPairing: 0,
          deadLetter: 0,
          payloadDivergence: 0,
          lastSuccessAt: null,
        })}
      />,
    );
    const el = await screen.findByTestId('sale-sync-status');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('button')).toBeNull();
  });

  it('degrades to unavailable (never crashes) if the bridge rejects', async () => {
    const bridge: SaleSyncStatusBridge = { syncStatus: () => Promise.reject(new Error('ipc')) };
    render(<SaleSyncStatus bridge={bridge} />);
    await waitFor(() => {
      expect(screen.getByTestId('sale-sync-status').getAttribute('data-state')).toBe('unavailable');
    });
  });
});
