import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config';
import { DrawerNoticeBanner, DrawerNoticeInline } from '../DrawerNotice';
import { useDrawerNoticeStore } from '../drawer-notice-store';

/**
 * RT-241 — the D-B1 drawer notice: the status-area banner and the inline line
 * inside cash completion. It replaces the persistent cross-session
 * DrawerFailureBanner (N-08) and carries its lasting guarantees:
 *
 * - Arabic only, the M-C4 message and the M-C5 last-opened time;
 * - the manual-receipt recovery stays wired (enabled ⟹ wired);
 * - FR-053: no retry-kick / "open the drawer" action — a re-kick has no audit
 *   anchor (UNIQUE(sale_id) on drawer_events);
 * - one live region: the inline line does not announce a second time.
 */

const NOW = '2026-10-08T10:00:00.000Z';

function showFailure(sale_id = 'sale-7', last: string | null = '2026-10-08T09:58:00.000Z'): void {
  const store = useDrawerNoticeStore.getState();
  store.observe(null); // this session's first known projection: clean
  store.observe({ sale_id, last_successful_open_at: last });
}

beforeEach(() => {
  useDrawerNoticeStore.getState().reset();
});

afterEach(cleanup);

describe('DrawerNoticeBanner (status area)', () => {
  it('renders nothing while no notice is active', () => {
    const { container } = render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says M-C4 and the M-C5 last-opened time, in Arabic only', () => {
    showFailure();
    render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    const banner = screen.getByTestId('drawer-notice');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('لم يُفتح درج النقود. افتحه يدويًا.');
    expect(banner).toHaveTextContent('آخر فتح:');
    expect(banner.textContent).not.toMatch(/[A-Za-z]/);
  });

  it('keeps the manual-receipt recovery wired to the failed sale', async () => {
    showFailure('sale-9');
    const onManualOverride = vi.fn();
    render(<DrawerNoticeBanner now={NOW} onManualOverride={onManualOverride} />);
    await userEvent.click(screen.getByRole('button', { name: 'إيصال يدوي' }));
    expect(onManualOverride).toHaveBeenCalledWith('sale-9');
  });

  it('«تم» acknowledges: the notice leaves', async () => {
    showFailure();
    render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'تم' }));
    expect(screen.queryByTestId('drawer-notice')).not.toBeInTheDocument();
  });

  it('offers no retry-kick or open-drawer action (FR-053)', () => {
    showFailure();
    render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    const names = within(screen.getByTestId('drawer-notice'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['إيصال يدوي', 'تم']);
  });

  it('announces politely and whole, and never steals focus on mount (T332)', () => {
    showFailure();
    render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    const banner = screen.getByTestId('drawer-notice');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByRole('button', { name: 'إيصال يدوي' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'تم' })).not.toHaveFocus();
  });

  it('has no axe violations', async () => {
    showFailure();
    const { container } = render(<DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />);
    await expectNoAxeViolations(container);
  });
});

describe('DrawerNoticeInline (inside cash completion)', () => {
  it('renders nothing while no notice is active', () => {
    const { container } = render(<DrawerNoticeInline />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows M-C4 without a second live region (the banner announces it)', () => {
    showFailure();
    render(<DrawerNoticeInline />);
    const inline = screen.getByTestId('drawer-notice-inline');
    expect(inline).toHaveTextContent('لم يُفتح درج النقود. افتحه يدويًا.');
    expect(inline).not.toHaveAttribute('role');
    expect(inline).not.toHaveAttribute('aria-live');
  });

  it('acknowledging in either place clears both', async () => {
    showFailure();
    render(
      <>
        <DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />
        <DrawerNoticeInline />
      </>,
    );
    await userEvent.click(
      within(screen.getByTestId('drawer-notice-inline')).getByRole('button', { name: 'تم' }),
    );
    expect(screen.queryByTestId('drawer-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-notice-inline')).not.toBeInTheDocument();
  });
});
