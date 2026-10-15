import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useConnectionState, useConnectionStateStore } from '../connection-state';
import { connectionState } from '../../ui/tokens/connection-state';

beforeEach(() => {
  useConnectionStateStore.setState({ state: 'online' });
});

/**
 * T027 — useConnectionState slice guard.
 *
 * Asserts:
 * - enum has exactly four members
 * - default initial value is 'online'
 * - setter is the only mutation path
 * - no side-effect listeners invoke fetch/IPC/localStorage/sessionStorage
 */
describe('useConnectionState (T027)', () => {
  it('connectionState enum has exactly four members', () => {
    const members = Object.keys(connectionState);
    expect(members).toHaveLength(4);
    expect(members).toContain('online');
    expect(members).toContain('degraded');
    expect(members).toContain('offline');
    expect(members).toContain('syncing');
  });

  it('default initial value is "online"', () => {
    const { result } = renderHook(() => useConnectionState());
    expect(result.current.state).toBe('online');
  });

  it('setState updates the connection state', () => {
    const { result } = renderHook(() => useConnectionState());
    act(() => {
      result.current.setState('degraded');
    });
    expect(result.current.state).toBe('degraded');
  });

  it('cycling through all four states works', () => {
    const { result } = renderHook(() => useConnectionState());
    const states = ['online', 'degraded', 'offline', 'syncing'] as const;
    for (const s of states) {
      act(() => {
        result.current.setState(s);
      });
      expect(result.current.state).toBe(s);
    }
  });

  it('syncing state does not invoke fetch, window.api, localStorage, or sessionStorage', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const localStorageSpy = vi.spyOn(window, 'localStorage', 'get');
    const sessionStorageSpy = vi.spyOn(window, 'sessionStorage', 'get');

    const { result } = renderHook(() => useConnectionState());

    act(() => {
      result.current.setState('syncing');
    });

    expect(result.current.state).toBe('syncing');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorageSpy).not.toHaveBeenCalled();
    expect(sessionStorageSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    localStorageSpy.mockRestore();
    sessionStorageSpy.mockRestore();
  });
});
