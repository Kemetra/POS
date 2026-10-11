import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { RosterList, type RosterEntry } from '../RosterList.js';

/**
 * 004-operator-session T030 / T075 — RosterList component tests.
 *
 * Verifies:
 *   - Inert state renders empty-state message.
 *   - Empty cashiers array renders inert state.
 *   - Active state renders all cashier entries.
 *   - With onSelect: cashier buttons are rendered and call onSelect on click.
 *   - Without onSelect: spans are rendered (no button).
 *   - selectedId: matching cashier gets aria-selected + CSS class.
 *   - selectedId: non-matching cashier does NOT get selected class.
 */

const CASHIERS: RosterEntry[] = [
  { id: 'c1', display_name: 'Alice Smith', role: 'cashier' },
  { id: 'c2', display_name: 'Bob Jones', role: 'cashier' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('RosterList — inert state', () => {
  it('renders inert when inert prop is true', () => {
    render(<RosterList cashiers={CASHIERS} inert={true} />);
    expect(screen.getByTestId('roster-list')).toHaveAttribute('data-state', 'inert');
  });

  it('renders inert when cashiers array is empty', () => {
    render(<RosterList cashiers={[]} />);
    expect(screen.getByTestId('roster-list')).toHaveAttribute('data-state', 'inert');
  });

  // RT-244: the sign-in route owns the truthful roster state (offline, refused
  // or empty); the list itself renders no message, and never the old English one.
  it('renders no message and no tiles when inert', () => {
    render(<RosterList cashiers={[]} />);
    const list = screen.getByTestId('roster-list');
    expect(list.textContent).toBe('');
    expect(screen.queryByText(/Cashier sign-in is not yet available/i)).not.toBeInTheDocument();
  });
});

describe('RosterList — active state', () => {
  it('renders data-state active when cashiers are provided', () => {
    render(<RosterList cashiers={CASHIERS} />);
    expect(screen.getByTestId('roster-list')).toHaveAttribute('data-state', 'active');
  });

  it('renders one item per cashier', () => {
    render(<RosterList cashiers={CASHIERS} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });
});

describe('RosterList — with onSelect', () => {
  it('renders a button for each cashier', () => {
    render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} />);
    expect(screen.getByTestId('roster-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('roster-item-1')).toBeInTheDocument();
  });

  it('clicking a cashier button calls onSelect with that cashier', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RosterList cashiers={CASHIERS} onSelect={onSelect} />);
    await user.click(screen.getByTestId('roster-item-0'));
    expect(onSelect).toHaveBeenCalledWith(CASHIERS[0]);
  });

  it('clicking a second cashier calls onSelect with the correct entry', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RosterList cashiers={CASHIERS} onSelect={onSelect} />);
    await user.click(screen.getByTestId('roster-item-1'));
    expect(onSelect).toHaveBeenCalledWith(CASHIERS[1]);
  });
});

describe('RosterList — without onSelect', () => {
  it('does not render buttons when onSelect is omitted', () => {
    render(<RosterList cashiers={CASHIERS} />);
    expect(screen.queryByTestId('roster-item-0')).not.toBeInTheDocument();
  });

  it('still renders cashier names as text', () => {
    render(<RosterList cashiers={CASHIERS} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });
});

describe('RosterList — selectedId', () => {
  it('selected cashier button has aria-pressed=true', () => {
    render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} selectedId="c1" />);
    expect(screen.getByTestId('roster-item-0')).toHaveAttribute('aria-pressed', 'true');
  });

  it('non-selected cashier button has aria-pressed=false', () => {
    render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} selectedId="c1" />);
    expect(screen.getByTestId('roster-item-1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('selected cashier li is marked data-selected', () => {
    render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} selectedId="c2" />);
    const item = screen.getByTestId('roster-item-1').closest('li');
    expect(item).toHaveAttribute('data-selected', 'true');
  });

  it('unselected cashier li is NOT marked data-selected', () => {
    render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} selectedId="c2" />);
    const item = screen.getByTestId('roster-item-0').closest('li');
    expect(item).not.toHaveAttribute('data-selected');
  });
});

describe('RosterList — minimum disclosure (F-1)', () => {
  it('does not render Clerk-style cashier IDs in any DOM attribute or text', () => {
    const clerkId = 'user_2abcDEF123xyz';
    const cashier: RosterEntry = { id: clerkId, display_name: 'Carol Test', role: 'cashier' };
    const { container } = render(<RosterList cashiers={[cashier]} onSelect={vi.fn()} />);
    expect(container.outerHTML).not.toContain(clerkId);
  });

  it('uses index-based test IDs, not cashier IDs', () => {
    const { container } = render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} />);
    expect(container.outerHTML).not.toContain('c1');
    expect(container.outerHTML).not.toContain('c2');
    expect(screen.getByTestId('roster-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('roster-item-1')).toBeInTheDocument();
  });

  it('does not emit data-cashier-id on any element', () => {
    const { container } = render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} />);
    expect(container.outerHTML).not.toContain('data-cashier-id');
  });
});

describe('RosterList — RT-244 G-1 tiles', () => {
  const ARABIC = [{ id: 'a1', display_name: 'منى عبد الرحمن', role: 'cashier' as const }];

  it('badges a tile with the first letter of the name, not two letters', () => {
    render(<RosterList cashiers={ARABIC} onSelect={vi.fn()} />);
    const badge = screen.getByTestId('roster-item-0').querySelector('.v5-entry__badge');
    expect(badge?.textContent).toBe('م');
  });

  it('names each tile button by the full cashier name, with no English role label', () => {
    render(<RosterList cashiers={ARABIC} onSelect={vi.fn()} />);
    const tile = screen.getByRole('button', { name: 'منى عبد الرحمن' });
    expect(tile).toBe(screen.getByTestId('roster-item-0'));
    expect(tile.textContent).not.toMatch(/Cashier/i);
  });

  it('names the roster list in Arabic', () => {
    render(<RosterList cashiers={ARABIC} onSelect={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'قائمة الكاشير' })).toBeInTheDocument();
  });
});
