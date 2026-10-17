import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { DrawerNoticeBanner, DrawerNoticeInline, useDrawerNoticeFeed } from '../DrawerNotice';
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

/**
 * RT-531 (the cash drawer is optional): the notice is fed only by the main
 * process's banner projection. A cash sale on a terminal with NO drawer is a
 * suppressed drawer event, which main never projects as a drawer failure, so
 * neither the status-area notice nor the inline line ever appears. A configured
 * drawer that fails is still projected, and still shows.
 */
describe('RT-531: no notice without a drawer', () => {
  type Projection = { sale_id: string; last_successful_open_at: string | null } | null;

  function Harness(): ReactElement {
    useDrawerNoticeFeed();
    return (
      <>
        <DrawerNoticeBanner now={NOW} onManualOverride={vi.fn()} />
        <DrawerNoticeInline />
      </>
    );
  }

  function stubSales(projections: Projection[]): void {
    let i = 0;
    const subscribe = vi.fn(() => {
      const drawer_failure = projections[Math.min(i, projections.length - 1)] ?? null;
      i += 1;
      return Promise.resolve({
        kind: 'ok',
        banner_state: { printer_failure: null, drawer_failure },
      });
    });
    vi.stubGlobal('api', { sales: { subscribe } });
  }

  async function polls(times: number): Promise<void> {
    for (let n = 0; n < times; n += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a cash sale with no drawer (projection stays clean) never shows a notice', async () => {
    stubSales([null, null, null, null]);
    render(<Harness />);
    await polls(3);
    expect(screen.queryByTestId('drawer-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-notice-inline')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إيصال يدوي' })).not.toBeInTheDocument();
  });

  it('a configured drawer that fails is still projected: both notices show', async () => {
    stubSales([null, { sale_id: 'sale-cfg', last_successful_open_at: '2026-10-08T09:58:00.000Z' }]);
    render(<Harness />);
    await polls(2);
    expect(screen.getByTestId('drawer-notice')).toHaveTextContent(
      'لم يُفتح درج النقود. افتحه يدويًا.',
    );
    expect(screen.getByTestId('drawer-notice-inline')).toBeInTheDocument();
    // The manual receipt (إيصال يدوي) stays wired for the failed sale.
    expect(screen.getByRole('button', { name: 'إيصال يدوي' })).toBeInTheDocument();
  });
});
