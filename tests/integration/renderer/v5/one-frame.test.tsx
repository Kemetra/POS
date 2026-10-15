/**
 * RT-498 (VN-S10 S10-1, owner decision D-10-1 = A) — one frame. Every `/app/*`
 * route the legacy AppShell used to host now renders inside the v5 frame,
 * through the REAL AppRouter: one <main>, one primary nav, the screen as a
 * labelled region, and no legacy shell anywhere. Route guards are unchanged
 * (cashier-route-enumeration.test.tsx keeps proving them). Content is not
 * recomposed here; S10-2 … S10-6 do that per surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { installViewport } from '../../../../src/renderer/v5/__tests__/__helpers__/viewport-bands.js';
import {
  installManagerScreenApi,
  renderAppAt,
  resetAppStores,
  signInAs,
} from './__helpers__/app-router-harness.js';

/** Former AppShell routes, the screen heading each shows, and the nav entry marked current. */
const FORMER_SHELL_ROUTES: ReadonlyArray<{ path: string; heading: RegExp; current: string }> = [
  { path: '/app/dashboard', heading: /لوحة المتابعة/, current: 'لوحة المتابعة' },
  { path: '/app/sales', heading: /^المبيعات$/, current: 'المبيعات' },
  { path: '/app/returns', heading: /المرتجعات/, current: 'المرتجعات' },
  { path: '/app/audit', heading: /audit/i, current: 'سجل المراجعة' },
  { path: '/app/inventory', heading: /inventory/i, current: 'المخزون' },
  { path: '/app/inventory/diagnostics', heading: /catalogue diagnostics/i, current: 'المخزون' },
  { path: '/app/settings', heading: /settings/i, current: 'الإعدادات' },
  { path: '/app/manager/stuck-shifts', heading: /الورديات العالقة/, current: 'لوحة المتابعة' },
  { path: '/app/manager/force-fail', heading: /إنهاء دفع معلّق/, current: 'لوحة المتابعة' },
];

beforeEach(() => {
  installViewport(1280);
  installManagerScreenApi();
});

afterEach(() => {
  cleanup();
  resetAppStores();
  vi.unstubAllGlobals();
});

async function frame(): Promise<HTMLElement> {
  return screen.findByTestId('v5-frame');
}

describe('one frame — every former AppShell route renders in the v5 frame', () => {
  it.each(FORMER_SHELL_ROUTES)(
    '$path: v5 frame, one main, no legacy shell',
    async ({ path, heading }) => {
      signInAs('manager');
      renderAppAt(path);
      const v5 = await frame();
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
      expect(document.querySelector('.top-bar, .nav-rail')).toBeNull();
      expect(within(v5).getAllByRole('main')).toHaveLength(1);
      expect(within(v5).getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeInTheDocument();
      const main = within(v5).getByRole('main');
      expect(
        await within(main).findByRole('heading', { level: 1, name: heading }),
      ).toBeInTheDocument();
    },
  );

  it.each(FORMER_SHELL_ROUTES)(
    '$path: the screen is one labelled region, never a nested landmark',
    async ({ path }) => {
      signInAs('manager');
      renderAppAt(path);
      const main = within(await frame()).getByRole('main');
      await waitFor(() => {
        expect(within(main).getAllByTestId('v5-screen-section')).toHaveLength(1);
      });
      expect(main.querySelector('main, header[role="banner"], [role="banner"]')).toBeNull();
      expect(within(main).queryByTestId('workspace')).not.toBeInTheDocument();
    },
  );

  it.each(FORMER_SHELL_ROUTES)(
    '$path: marks «$current» current in the nav (D-10-5)',
    async ({ path, current }) => {
      signInAs('manager');
      renderAppAt(path);
      const nav = within(await frame()).getByRole('navigation', { name: 'التنقل الرئيسي' });
      const active = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(active.map((link) => link.textContent)).toEqual([current]);
    },
  );

  it('the bare /app index lands a manager on the dashboard, in the frame', async () => {
    signInAs('manager');
    renderAppAt('/app');
    const main = within(await frame()).getByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: /لوحة المتابعة/ }),
    ).toBeInTheDocument();
  });

  it('a cashier who opens /app/dashboard sees the refusal inside the frame, with only the Sale in the nav', async () => {
    signInAs('cashier');
    renderAppAt('/app/dashboard');
    const v5 = await frame();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(within(v5).getByText('لوحة المتابعة متاحة للمدير فقط.')).toBeInTheDocument();
    const nav = within(v5).getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['نقطة البيع']);
  });

  it('moving between manager screens keeps the one frame mounted', async () => {
    const user = userEvent.setup();
    signInAs('manager');
    renderAppAt('/app/sales');
    const v5 = await frame();
    const nav = within(v5).getByRole('navigation', { name: 'التنقل الرئيسي' });
    await user.click(within(nav).getByRole('link', { name: 'لوحة المتابعة' }));
    const main = within(v5).getByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: /لوحة المتابعة/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('v5-frame')).toBe(v5);
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });
});
