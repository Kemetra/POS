import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { StuckShiftBadge } from '../StuckShiftBadge.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../stores/operator-session-store.js';

/**
 * T080 — navigation count badge for stuck-shift list.
 *
 * Visibility per T079 / role-visibility-matrix.md §Section 3:
 *   cashier → MUST NOT render
 *   manager → renders
 *   admin   → renders
 *   icon-only viewport (1024–1279 px) → MUST NOT render (badge hidden)
 *   count = 0 → badge hidden (no "0" badge clutter)
 *
 * S4 ships with placeholder count = 0; live count wired in S5.
 */

const MANAGER_SESSION: OperatorSessionView = {
  id: 'sess-mgr',
  operator_id: 'op-mgr',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-11T00:00:00.000Z',
};

function stubViewport(expanded: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches:
        query.includes('min-height') ||
        (expanded
          ? query.includes('min-width: 1280px') || query.includes('min-width: 1024px')
          : query.includes('min-width: 1024px') && !query.includes('min-width: 1280px')),
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

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
  vi.unstubAllGlobals();
});

function renderBadge(count = 0) {
  return render(
    <MemoryRouter>
      <StuckShiftBadge count={count} />
    </MemoryRouter>,
  );
}

describe('StuckShiftBadge (T080)', () => {
  it('is hidden when no operator session (signed out)', () => {
    stubViewport(true);
    renderBadge(2);
    expect(screen.queryByTestId('stuck-shift-badge')).not.toBeInTheDocument();
  });

  it('is hidden for cashier role', () => {
    stubViewport(true);
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'cashier' });
    renderBadge(2);
    expect(screen.queryByTestId('stuck-shift-badge')).not.toBeInTheDocument();
  });

  it('is visible for manager role at expanded viewport', () => {
    stubViewport(true);
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'manager' });
    renderBadge(2);
    expect(screen.getByTestId('stuck-shift-badge')).toBeInTheDocument();
  });

  it('is visible for admin role at expanded viewport', () => {
    stubViewport(true);
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'admin' });
    renderBadge(2);
    expect(screen.getByTestId('stuck-shift-badge')).toBeInTheDocument();
  });

  it('is hidden at icon-only viewport (1024–1279 px)', () => {
    // icon-only: 1024px matches but not 1280px
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches:
          query.includes('min-height') ||
          (query.includes('min-width: 1024px') && !query.includes('min-width: 1280px')),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'manager' });
    renderBadge(3);
    expect(screen.queryByTestId('stuck-shift-badge')).not.toBeInTheDocument();
  });

  it('is hidden when count is 0 (placeholder S4 state)', () => {
    stubViewport(true);
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'manager' });
    renderBadge(0);
    expect(screen.queryByTestId('stuck-shift-badge')).not.toBeInTheDocument();
  });

  it('shows count when greater than 0', () => {
    stubViewport(true);
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({ ...MANAGER_SESSION, role: 'manager' });
    renderBadge(3);
    expect(screen.getByTestId('stuck-shift-badge')).toHaveTextContent('3');
  });
});
