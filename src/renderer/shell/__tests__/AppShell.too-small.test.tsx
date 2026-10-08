import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppShell } from '../AppShell';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  // <1024px — all media queries return false (too-small viewport)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      // happy-dom has no real MediaQueryList constructor; cast is required in tests.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
});

function renderTooSmall() {
  return render(
    <MemoryRouter initialEntries={['/app/dashboard']}>
      <Routes>
        <Route path="/app/*" element={<AppShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * T047 — AppShell at <1024px: shows ScreenTooSmall; no nav in DOM.
 */
describe('AppShell too-small (T047)', () => {
  it('renders ScreenTooSmall heading at <1024px', () => {
    renderTooSmall();
    expect(
      screen.getByRole('heading', { level: 1, name: /^الشاشة أصغر من 1024×768\s?\.$/ }),
    ).toBeInTheDocument();
  });

  it('renders the M-F2 Arabic guidance', () => {
    renderTooSmall();
    expect(screen.getByText('كبّر النافذة أو استخدم شاشة أكبر.')).toBeInTheDocument();
  });

  it('no <nav> in DOM at <1024px', () => {
    const { container } = renderTooSmall();
    expect(container.querySelector('nav')).not.toBeInTheDocument();
  });

  it('no off-screen or aria-hidden nav at <1024px', () => {
    const { container } = renderTooSmall();
    expect(container.querySelector('[aria-hidden="true"] nav')).not.toBeInTheDocument();
    expect(container.querySelector('nav[aria-hidden]')).not.toBeInTheDocument();
  });
});
