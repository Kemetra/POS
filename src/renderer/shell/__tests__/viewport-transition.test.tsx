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
 * `useViewportTier` debounces tier changes by 100 ms AND clears the pending
 * timer on every `change` event, so a continuous drag resets it indefinitely.
 * For the whole drag the outlet keeps rendering while the media query already
 * matches — exactly the window those rules cover.
 *
 * This is the only BEHAVIOURAL guard on that window; `u2-sale-layout-rules`
 * asserts source text and cannot see a time-varying transition. Nothing else in
 * the suite exercises a resize, which is why the deletion passed 5617 tests.
 *
 * If this test fails because the shell now switches synchronously, the rules
 * genuinely become steady-state-only and #450's conclusion can be revisited —
 * deliberately, with this test as the record of what changed.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

/** Listeners registered by `useViewportTier`, fired to simulate a resize. */
const listeners: Array<() => void> = [];
let viewportIsWide = true;

function installControllableMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      get matches() {
        return viewportIsWide;
      },
      media: query,
      onchange: null,
      addEventListener: (_event: string, cb: () => void) => {
        listeners.push(cb);
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function shellHasOutletContent(): boolean {
  // NavRail renders only on the non-too-small path, alongside the <Outlet />.
  return screen.getByTestId('app-shell').querySelector('.nav-rail') !== null;
}

afterEach(() => {
  cleanup();
  listeners.length = 0;
  viewportIsWide = true;
  vi.useRealTimers();
});

describe('#451 — viewport tier transition keeps the outlet mounted while narrow', () => {
  it('still renders the outlet during a continuous resize below 1024px', async () => {
    vi.useFakeTimers();
    installControllableMatchMedia();
    const { AppShell } = await import('../AppShell');

    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <AppShell />
      </MemoryRouter>,
    );
    expect(shellHasOutletContent()).toBe(true);

    // Drag below 1024px: the media queries stop matching and fire `change`.
    act(() => {
      viewportIsWide = false;
      listeners.forEach((cb) => {
        cb();
      });
    });

    // The tier has NOT switched yet — the debounce is pending, so the cart is
    // still mounted at a width where the narrow rule already applies.
    expect(shellHasOutletContent()).toBe(true);

    // A continuous drag keeps firing `change` inside the 100 ms window, and
    // `useViewportTier` clears the pending timer each time. The window is
    // therefore NOT bounded at 100 ms — it lasts as long as the drag.
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(80);
        listeners.forEach((cb) => {
          cb();
        });
      }
    });
    expect(shellHasOutletContent()).toBe(true);

    // Only once the drag stops and the debounce finally elapses does the shell
    // swap in ScreenTooSmall.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(shellHasOutletContent()).toBe(false);
  });
});
