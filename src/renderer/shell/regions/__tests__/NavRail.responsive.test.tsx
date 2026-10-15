import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { NavRail } from '../NavRail';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function mockMatchMedia(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      // happy-dom has no real MediaQueryList constructor; cast is required in tests.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return {
        matches: query.includes('min-width: 1280px')
          ? width >= 1280
          : query.includes('min-width: 1024px')
            ? width >= 1024
            : query.includes('min-height'),
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
}

/**
 * T046 — NavRail responsive matrix.
 */
describe('NavRail responsive (T046)', () => {
  it('≥1280px: shows Arabic label text + English accessible name (expanded)', () => {
    mockMatchMedia(1280);
    render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    // POS v3.5: Arabic is the visible label; English is the accessible name.
    expect(screen.getByText('لوحة المتابعة')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('1024–1279px: aria-label on links (icon-only)', () => {
    mockMatchMedia(1024);
    render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-label',
      'Dashboard',
    );
  });

  it.each([
    {
      name: '<1024px: navigation is NOT in DOM (too-small)',
      width: 1023,
      selector: 'nav',
    },
    {
      name: 'no data-testid="hamburger" at ≥1280px',
      width: 1920,
      selector: '[data-testid="hamburger"]',
    },
    {
      name: 'no data-testid="hamburger" at 1024–1279px',
      width: 1200,
      selector: '[data-testid="hamburger"]',
    },
    {
      name: 'no data-testid="hamburger" at <1024px',
      width: 800,
      selector: '[data-testid="hamburger"]',
    },
  ])('$name', ({ width, selector }) => {
    mockMatchMedia(width);
    const { container } = render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    expect(container.querySelector(selector)).not.toBeInTheDocument();
  });
});
