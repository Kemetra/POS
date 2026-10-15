import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useViewportTier, viewportShortfall, type Viewport } from '../useViewportTier';
import { installViewport, resizeTo } from '../../v5/__tests__/__helpers__/viewport-bands';

/**
 * T025 — useViewportTier boundary tests. RT-313 adds the height band
 * (RT-312 D1: 768 full reference, 600–767 compact-height, under 600 blocked)
 * on the same 100ms debounce.
 */

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useViewportTier width tier (T025)', () => {
  it.each([
    [1023, 'too-small'],
    [1024, 'icon-only'],
    [1279, 'icon-only'],
    [1280, 'expanded'],
    [1920, 'expanded'],
  ] as const)('%ipx → "%s"', (width, tier) => {
    installViewport(width, 800);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toEqual({ tier, height: 'full' });
  });
});

describe('useViewportTier height band (RT-313)', () => {
  it.each([
    [599, 'too-short'],
    [600, 'compact-height'],
    [767, 'compact-height'],
    [768, 'full'],
    [983, 'full'],
  ] as const)('%ipx high → "%s"', (height, band) => {
    installViewport(1280, height);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current).toEqual({ tier: 'expanded', height: band });
  });
});

describe('viewportShortfall (RT-313)', () => {
  it.each([
    [1023, 800, 'width'],
    [1280, 599, 'height'],
    [1023, 599, 'both'],
    [1024, 600, null],
    [1024, 767, null],
    [1280, 768, null],
  ] as const)('%i×%i → %s', (width, height, shortfall) => {
    installViewport(width, height);
    const { result } = renderHook(() => useViewportTier());
    expect(viewportShortfall(result.current)).toBe(shortfall);
  });
});

describe('useViewportTier transitions', () => {
  it('debounces a width change by 100ms', () => {
    installViewport(1023, 800);
    const { result } = renderHook(() => useViewportTier());
    expect(result.current.tier).toBe('too-small');

    resizeTo(1024);
    advance(99);
    expect(result.current.tier).toBe('too-small');
    advance(2);
    expect(result.current.tier).toBe('icon-only');

    resizeTo(1280);
    advance(101);
    expect(result.current.tier).toBe('expanded');
  });

  it('debounces a height change by the same 100ms', () => {
    installViewport(1280, 800);
    const { result } = renderHook(() => useViewportTier());

    resizeTo(1280, 599);
    advance(99);
    expect(result.current.height).toBe('full');
    advance(2);
    expect(result.current.height).toBe('too-short');

    resizeTo(1280, 600);
    advance(101);
    expect(result.current.height).toBe('compact-height');
  });

  it('one resize across a width and a height boundary settles in ONE transition', () => {
    installViewport(1280, 800);
    const seen: Viewport[] = [];
    renderHook(() => {
      const viewport = useViewportTier();
      seen.push(viewport);
      return viewport;
    });

    resizeTo(1023, 599);
    advance(101);
    const distinct = seen.filter((v, i) => i === 0 || v !== seen[i - 1]);
    expect(distinct).toEqual([
      { tier: 'expanded', height: 'full' },
      { tier: 'too-small', height: 'too-short' },
    ]);
  });

  it('a width crossing then a height crossing inside the debounce is one transition', () => {
    installViewport(1280, 800);
    const seen: Viewport[] = [];
    renderHook(() => {
      const viewport = useViewportTier();
      seen.push(viewport);
      return viewport;
    });

    resizeTo(1023, 800);
    advance(50);
    resizeTo(1023, 599);
    advance(99);
    expect(seen[seen.length - 1]).toEqual({ tier: 'expanded', height: 'full' });
    advance(2);
    const distinct = seen.filter((v, i) => i === 0 || v !== seen[i - 1]);
    expect(distinct).toHaveLength(2);
    expect(distinct[1]).toEqual({ tier: 'too-small', height: 'too-short' });
  });

  it('crossing and coming back inside the debounce keeps the same viewport object', () => {
    installViewport(1280, 800);
    const { result } = renderHook(() => useViewportTier());
    const before = result.current;

    resizeTo(1280, 599);
    resizeTo(1280, 800);
    advance(101);
    expect(result.current).toBe(before);
  });
});

describe('useViewportTier cleanup', () => {
  function stubWithSpies(): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(() => added.push(query)),
        removeEventListener: vi.fn(() => removed.push(query)),
        dispatchEvent: vi.fn(),
      })),
    );
    return { added, removed };
  }

  it('listens to all four queries and removes every listener on unmount', () => {
    const { added, removed } = stubWithSpies();
    const { unmount } = renderHook(() => useViewportTier());
    expect([...added].sort()).toEqual([
      '(min-height: 600px)',
      '(min-height: 768px)',
      '(min-width: 1024px)',
      '(min-width: 1280px)',
    ]);
    unmount();
    expect([...removed].sort()).toEqual([...added].sort());
  });

  it('clears a pending debounce timer on unmount', () => {
    installViewport(1280, 800);
    const { result, unmount } = renderHook(() => useViewportTier());

    resizeTo(1023, 599);
    resizeTo(1280, 599);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    advance(200);
    // The timer was cleared on unmount, so the viewport never updated.
    expect(result.current).toEqual({ tier: 'expanded', height: 'full' });
  });
});
