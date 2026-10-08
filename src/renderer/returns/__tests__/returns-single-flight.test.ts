import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useSingleFlight } from '../returns-bridge.js';

/**
 * RT-15 S3 — D1/D2/U3 core: a second run in the same frame (before React has
 * re-rendered a disabled control) is dropped, and the guard frees afterwards.
 */
describe('useSingleFlight', () => {
  it('drops a re-entrant run while one is in flight, then accepts the next', async () => {
    const { result } = renderHook(() => useSingleFlight<'submit'>());
    let release: () => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const second = vi.fn(() => Promise.resolve());
    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.run('submit', first);
      void result.current.run('submit', second);
    });
    expect(result.current.busy).toBe('submit');
    await act(async () => {
      release();
      await running;
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(result.current.busy).toBeNull();
    await act(() => result.current.run('submit', second));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
