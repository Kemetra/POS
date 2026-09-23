import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config';
import { CatalogueFreshness } from '../CatalogueFreshness';
import type {
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
} from '../../../../shared/bridge-api.js';

/**
 * 010 T045 (RED) — `CatalogueFreshness` indicator + manual-refresh affordance
 * (US3, FR-16 / FR-16b / SC-10; §A4 P9-1 / R-FRESHNESS-WIRING).
 *
 * A compact inline status line (NOT a card) + a ghost "refresh" button. The
 * three truthful freshness states each get an icon + Arabic-first text — color
 * is NEVER the sole signal (PRODUCT.md a11y). Absolute timestamp only (owner
 * decision: relative time needs a ticking clock or it lies; absolute is
 * auditable). Refresh reports started / already_running honestly and never
 * blocks. role="status" / polite — it does not steal focus mid-transaction.
 *
 * The bridge calls are INJECTED (the `bridge` prop mirrors the 009 `_testBridge`
 * seam); production reads `window.api.catalogue`.
 */

function freshnessBridge(over: {
  freshness?: () => Promise<CatalogueFreshnessResponse>;
  refresh?: () => Promise<CatalogueRefreshResponse>;
}) {
  return {
    freshness: over.freshness ?? (() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
    refresh: over.refresh ?? (() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
  };
}

afterEach(() => {
  cleanup();
});

describe('T045 — CatalogueFreshness: three truthful states', () => {
  it('never-synced (last_success_at null) → "not yet downloaded", no timestamp', async () => {
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
    });
    render(<CatalogueFreshness bridge={bridge} />);

    await waitFor(() =>
      expect(screen.getByTestId('catalogue-freshness')).toHaveAttribute(
        'data-state',
        'never-synced',
      ),
    );
    expect(screen.getByText(/لم يُنزّل الكتالوج بعد/)).toBeInTheDocument();
    // No timestamp is shown when never synced.
    expect(screen.queryByTestId('catalogue-freshness-time')).not.toBeInTheDocument();
  });

  it('an unparseable timestamp renders verbatim instead of throwing', async () => {
    const bridge = freshnessBridge({
      freshness: () =>
        Promise.resolve({ kind: 'ok', last_success_at: 'not-a-date', is_empty: false }),
    });
    render(<CatalogueFreshness bridge={bridge} />);

    const time = await screen.findByTestId('catalogue-freshness-time');
    expect(time).toHaveTextContent('not-a-date');
  });

  it('updated (non-null + is_empty false) → "last updated" + ABSOLUTE timestamp', async () => {
    const bridge = freshnessBridge({
      freshness: () =>
        Promise.resolve({
          kind: 'ok',
          last_success_at: '2026-06-07T10:42:00.000Z',
          is_empty: false,
        }),
    });
    render(<CatalogueFreshness bridge={bridge} />);

    await waitFor(() =>
      expect(screen.getByTestId('catalogue-freshness')).toHaveAttribute('data-state', 'updated'),
    );
    expect(screen.getByText(/آخر تحديث/)).toBeInTheDocument();
    // An absolute timestamp is rendered (a <time> element carrying the ISO value).
    const time = screen.getByTestId('catalogue-freshness-time');
    expect(time).toHaveAttribute('dateTime', '2026-06-07T10:42:00.000Z');
    // It must NOT render relative wording (no ticking clock in this slice).
    expect(screen.queryByText(/منذ/)).not.toBeInTheDocument();
  });

  it('synced-but-empty (non-null + is_empty true) → "updated, no products" (SC-10 truthfulness)', async () => {
    const bridge = freshnessBridge({
      freshness: () =>
        Promise.resolve({
          kind: 'ok',
          last_success_at: '2026-06-07T10:42:00.000Z',
          is_empty: true,
        }),
    });
    render(<CatalogueFreshness bridge={bridge} />);

    await waitFor(() =>
      expect(screen.getByTestId('catalogue-freshness')).toHaveAttribute(
        'data-state',
        'synced-empty',
      ),
    );
    // Distinct, truthful copy — never a bare timestamp implying data exists.
    expect(screen.getByText(/لا توجد منتجات/)).toBeInTheDocument();
    expect(screen.getByTestId('catalogue-freshness-time')).toBeInTheDocument();
  });

  it('a malformed/undefined bridge response degrades to unavailable, never crashes', async () => {
    // Defensive at the trust boundary: if the bridge ever returns a non-conforming
    // value, the indicator must not white-screen — it shows the unavailable state.
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve(undefined as unknown as CatalogueFreshnessResponse),
    });
    render(<CatalogueFreshness bridge={bridge} />);
    await waitFor(() =>
      expect(screen.getByTestId('catalogue-freshness')).toHaveAttribute(
        'data-state',
        'unavailable',
      ),
    );
  });

  it('refused → a generic unavailable state, no crash, no leaked reason', async () => {
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve({ kind: 'refused', reason: 'tenant_isolation' }),
    });
    render(<CatalogueFreshness bridge={bridge} />);
    await waitFor(() =>
      expect(screen.getByTestId('catalogue-freshness')).toHaveAttribute(
        'data-state',
        'unavailable',
      ),
    );
    // The refusal reason is never echoed to the cashier.
    expect(screen.queryByText(/tenant_isolation/)).not.toBeInTheDocument();
  });
});

