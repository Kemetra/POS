/**
 * T047 [S3] — AppShell + region layout assertions (TEST-FIRST).
 *
 * happy-dom does not compute CSS layout — getBoundingClientRect returns
 * zeros, computed styles don't resolve. We therefore assert BEM classes
 * and data-attributes that map 1:1 to CSS rules in tailwind.css:
 *
 *   .top-bar        → block-size: 64px  (T049 / plan S3 definition of done)
 *   .nav-rail       → inline-size: 248px (≥1280px) / 84px (icon-only)
 *   .app-shell__content → flex: 1 (workspace fills remaining space)
 *   no [data-connection-state]: the connection pill is gone (RT-240, I-7)
 *
 * This file covers T047's layout-assertion requirement. Per-region
 * interaction/variant tests live in the per-region test files (T057).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppShell } from '../AppShell';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function mockMatchMedia(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('min-width: 1280px')
        ? width >= 1280
        : query.includes('min-width: 1024px')
          ? width >= 1024
          : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  mockMatchMedia(1920);
});

function renderShell(path = '/app/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/*" element={<AppShell />}>
          <Route path="dashboard" element={<div data-testid="outlet">Dashboard</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppShell layout — T047 (BEM class assertions)', () => {
  // Top bar: .top-bar carries block-size: 64px in CSS
  it('top bar carries .top-bar class (maps to block-size: 64px in CSS)', () => {
    const { container } = renderShell();
    expect(container.querySelector('.top-bar')).toBeInTheDocument();
  });

  // NavRail: at >=1280px carries .nav-rail with inline-size:248px rule
  it('nav rail carries .nav-rail class (maps to inline-size: 248px at >=1280px)', () => {
    const { container } = renderShell();
    expect(container.querySelector('.nav-rail')).toBeInTheDocument();
  });

  // NavRail icon-only: at 1024–1279px the label is clipped (CSS rule), rail is 84px
  it('nav rail carries .nav-rail class at icon-only viewport (maps to inline-size: 84px)', () => {
    mockMatchMedia(1024);
    const { container } = renderShell();
    expect(container.querySelector('.nav-rail')).toBeInTheDocument();
  });

  // NavRail hidden below 1024px — component returns null, no .nav-rail in DOM
  it('nav rail is NOT in DOM below 1024px (too-small tier)', () => {
    mockMatchMedia(1023);
    const { container } = renderShell();
    // NavRail returns null at too-small; AppShell shows ScreenTooSmall
    expect(container.querySelector('.nav-rail')).not.toBeInTheDocument();
  });

  // ScreenTooSmall fallback present at <1024px
  it('ScreenTooSmall is shown below 1024px', () => {
    mockMatchMedia(1023);
    renderShell();
    expect(screen.getByRole('heading', { level: 1, name: 'Screen too small' })).toBeInTheDocument();
  });

  // Workspace fills remaining space: .app-shell__content has flex:1 in CSS
  it('workspace content area carries .app-shell__content class (maps to flex:1 in CSS)', () => {
    const { container } = renderShell();
    expect(container.querySelector('.app-shell__content')).toBeInTheDocument();
  });

  // RT-240 (I-7): the shell shows no connection pill. Nothing measures the
  // connection, so a green «Online» would claim an unproven state.
  it('renders no connection pill', () => {
    const { container } = renderShell();
    expect(container.querySelector('[data-connection-state]')).toBeNull();
    expect(screen.queryByText('Online')).toBeNull();
  });
});
