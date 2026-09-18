import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { DashboardPlaceholder } from '../DashboardPlaceholder';
import { SalesWorkspace } from '../SalesWorkspace';
import { CartWorkspace } from '../CartWorkspace';
import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';
import { CheckoutPlaceholder } from '../checkout/CheckoutPlaceholder';

afterEach(cleanup);

/**
 * T070a — Workspace smoke tests.
 *
 * Each placeholder is rendered in isolation and asserted to contain exactly
 * one Workspace ancestor (data-testid="workspace"). Layout-primitive
 * consumption only — no business logic, no AppShell needed.
 */

function renderInRouter(Component: React.ComponentType): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

describe('Workspace smoke tests (T070a)', () => {
  it('DashboardPlaceholder renders inside a Workspace', () => {
    renderInRouter(DashboardPlaceholder);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('SalesWorkspace renders inside a Workspace', () => {
    renderInRouter(SalesWorkspace);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('CartWorkspace renders inside a Workspace', () => {
    renderInRouter(CartWorkspace);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('InventoryPlaceholder renders inside a Workspace', () => {
    renderInRouter(InventoryPlaceholder);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('SettingsHelpPlaceholder renders inside a Workspace', () => {
    renderInRouter(SettingsHelpPlaceholder);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('CheckoutPlaceholder renders inside a Workspace', () => {
    renderInRouter(CheckoutPlaceholder);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
  });

  it('each placeholder contains exactly one Workspace', () => {
    const components = [
      DashboardPlaceholder,
      SalesWorkspace,
      CartWorkspace,
      InventoryPlaceholder,
      SettingsHelpPlaceholder,
      CheckoutPlaceholder,
    ] as const;
    for (const Component of components) {
      const { container, unmount } = render(
        <MemoryRouter>
          <Component />
        </MemoryRouter>,
      );
      expect(container.querySelectorAll('[data-testid="workspace"]')).toHaveLength(1);
      unmount();
    }
  });
});
