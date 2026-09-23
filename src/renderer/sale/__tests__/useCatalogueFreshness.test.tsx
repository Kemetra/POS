import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { useCatalogueFreshness } from '../useCatalogueFreshness';

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
});
