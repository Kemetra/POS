import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';

/**
 * T042 — Cross-product state-variant tests (US3).
 *
 * Tests the panes that still carry the dev `?state=` gallery × 4 variants.
 * RT-499 (D-10-4): the dashboard is the manager home and no longer has the gallery.
 * Each combination asserts the correct primitive renders (LoadingState /
 * EmptyState / ErrorState) or default content.
 *
 * Checkout pane is covered in US6 (T049–T052) — it is not yet implemented.
 *
 * Each variant test also asserts zero fetch / window.api / localStorage
 * calls on mount.
 */

// ------- helpers -------

// Uses a plain object override — sufficient for URLSearchParams reads in happy-dom.
function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    value: { href: '', pathname: '/', search, hash: '', host: '', hostname: '', origin: '' },
    writable: true,
    configurable: true,
  });
}

// Dynamic imports so each test can set window.location.search before the
// component's module resolves the DEV toggle (module is already loaded after
// first import, but we rely on the hook reading window.location at call time).
async function importPanes() {
  const [{ SalesWorkspace }, { InventoryPlaceholder }, { SettingsHelpPlaceholder }] =
    await Promise.all([
      import('../SalesWorkspace'),
      import('../InventoryPlaceholder'),
      import('../SettingsHelpPlaceholder'),
    ]);
  return {
    SalesWorkspace,
    InventoryPlaceholder,
    SettingsHelpPlaceholder,
  };
}

type Pane = Awaited<ReturnType<typeof importPanes>>;
type PaneName = keyof Pane;

const PANE_NAMES: PaneName[] = [
  'SalesWorkspace',
  'InventoryPlaceholder',
  'SettingsHelpPlaceholder',
];

// RT-500 (S10-3) and RT-503 (S10-6): Sales, Inventory and Settings left the dev
// `?state=` gallery with its English loading / empty / error variants, so only
// their default state is crossed.

function renderPane(Component: React.ComponentType) {
  return render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

// ------- side-effect spies -------

function setupSideEffectSpies() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const localStorageSpy = vi.spyOn(window, 'localStorage', 'get');
  const sessionStorageSpy = vi.spyOn(window, 'sessionStorage', 'get');
  return { fetchMock, localStorageSpy, sessionStorageSpy };
}

function assertNoSideEffects({
  fetchMock,
  localStorageSpy,
  sessionStorageSpy,
}: ReturnType<typeof setupSideEffectSpies>) {
  expect(fetchMock, 'fetch must not be called on mount').not.toHaveBeenCalled();
  expect(localStorageSpy, 'localStorage must not be accessed on mount').not.toHaveBeenCalled();
  expect(sessionStorageSpy, 'sessionStorage must not be accessed on mount').not.toHaveBeenCalled();
}

// ------- tests -------

describe('US3 state-variant cross-product — default state (T042)', () => {
  beforeEach(() => {
    setSearch('');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(PANE_NAMES)('%s — default state renders heading', async (paneName) => {
    const panes = await importPanes();
    const Component = panes[paneName];
    const spies = setupSideEffectSpies();
    const { container } = renderPane(Component);

    // Each pane must have at least a heading in its default state
    const headings = screen.getAllByRole('heading');
    expect(headings.length).toBeGreaterThan(0);

    assertNoSideEffects(spies);
    await expectNoAxeViolations(container);
  });
});
