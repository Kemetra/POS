/**
 * T331 — `<DrawerFailureBanner>` offers NO retry-kick affordance (RED).
 *
 * Per quickstart §Path D: a retry-kick would either violate FR-053 (the
 * UNIQUE(sale_id) constraint rejects a second drawer_events row) or have no
 * audit anchor for the second attempt. So the drawer-failure banner offers ONLY
 * the manual-override path — unlike the printer-failure banner, which has a live
 * Retry. This test locks that contract so the /impeccable craft can't smuggle a
 * "retry" button onto a failure surface by habit.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { DrawerFailureBanner } from '../../../../src/renderer/ui/receipts/DrawerFailureBanner.js';

const NOW = '2026-05-29T12:00:00.000Z';
const FAILURE = {
  sale_id: 'sale-1',
  last_successful_open_at: '2026-05-29T10:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('T331 — DrawerFailureBanner has no retry-kick affordance', () => {
  it('offers NO retry / retry-kick / re-open button', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.queryByRole('button', { name: /إعادة المحاولة|إعادة فتح|جرّب/ })).toBeNull();
  });

  it('offers NO reprint button (reprint is a print affordance, not a drawer one)', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    expect(screen.queryByRole('button', { name: /نسخة|إعادة طباعة/ })).toBeNull();
  });

  it('the ONLY affordance is manual override', () => {
    render(<DrawerFailureBanner drawerFailure={FAILURE} onManualOverride={() => {}} now={NOW} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('إيصال يدوي');
  });
});