describe('T045 — CatalogueFreshness: manual refresh affordance', () => {
  it('clicking refresh calls the bridge and reports started honestly', async () => {
    const refresh = vi.fn(() => Promise.resolve<CatalogueRefreshResponse>({ kind: 'started' }));
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      refresh,
    });
    render(<CatalogueFreshness bridge={bridge} />);

    const button = await screen.findByRole('button', { name: /تحديث/ });
    await userEvent.click(button);

    expect(refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText(/جارٍ التحديث/)).toBeInTheDocument());
  });

  it('reports already_running honestly (single-flight) without claiming completion', async () => {
    const refresh = vi.fn(() =>
      Promise.resolve<CatalogueRefreshResponse>({ kind: 'already_running' }),
    );
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      refresh,
    });
    render(<CatalogueFreshness bridge={bridge} />);

    const button = await screen.findByRole('button', { name: /تحديث/ });
    await userEvent.click(button);

    // Honest: a tick is already running; it does NOT claim "done".
    await waitFor(() => expect(screen.getByText(/جارٍ التحديث بالفعل/)).toBeInTheDocument());
    expect(screen.queryByText(/اكتمل|تم التحديث بنجاح/)).not.toBeInTheDocument();
  });

  it('the refresh button meets the 44px touch-target floor', async () => {
    const bridge = freshnessBridge({
      freshness: () => Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
    });
    render(<CatalogueFreshness bridge={bridge} />);
    const button = await screen.findByRole('button', { name: /تحديث/ });
    // The shared `btn` base enforces 44px; assert the class contract is present.
    expect(button.className).toMatch(/btn/);
  });
});

