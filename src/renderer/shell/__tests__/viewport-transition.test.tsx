/**
 * #451 — the narrow-terminal media rules ARE reachable, during the transition.
 *
 * WHY THIS EXISTS: an audit (#450) classified the `@media (max-width: 1023px)`
 * rules on `.sale-layout` and `.tender-method-grid` as dead, reasoning that
 * below 1024px `AppShell` renders `ScreenTooSmall` instead of its `<Outlet />`,
 * so those surfaces never mount where the query matches. At STEADY STATE that
 * is true. It is also incomplete, and deleting the rules on that basis was
 * caught in review.
 *
 * `useViewportTier` debounces tier changes by 100 ms, so crossing below 1024px
 * leaves the outlet mounted while the media query ALREADY matches. CSS applies
 * the moment the viewport crosses the boundary; React re-renders a debounce
 * later. Those rules cover that gap.
 *
 * SCOPE OF THE CLAIM — deliberately bounded. An earlier version of this test
 * re-invoked the listeners every 80 ms to simulate a drag, and concluded the
 * window was unbounded. That was a harness artifact: a real `MediaQueryList`
 * emits `change` only when its match STATUS flips, not continuously while the
 * pointer moves. Crossing the boundary once fires once, and the tier settles
 * ~100 ms later. This test therefore models only genuine boundary crossings —
 * each `setWidthBand` call flips real match state before dispatching.
 *
 * The window is ~100 ms per crossing, not indefinite. That is still a real
 * window (and repeated crossings re-open it), which is why the rules stay.
 *
 * This is the only BEHAVIOURAL guard on that window; `u2-sale-layout-rules`
 * asserts source text and cannot see a time-varying transition. Nothing else in
 * the suite exercises a resize, which is why the deletion passed 5617 tests.
 *
 * If this fails because the shell now switches synchronously, the rules become
 * steady-state-only and #450's conclusion can be revisited — deliberately, with
 * this test as the record of what changed.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

const EXPANDED_QUERY = '(min-width: 1280px)';
const ICON_ONLY_QUERY = '(min-width: 1024px)';

type Band = 'expanded' | 'icon-only' | 'too-small';

/** Real match semantics: each query tracks its own state independently. */
function matchesFor(band: Band, query: string): boolean {
  if (query === EXPANDED_QUERY) return band === 'expanded';
  if (query === ICON_ONLY_QUERY) return band === 'expanded' || band === 'icon-only';
  return false;
}

let band: Band = 'expanded';
const registry = new Map<string, Array<() => void>>();

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      get matches() {
        return matchesFor(band, query);
      },
      media: query,
      onchange: null,
      addEventListener: (_event: string, cb: () => void) => {
        const list = registry.get(query) ?? [];
        list.push(cb);
        registry.set(query, list);
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

/**
 * Move to a new width band and dispatch `change` ONLY to the queries whose
 * match status actually flipped — what a real MediaQueryList does.
 */
function setWidthBand(next: Band): void {
  const before = [EXPANDED_QUERY, ICON_ONLY_QUERY].map((q) => matchesFor(band, q));
  band = next;
  [EXPANDED_QUERY, ICON_ONLY_QUERY].forEach((q, i) => {
    if (matchesFor(band, q) !== before[i]) {
      (registry.get(q) ?? []).forEach((cb) => {
        cb();
      });
    }
  });
}

function outletIsMounted(): boolean {
  // NavRail renders only on the non-too-small path, alongside the <Outlet />.
  return screen.getByTestId('app-shell').querySelector('.nav-rail') !== null;
}

afterEach(() => {
  cleanup();
  registry.clear();
  band = 'expanded';
  vi.useRealTimers();
});

describe('#451 — the debounced tier transition keeps the outlet mounted while narrow', () => {
  it('leaves the outlet mounted after crossing below 1024px, until the debounce elapses', async () => {
    vi.useFakeTimers();
    installMatchMedia();
    const { AppShell } = await import('../AppShell');

    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <AppShell />
      </MemoryRouter>,
    );
    expect(outletIsMounted()).toBe(true);

    // One genuine boundary crossing: expanded -> too-small. Both queries flip.
    act(() => {
      setWidthBand('too-small');
    });

    // THE GAP. The viewport is already below 1024px, so `max-width: 1023px`
    // applies now — but the tier has not switched, so the cart is still
    // mounted. Without the narrow rules it renders two-column here.
    expect(outletIsMounted()).toBe(true);

    // Still inside the debounce.
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(outletIsMounted()).toBe(true);

    // Debounce elapses: the shell swaps in ScreenTooSmall.
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(outletIsMounted()).toBe(false);
  });

  it('re-opens the window on each crossing back below the breakpoint', async () => {
    vi.useFakeTimers();
    installMatchMedia();
    const { AppShell } = await import('../AppShell');

    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <AppShell />
      </MemoryRouter>,
    );

    // Down, settle, back up, settle.
    act(() => {
      setWidthBand('too-small');
      vi.advanceTimersByTime(150);
    });
    expect(outletIsMounted()).toBe(false);

    act(() => {
      setWidthBand('icon-only');
      vi.advanceTimersByTime(150);
    });
    expect(outletIsMounted()).toBe(true);

    // Down again — the gap re-opens, so this is not a one-off at startup.
    act(() => {
      setWidthBand('too-small');
    });
    expect(outletIsMounted()).toBe(true);
  });
});
