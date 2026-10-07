/**
 * T330 — `<DrawerFailureBanner>` persistence + affordance + relative timestamp (RED).
 *
 * Mounts whenever the latest drawer_events row for a recently-finalized sale is
 * outcome='failed'. Non-modal, does NOT auto-dismiss, carries the relative
 * `last_successful_open_at` timestamp («آخر فتح: منذ ساعتين», RT-240) via the
 * shared `formatRelativeTime` formatter, and offers ONLY a manual-override
 * affordance (≥ 44×44). Visually distinct from the printer-failure banner
 * (NFR-008 — different icon + class so a cashier never confuses them).
 *
 * Red-bar recorded in coordination.md before the T360 /impeccable craft.
 *
 * The component accepts an injected `drawerFailure` (the projected drawer-banner
 * state; production receives it via `useDrawerBannerState` → sales.subscribe
 * banner_state .drawer_failure slice) + a required `onManualOverride`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { DrawerFailureBanner } from '../../../../src/renderer/ui/receipts/DrawerFailureBanner.js';

const NOW = '2026-05-29T12:00:00.000Z';
const FAILURE = {
  sale_id: 'sale-1',
  last_successful_open_at: '2026-05-29T10:00:00.000Z', // 2 hours before NOW
};

afterEach(() => {
  cleanup();
});

describe('T330 — DrawerFailureBanner mounts on drawer failure', () => {
  it('renders the Arabic drawer-failed message when a drawer failure is present', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByText('لم يفتح درج النقود')).toBeInTheDocument();
  });

  it('renders nothing when there is no drawer failure (unmounted, not hidden)', () => {
    const { container } = render(
      <DrawerFailureBanner drawerFailure={null} onManualOverride={() => {}} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the relative last_successful_open_at timestamp («منذ ساعتين»)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByText('منذ ساعتين')).toBeInTheDocument();
  });

  it('handles a null last_successful_open_at without crashing (no prior open on record)', () => {
    render(
      <DrawerFailureBanner
        drawerFailure={{ sale_id: 'sale-1', last_successful_open_at: null }}
        onManualOverride={() => {}}
        now={NOW}
      />,
    );
    // Still mounts the banner; the timestamp area degrades to «غير معروف»
    // rather than throwing.
    expect(screen.getByText('لم يفتح درج النقود')).toBeInTheDocument();
    expect(screen.getByText('غير معروف')).toBeInTheDocument();
  });

  it('exposes a Manual receipt affordance ≥ 44×44, wired to onManualOverride', async () => {
    const onManualOverride = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(
      <DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={onManualOverride} now={NOW} />,
    );
    const btn = screen.getByRole('button', { name: 'إيصال يدوي' });
    expect(btn.className).toMatch(/btn--md/);
    await userEvent.click(btn);
    expect(onManualOverride).toHaveBeenCalledWith('sale-1');
  });

  it('has no close-X (cannot be dismissed without resolving the condition)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.queryByRole('button', { name: /close|dismiss|إغلاق/i })).toBeNull();
  });

  it('is visually distinct from the printer-failure banner (own class + drawer testid)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByTestId('drawer-failure-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('printer-failure-banner')).toBeNull();
  });
});
