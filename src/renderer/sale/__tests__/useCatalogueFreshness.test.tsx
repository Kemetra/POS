import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { useCatalogueFreshness } from '../useCatalogueFreshness';

const REREAD_DELAY_MS = 3_000;

function makeBridge(freshness: ReturnType<typeof vi.fn>, refresh = vi.fn()): CatalogueBridgeAPI {
  return { freshness, refresh } as unknown as CatalogueBridgeAPI;
}

const stamped = (at: string) => ({ kind: 'ok', last_success_at: at, is_empty: false });

afterEach(() => {
  vi.useRealTimers();
});

describe('useCatalogueFreshness', () => {
  it('reports synced-empty separately and never claims refresh completed', async () => {
    const freshness = vi.fn().mockResolvedValue({
      kind: 'ok',
      last_success_at: '2026-09-20T12:00:00Z',
      is_empty: true,
    });
    const refresh = vi.fn().mockResolvedValue({ kind: 'started' });
    const bridge = { freshness, refresh } as unknown as CatalogueBridgeAPI;
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await waitFor(() => {
      expect(result.current.state).toBe('synced-empty');
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.feedback).toBe('started');
    expect(freshness).toHaveBeenCalledTimes(2);
  });

  // Ported from the retired legacy CatalogueFreshness suite (023 Slice H):
  // the state mapping and deferred re-read now live only in this hook.
  it.each([
    [{ kind: 'ok', last_success_at: null, is_empty: true }, 'never-synced', null],
    [stamped('2026-09-20T12:00:00Z'), 'updated', '2026-09-20T12:00:00Z'],
    [{ kind: 'refused', reason: 'no_session' }, 'unavailable', null],
    [undefined, 'unavailable', null],
  ])('maps %o to %s', async (response, expected, stamp) => {
    const bridge = makeBridge(vi.fn().mockResolvedValue(response));
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await waitFor(() => {
      expect(result.current.state).toBe(expected);
    });
    expect(result.current.lastSuccessAt).toBe(stamp);
  });

  it('a rejected read degrades to unavailable', async () => {
    const bridge = makeBridge(vi.fn().mockRejectedValue(new Error('ipc')));
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await waitFor(() => {
      expect(result.current.state).toBe('unavailable');
    });
  });

  it('reports already_running honestly and schedules no deferred re-read', async () => {
    vi.useFakeTimers();
    const freshness = vi.fn().mockResolvedValue(stamped('2026-09-20T12:00:00Z'));
    const refresh = vi.fn().mockResolvedValue({ kind: 'already_running' });
    const bridge = makeBridge(freshness, refresh);
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await act(async () => {}); // let the mount read land before refresh
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.feedback).toBe('already-running');
    const reads = freshness.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REREAD_DELAY_MS * 2);
    });
    expect(freshness).toHaveBeenCalledTimes(reads);
  });

  it('a refused refresh shows no in-flight feedback', async () => {
    const freshness = vi.fn().mockResolvedValue(stamped('2026-09-20T12:00:00Z'));
    const refresh = vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' });
    const bridge = makeBridge(freshness, refresh);
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.feedback).toBe('idle');
    expect(result.current.refreshing).toBe(false);
  });

  it('after started, re-reads exactly once and clears feedback when the stamp advances', async () => {
    vi.useFakeTimers();
    const freshness = vi
      .fn()
      .mockResolvedValueOnce(stamped('2026-09-20T12:00:00Z'))
      .mockResolvedValueOnce(stamped('2026-09-20T12:00:00Z'))
      .mockResolvedValue(stamped('2026-09-20T13:00:00Z'));
    const refresh = vi.fn().mockResolvedValue({ kind: 'started' });
    const bridge = makeBridge(freshness, refresh);
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await act(async () => {}); // let the mount read land before refresh
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.feedback).toBe('started');
    expect(freshness).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REREAD_DELAY_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(3);
    expect(result.current.lastSuccessAt).toBe('2026-09-20T13:00:00Z');
    expect(result.current.feedback).toBe('idle');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REREAD_DELAY_MS * 3);
    });
    expect(freshness).toHaveBeenCalledTimes(3);
  });

  it('keeps the in-flight feedback when the deferred re-read sees no newer stamp', async () => {
    vi.useFakeTimers();
    const freshness = vi.fn().mockResolvedValue(stamped('2026-09-20T12:00:00Z'));
    const refresh = vi.fn().mockResolvedValue({ kind: 'started' });
    const bridge = makeBridge(freshness, refresh);
    const { result } = renderHook(() => useCatalogueFreshness(bridge));
    await act(async () => {}); // let the mount read land before refresh
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REREAD_DELAY_MS);
    });
    expect(freshness).toHaveBeenCalledTimes(3);
    expect(result.current.feedback).toBe('started');
  });

  it('cancels the deferred re-read on unmount', async () => {
    vi.useFakeTimers();
    const freshness = vi.fn().mockResolvedValue(stamped('2026-09-20T12:00:00Z'));
    const refresh = vi.fn().mockResolvedValue({ kind: 'started' });
    const bridge = makeBridge(freshness, refresh);
    const { result, unmount } = renderHook(() => useCatalogueFreshness(bridge));
    await act(async () => {}); // let the mount read land before refresh
    await act(async () => {
      await result.current.refresh();
    });
    const reads = freshness.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(REREAD_DELAY_MS * 2);
    expect(freshness).toHaveBeenCalledTimes(reads);
  });
});
