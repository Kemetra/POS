import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { DashboardRoute } from '../DashboardRoute';
import { SalesWorkspace } from '../SalesWorkspace';
import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';
import { CheckoutPlaceholder } from '../checkout/CheckoutPlaceholder';

beforeEach(() => {
  // RT-499: the dashboard route is the manager home, so it needs a signed-in manager.
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'sess-mgr',
    operator_id: 'op-mgr',
    display_name: 'سارة عبد الحميد',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-15T07:00:00.000Z',
  });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
});

/**
 * T070a — Screen wrapper smoke tests.
 *
 * Each placeholder is rendered in isolation and asserted to contain exactly
 * one screen wrapper. Layout-primitive consumption only — no business logic,
 * no frame needed.
 *
 * RT-498 (VN-S10 S10-1): the screens that moved into the one v5 frame now wrap
 * their content in `ScreenSection` (data-testid="v5-screen-section") instead of
 * the legacy `Workspace` (data-testid="workspace"). CheckoutPlaceholder still
 * uses the legacy `Workspace`; S10-6 moves it.
 */

function renderInRouter(Component: React.ComponentType): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

describe('Screen wrapper smoke tests (T070a, RT-498)', () => {
  it('DashboardRoute renders inside a ScreenSection', () => {
    renderInRouter(DashboardRoute);
    expect(screen.getByTestId('v5-screen-section')).toBeInTheDocument();
  });

  it('SalesWorkspace renders inside a ScreenSection', () => {
    renderInRouter(SalesWorkspace);
    expect(screen.getByTestId('v5-screen-section')).toBeInTheDocument();
  });

  it('InventoryPlaceholder renders inside a ScreenSection', () => {
    renderInRouter(InventoryPlaceholder);
    expect(screen.getByTestId('v5-screen-section')).toBeInTheDocument();
  });

  it('SettingsHelpPlaceholder renders inside a ScreenSection', () => {
    renderInRouter(SettingsHelpPlaceholder);
    expect(screen.getByTestId('v5-screen-section')).toBeInTheDocument();
  });

  // S10-6 moves CheckoutPlaceholder to ScreenSection; until then it keeps the legacy Workspace.
  it('CheckoutPlaceholder renders inside a Workspace', () => {
    renderInRouter(CheckoutPlaceholder);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('each placeholder contains exactly one screen wrapper', () => {
    const sectionScreens = [
      DashboardRoute,
      SalesWorkspace,
      InventoryPlaceholder,
      SettingsHelpPlaceholder,
    ] as const;
    for (const Component of sectionScreens) {
      const { container, unmount } = render(
        <MemoryRouter>
          <Component />
        </MemoryRouter>,
      );
      expect(container.querySelectorAll('[data-testid="v5-screen-section"]')).toHaveLength(1);
      unmount();
    }

    // CheckoutPlaceholder is still on the legacy Workspace (S10-6 moves it).
    const { container, unmount } = render(
      <MemoryRouter>
        <CheckoutPlaceholder />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('[data-testid="workspace"]')).toHaveLength(1);
    unmount();
  });
});
