import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { useTheme } from '../useTheme';
import { THEME_STORAGE_KEY, initTheme, useThemeStore } from '../../stores/theme-store';

/**
 * POS v3.5 Phase 1 — the `useTheme` hook (ADR-0004).
 *
 * RT-504: the legacy `ThemeToggle` button is retired with the AppShell, but the
 * theme store and this hook are kept. These cases carry over what the toggle's
 * test proved about them: a flip changes the store, repaints the document root
 * and persists, and a second flip round-trips. (Store defaults and persistence
 * are proved in `theme-contract.test.ts` and `theme-store.test.ts`.)
 */

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  initTheme(); // reset to the persisted default (light) before each case
});

describe('useTheme', () => {
  it('reports the light default at rest', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(result.current.isDark).toBe(false);
  });

  it('toggleTheme flips light → dark: store, root attribute and persistence', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.toggleTheme();
    });
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('a second toggle flips dark → light again (round-trip)', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.toggleTheme();
    });
    act(() => {
      result.current.toggleTheme();
    });
    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setTheme switches to an explicit theme', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('dark');
    });
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