describe('T039 (#360) — post-commit freshness re-read (ONE-SHOT, no poll)', () => {
  // The driver admits a tick SYNCHRONOUSLY (`started`) and commits the promote
  // LATER on its own `completed` promise — which the bridge deliberately drops
  // (WR-2/P9-2). So the immediate `loadFreshness()` after `started` reads the
  // PRE-commit timestamp. The owner shape brief scoped OUT a polling clock, so
  // the fix is ONE bounded deferred re-read (not a repeating poll): it catches
  // the committed timestamp in the common fast case and otherwise decays to the
  // honest in-flight feedback + the next natural read. Cancelled on unmount.

  // fireEvent (synchronous) is used instead of userEvent here: userEvent's
  // internal awaits couple badly with vi.useFakeTimers() and hang. The click
  // handler is exercised the same way; we then flush its async with
  // act + advanceTimersByTimeAsync.

  /** Flush pending microtasks (the awaited bridge promises) under fake timers. */
  async function flushMicrotasks(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('schedules exactly ONE deferred re-read after a started tick (catches the LATER-committed timestamp)', async () => {
    vi.useFakeTimers();
    try {
      // Model the driver's real async timing: the promote commits AFTER admission,
      // so the IMMEDIATE post-click read still sees the PRE-commit stamp and only
      // the DEFERRED read sees the committed one. `commitAfter` reads commit only
      // once two `freshness` calls have already happened (mount + immediate).
      let reads = 0;
      const freshness = vi.fn(() => {
        reads += 1;
        const committed = reads > 2; // mount(1) + immediate(2) are pre-commit
        return Promise.resolve<CatalogueFreshnessResponse>({
          kind: 'ok',
          last_success_at: committed ? '2026-06-15T12:00:05.000Z' : '2026-06-15T12:00:00.000Z',
          is_empty: false,
        });
      });
      const refresh = vi.fn(() => Promise.resolve<CatalogueRefreshResponse>({ kind: 'started' }));
      const bridge = freshnessBridge({ freshness, refresh });
      render(<CatalogueFreshness bridge={bridge} />);

      // Drain the mount read.
      await flushMicrotasks();
      const mountReads = freshness.mock.calls.length;

      const button = screen.getByRole('button', { name: /تحديث/ });
      fireEvent.click(button);
      // refresh() + the immediate (pre-commit) re-read resolve on microtasks.
      await flushMicrotasks();

      // After the click: refresh() + the immediate (pre-commit) re-read have run,
      // but the ONE deferred re-read has NOT fired yet. The displayed stamp is
      // still the PRE-commit value (proves the immediate read alone is insufficient).
      expect(refresh).toHaveBeenCalledOnce();
      const afterClickReads = freshness.mock.calls.length;
      expect(afterClickReads).toBe(mountReads + 1); // immediate re-read only
      expect(screen.getByTestId('catalogue-freshness-time')).toHaveAttribute(
        'dateTime',
        '2026-06-15T12:00:00.000Z',
      );

      // Advance past the bounded delay → exactly ONE more freshness() read fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(freshness.mock.calls.length).toBe(afterClickReads + 1);

      // And it must NOT keep firing (one-shot, not a poll).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(freshness.mock.calls.length).toBe(afterClickReads + 1);

      // The LATER-committed timestamp is now displayed — only the deferred read
      // could have surfaced it (the immediate read saw the old stamp above).
      expect(screen.getByTestId('catalogue-freshness-time')).toHaveAttribute(
        'dateTime',
        '2026-06-15T12:00:05.000Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the in-flight feedback when the deferred re-read sees the timestamp ADVANCE (no fresh-stamp + "updating now" contradiction)', async () => {
    vi.useFakeTimers();
    try {
      // The promote commits before the deferred read: it advances the timestamp.
      let reads = 0;
      const freshness = vi.fn(() => {
        reads += 1;
        const committed = reads > 2;
        return Promise.resolve<CatalogueFreshnessResponse>({
          kind: 'ok',
          last_success_at: committed ? '2026-06-15T12:00:05.000Z' : '2026-06-15T12:00:00.000Z',
          is_empty: false,
        });
      });
      const refresh = vi.fn(() => Promise.resolve<CatalogueRefreshResponse>({ kind: 'started' }));
      const bridge = freshnessBridge({ freshness, refresh });
      render(<CatalogueFreshness bridge={bridge} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
      await flushMicrotasks();
      // Right after admission the in-flight feedback shows (honest: tick admitted).
      expect(screen.getByText(/جارٍ التحديث…/)).toBeInTheDocument();

      // The deferred re-read fires, sees the ADVANCED stamp → the update DID land,
      // so "updating now…" is now a lie and must be cleared (no contradiction).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByTestId('catalogue-freshness-time')).toHaveAttribute(
        'dateTime',
        '2026-06-15T12:00:05.000Z',
      );
      expect(screen.queryByText(/جارٍ التحديث…/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('KEEPS the in-flight feedback when the deferred re-read sees the timestamp UNCHANGED (slow promote — still honest)', async () => {
    vi.useFakeTimers();
    try {
      // The promote is still running at the deferred read: timestamp unchanged.
      // The in-flight "updating now…" feedback is still TRUE, so it must persist.
      const freshness = vi.fn(() =>
        Promise.resolve<CatalogueFreshnessResponse>({
          kind: 'ok',
          last_success_at: '2026-06-15T12:00:00.000Z',
          is_empty: false,
        }),
      );
      const refresh = vi.fn(() => Promise.resolve<CatalogueRefreshResponse>({ kind: 'started' }));
      const bridge = freshnessBridge({ freshness, refresh });
      render(<CatalogueFreshness bridge={bridge} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
      await flushMicrotasks();
      expect(screen.getByText(/جارٍ التحديث…/)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      // Stamp unchanged → the promote hasn't landed → in-flight feedback stays.
      expect(screen.getByText(/جارٍ التحديث…/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT schedule a deferred re-read when the tick was already_running', async () => {
    vi.useFakeTimers();
    try {
      const freshness = vi.fn(() =>
        Promise.resolve<CatalogueFreshnessResponse>({
          kind: 'ok',
          last_success_at: '2026-06-15T12:00:00.000Z',
          is_empty: false,
        }),
      );
      const refresh = vi.fn(() =>
        Promise.resolve<CatalogueRefreshResponse>({ kind: 'already_running' }),
      );
      const bridge = freshnessBridge({ freshness, refresh });
      render(<CatalogueFreshness bridge={bridge} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
      await flushMicrotasks();
      const afterClickReads = freshness.mock.calls.length;

      // No deferred re-read for already_running (this terminal didn't start the tick).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(freshness.mock.calls.length).toBe(afterClickReads);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the deferred re-read on unmount (no setState after unmount)', async () => {
    vi.useFakeTimers();
    try {
      const freshness = vi.fn(() =>
        Promise.resolve<CatalogueFreshnessResponse>({
          kind: 'ok',
          last_success_at: '2026-06-15T12:00:00.000Z',
          is_empty: false,
        }),
      );
      const refresh = vi.fn(() => Promise.resolve<CatalogueRefreshResponse>({ kind: 'started' }));
      const bridge = freshnessBridge({ freshness, refresh });
      const { unmount } = render(<CatalogueFreshness bridge={bridge} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
      await flushMicrotasks();
      const afterClickReads = freshness.mock.calls.length;

      // Unmount BEFORE the deferred re-read fires → it must be cancelled.
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(freshness.mock.calls.length).toBe(afterClickReads);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T045 — CatalogueFreshness: accessibility', () => {
  it('announces politely via role=status and does not steal focus', async () => {
    const bridge = freshnessBridge({
      freshness: () =>
        Promise.resolve({
          kind: 'ok',
          last_success_at: '2026-06-07T10:42:00.000Z',
          is_empty: false,
        }),
    });
    render(<CatalogueFreshness bridge={bridge} />);
    const region = await screen.findByTestId('catalogue-freshness');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('is axe-clean in the updated state', async () => {
    const bridge = freshnessBridge({
      freshness: () =>
        Promise.resolve({
          kind: 'ok',
          last_success_at: '2026-06-07T10:42:00.000Z',
          is_empty: false,
        }),
    });
    const { container } = render(<CatalogueFreshness bridge={bridge} />);
    await screen.findByTestId('catalogue-freshness-time');
    await expectNoAxeViolations(container);
  });
});
