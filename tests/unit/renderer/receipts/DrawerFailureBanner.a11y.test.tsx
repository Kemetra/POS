/**
 * T332 — `<DrawerFailureBanner>` accessibility (RED).
 *
 * Keyboard-operable, screen-reader landmark (role="status" aria-live="polite"
 * aria-atomic), manual-override button ≥ 44×44 (P14), and axe-clean. Per the
 * §A1 brief keyboard contract — focus does NOT auto-shift to the banner on
 * mount (the cashier may be mid-cart-entry; stealing focus is hostile). Same
 * posture as the printer-failure banner.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { DrawerFailureBanner } from '../../../../src/renderer/ui/receipts/DrawerFailureBanner.js';
import { expectNoAxeViolations } from '../../../../src/renderer/ui/primitives/__tests__/axe-config.js';

const NOW = '2026-05-29T12:00:00.000Z';
const FAILURE = {
  sale_id: 'sale-1',
  last_successful_open_at: '2026-05-29T10:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('T332 — DrawerFailureBanner accessibility', () => {
  it('exposes a polite status landmark (role=status, aria-live=polite, aria-atomic)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  it('does NOT steal focus on mount (manual-override button is not focused)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByRole('button', { name: 'إيصال يدوي' })).not.toHaveFocus();
  });

  it('the manual-override affordance carries the 44×44 size modifier (P14)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByRole('button', { name: 'إيصال يدوي' }).className).toMatch(/btn--md/);
  });

  it('is not a color-only signal — the icon + text label carry meaning (FR-068)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.getByText('لم يفتح درج النقود')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(
      <DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />,
    );
    await expectNoAxeViolations(container);
  });
});
