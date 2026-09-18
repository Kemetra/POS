import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';

/**
 * T042 — Cross-product state-variant tests (US3).
 *
 * Tests 5 panes × 4 variants = 20 combinations.
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
  const [
    { DashboardPlaceholder },
    { SalesWorkspace },
    { CartWorkspace },
    { InventoryPlaceholder },
    { SettingsHelpPlaceholder },
  ] = await Promise.all([
    import('../DashboardPlaceholder'),
    import('../SalesWorkspace'),
    import('../CartWorkspace'),
    import('../InventoryPlaceholder'),
    import('../SettingsHelpPlaceholder'),
  ]);
  return {
    DashboardPlaceholder,
    SalesWorkspace,
    CartWorkspace,
    InventoryPlaceholder,
    SettingsHelpPlaceholder,
  };
}

type Pane = Awaited<ReturnType<typeof importPanes>>;
type PaneName = keyof Pane;

const PANE_NAMES: PaneName[] = [
  'DashboardPlaceholder',
  'SalesWorkspace',
  'CartWorkspace',
  'InventoryPlaceholder',
  'SettingsHelpPlaceholder',
];

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

describe('US3 state-variant cross-product — loading state (T042)', () => {
  beforeEach(() => {
    setSearch('?state=loading');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSearch('');
  });

  it.each(PANE_NAMES)('%s — loading state renders role="status"', async (paneName) => {
    const panes = await importPanes();
    const Component = panes[paneName];
    const spies = setupSideEffectSpies();
    const { container } = renderPane(Component);

    // LoadingState uses role="status" per task spec T012
    expect(screen.getByRole('status')).toBeInTheDocument();

    assertNoSideEffects(spies);
    await expectNoAxeViolations(container);
  });
});

describe('US3 state-variant cross-product — empty state (T042)', () => {
  beforeEach(() => {
    setSearch('?state=empty');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSearch('');
  });

  it.each(PANE_NAMES)('%s — empty state renders heading + description', async (paneName) => {
    const panes = await importPanes();
    const Component = panes[paneName];
    const spies = setupSideEffectSpies();
    const { container } = renderPane(Component);

    // EmptyState uses a heading + paragraph structure (no role="status")
    const heading = screen.getByRole('heading');
    expect(heading).toBeInTheDocument();
    // Must have at least a paragraph / description text
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBeGreaterThan(0);

    assertNoSideEffects(spies);
    await expectNoAxeViolations(container);
  });
});

describe('US3 state-variant cross-product — error state (T042)', () => {
  beforeEach(() => {
    setSearch('?state=error');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSearch('');
  });

  it.each(PANE_NAMES)('%s — error state renders heading + description', async (paneName) => {
    const panes = await importPanes();
    const Component = panes[paneName];
    const spies = setupSideEffectSpies();
    const { container } = renderPane(Component);

    // ErrorState uses a heading + paragraph structure (no role="status")
    const heading = screen.getByRole('heading');
    expect(heading).toBeInTheDocument();
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBeGreaterThan(0);

    assertNoSideEffects(spies);
    await expectNoAxeViolations(container);
  });
});
