import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { SalesWorkspace } from '../SalesWorkspace';
import { CartWorkspace } from '../CartWorkspace';
import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * T037 — Placeholder pane tests: default state; no fetch/IPC/persistence.
 */
describe('SalesWorkspace (T037)', () => {
  it('renders default state', () => {
    render(
      <MemoryRouter>
        <SalesWorkspace />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /sales/i })).toBeInTheDocument();
  });

  it('zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <SalesWorkspace />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CartWorkspace (T037)', () => {
  it('renders default state', () => {
    render(
      <MemoryRouter>
        <CartWorkspace />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /cart/i })).toBeInTheDocument();
  });

  it('zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <CartWorkspace />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('InventoryPlaceholder (T037)', () => {
  it('shows "navigation only" message', () => {
    render(
      <MemoryRouter>
        <InventoryPlaceholder />
      </MemoryRouter>,
    );
    expect(screen.getByText(/navigation only/i)).toBeInTheDocument();
  });

  it('zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <InventoryPlaceholder />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SettingsHelpPlaceholder (T037)', () => {
  it('renders default state without density toggle', () => {
    render(
      <MemoryRouter>
        <SettingsHelpPlaceholder />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
    // Clarifications §1: no density toggle
    expect(screen.queryByRole('checkbox', { name: /density/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /density/i })).not.toBeInTheDocument();
  });

  it('zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <SettingsHelpPlaceholder />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
