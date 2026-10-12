import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { NavRail } from '../NavRail';
import { shellNavEntries } from '../../../../../specs/003-pos-ui-shell/contracts/shell-routes';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../stores/operator-session-store';
import type { Role } from '../../../../shared/operator/role';

afterEach(cleanup);

/** Pre-populate the operator-session store as a signed-in operator of `role`. */
function signInAs(role: Role): void {
  const session: OperatorSessionView = {
    id: `sess-${role}`,
    operator_id: `op-${role}`,
    display_name: `${role} user`,
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-06-21T09:00:00.000Z',
  };
  useOperatorSessionStore.getState().beginSignIn();
  useOperatorSessionStore.getState().resolveSignedIn(session);
}

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

beforeEach(() => {
  mockMatchMedia(1920);
  // PR #434 FIX 2 — the rail is now role-filtered. The base-case tests below
  // assert all 7 entries, so they run as a manager (manager/admin see all 7).
  // The cashier-specific filtering is asserted in the dedicated block at the
  // bottom of this file.
  useOperatorSessionStore.getState().reset();
  signInAs('manager');
});

afterEach(() => {
  vi.unstubAllGlobals();
  useOperatorSessionStore.getState().reset();
});

/**
 * T036 — NavRail: 7 entries (POS v3.5), Arabic-first visible labels +
 * stable English accessible names, active state, no hamburger.
 *
 * POS v3.5 Slice 1: the rail renders the Arabic `label` as visible text and
 * uses the English `labelEn` as the link's accessible name (in BOTH expanded
 * and icon-only modes) so screen-reader and test queries stay language-stable
 * while the operator sees Arabic-first copy.
 */
describe('NavRail (T036)', () => {
  it('renders exactly 7 nav entries', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(7);
  });

  it('each entry renders its Arabic label as visible text (expanded mode)', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    for (const entry of shellNavEntries) {
      expect(screen.getByText(entry.label)).toBeInTheDocument();
    }
  });

  it('each entry exposes its English name as the link accessible name (expanded mode)', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    for (const entry of shellNavEntries) {
      expect(screen.getByRole('link', { name: entry.labelEn })).toBeInTheDocument();
    }
  });

  it('includes the new POS v3.5 returns + audit entries with Arabic labels', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getByText('المرتجعات')).toBeInTheDocument();
    expect(screen.getByText('سجل المراجعة')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Returns' })).toHaveAttribute('href', '/app/returns');
    expect(screen.getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/app/audit');
  });

  it('nav has aria-label="Primary"', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('no data-testid="hamburger" rendered at expanded width', () => {
    const { container } = render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="hamburger"]')).not.toBeInTheDocument();
  });

  it('icon-only mode: English name stays the link accessible name (at 1024–1279px)', () => {
    mockMatchMedia(1024);
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    for (const entry of shellNavEntries) {
      const link = screen.getByRole('link', { name: entry.labelEn });
      expect(link).toHaveAttribute('aria-label', entry.labelEn);
    }
  });

  it('returns null at < 1024px (too-small)', () => {
    mockMatchMedia(1023);
    const { container } = render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    expect(container.querySelector('nav')).not.toBeInTheDocument();
  });

  it('no data-testid="hamburger" at < 1024px', () => {
    mockMatchMedia(1023);
    const { container } = render(
      <MemoryRouter>
        <NavRail />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="hamburger"]')).not.toBeInTheDocument();
  });
});

/**
 * PR #434 FIX 2 — role-filtered NavRail.
 *
 * `shellNavEntries` carries an optional `allow` field; `returns` and `audit`
 * are gated to manager/admin (mirrors router FIX 1). The rail reads the current
 * operator role and renders only entries the role may reach:
 *   - cashier  → 5 entries (no Returns, no Audit)
 *   - manager  → all 7
 *   - admin    → all 7
 * Entries without `allow` are visible to everyone.
 */
describe('NavRail — role-filtered entries (PR #434 FIX 2)', () => {
  it('cashier sees 5 entries — no Returns, no Audit', () => {
    useOperatorSessionStore.getState().reset();
    signInAs('cashier');
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByRole('link', { name: 'Returns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
    // The 5 cashier-visible entries are present.
    for (const name of ['Dashboard', 'Sale', 'Sales', 'Inventory', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('manager sees all 7 entries — including Returns + Audit', () => {
    useOperatorSessionStore.getState().reset();
    signInAs('manager');
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(screen.getByRole('link', { name: 'Returns' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  });

  it('admin sees all 7 entries — including Returns + Audit', () => {
    useOperatorSessionStore.getState().reset();
    signInAs('admin');
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <NavRail />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(7);
    expect(screen.getByRole('link', { name: 'Returns' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit' })).toBeInTheDocument();
  });
});
