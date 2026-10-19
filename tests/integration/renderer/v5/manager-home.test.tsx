/**
 * RT-499 (VN-S10 S10-2, G-6) — the manager home through the REAL AppRouter: the
 * cards inside the one v5 frame at both viewport bands, a click that reaches
 * its screen, no figure, and the cashier's refusal with its way back to the Sale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../../src/renderer/router.js';
import { CASHIERS_COPY } from '../../../../src/renderer/v5/cashiers/cashiers-copy.js';
import { RECOVERY_COPY } from '../../../../src/renderer/v5/recovery/recovery-copy.js';
import { SHIFT_COPY } from '../../../../src/renderer/v5/shift/shift-copy.js';
import { fakeBridges } from '../../../../src/renderer/v5/recovery/__tests__/__helpers__/recovery-fixtures.js';
import { fakeShiftBridge } from '../../../../src/renderer/v5/__tests__/__helpers__/shift-test-kit.js';
import { HOME_COPY } from '../../../../src/renderer/v5/manager/home/home-copy.js';
import { installViewport } from '../../../../src/renderer/v5/__tests__/__helpers__/viewport-bands.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import { expectNoAxeViolations } from '../../../../src/renderer/test-utils/axe-config.js';
import {
  installManagerScreenApi,
  operatorBridge,
  pairedBridge,
  renderAppAt,
  resetAppStores,
  signInAs,
} from './__helpers__/app-router-harness.js';

beforeEach(() => {
  installViewport(1280);
  installManagerScreenApi();
});

afterEach(() => {
  cleanup();
  resetAppStores();
  vi.unstubAllGlobals();
});

async function homeMain(): Promise<HTMLElement> {
  const frame = await screen.findByTestId('v5-frame');
  const main = within(frame).getByRole('main');
  await within(main).findByRole('heading', { level: 1, name: HOME_COPY.title });
  return main;
}

function shiftFlagOn(): void {
  useFeatureFlagsStore
    .getState()
    .hydrate({ cart: true, payments: true, productSearch: true, shiftCashup: true });
}

describe('the manager home in the one frame', () => {
  it.each([1280, 1024])(
    'draws the three cards at %i px, axe-clean, with no figure',
    async (width) => {
      installViewport(width);
      signInAs('manager');
      renderAppAt('/app/dashboard');
      const main = await homeMain();
      const names = within(main)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href'));
      expect(names).toEqual([
        '/app/manager/cashiers',
        '/app/manager/recovery',
        '/app/manager/stuck-shifts',
      ]);
      expect(main.textContent).not.toMatch(/[0-9\u0660-\u0669]/);
      expect(document.querySelectorAll('main')).toHaveLength(1);
      await expectNoAxeViolations(document.body);
    },
  );

  it('adds «حالة الوردية» first when the shift flag is on', async () => {
    signInAs('admin');
    shiftFlagOn();
    renderAppAt('/app/dashboard');
    const main = await homeMain();
    const hrefs = within(main)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs[0]).toBe('/app/shift/manager');
    expect(hrefs).toHaveLength(4);
  });

  it('opens the stuck-shifts screen from its card (D-10-2)', async () => {
    const user = userEvent.setup();
    signInAs('manager');
    renderAppAt('/app/dashboard');
    const main = await homeMain();
    await user.click(within(main).getByRole('link', { name: HOME_COPY.stuckShifts.title }));
    expect(
      await within(screen.getByRole('main')).findByRole('heading', {
        level: 1,
        name: 'الورديات العالقة',
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('v5-frame')).toHaveLength(1);
  });

  it('keeps «لوحة المتابعة» current in the nav', async () => {
    signInAs('manager');
    renderAppAt('/app/dashboard');
    await homeMain();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    const active = within(nav)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(active.map((l) => l.textContent)).toEqual([HOME_COPY.title]);
  });
});

describe('every card reaches its screen (S10-2 acceptance)', () => {
  function addBridges(): void {
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    const recovery = fakeBridges();
    Object.assign(api, {
      recovery: recovery.recovery,
      approval: recovery.approval,
      shiftCashup: fakeShiftBridge(),
    });
  }

  async function open(title: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    const frame = await screen.findByTestId('v5-frame');
    const list = await within(within(frame).getByRole('main')).findByRole('list');
    await user.click(within(list).getByRole('link', { name: title }));
    return within(frame).getByRole('main');
  }

  function renderWithCashierList(): void {
    const operator = {
      ...operatorBridge(),
      listCashierPinStatus: vi.fn(() =>
        Promise.resolve({ kind: 'cashiers' as const, cashiers: [] }),
      ),
    };
    render(
      <AppRouter pairing={pairedBridge()} operator={operator} initialEntry="/app/dashboard" />,
    );
  }

  it.each([
    ['«إدارة الكاشير»', HOME_COPY.cashiers.title, CASHIERS_COPY.title],
    ['«المبيعات المعلقة»', HOME_COPY.recovery.title, RECOVERY_COPY.title],
    ['«حالة الوردية»', HOME_COPY.shift.title, SHIFT_COPY.managerTitle],
  ])('%s opens its screen inside the one frame', async (_label, tile, heading) => {
    signInAs('manager');
    shiftFlagOn();
    addBridges();
    renderWithCashierList();
    const main = await open(tile);
    expect(
      await within(main).findByRole('heading', { level: 1, name: heading }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('v5-frame')).toHaveLength(1);
  });
});

describe('a cashier who opens /app/dashboard', () => {
  it.each([1280, 1024])('sees the refusal inside the frame at %i px, axe-clean', async (width) => {
    installViewport(width);
    signInAs('cashier');
    useFeatureFlagsStore.setState({ saleFinalization: true });
    renderAppAt('/app/dashboard');
    const main = await homeMain();
    expect(within(main).getByRole('status')).toHaveTextContent(HOME_COPY.cashierRefusal);
    expect(within(main).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Section unavailable')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['نقطة البيع', 'المبيعات']);
    await expectNoAxeViolations(document.body);
  });

  it('leaves for the Sale with «العودة إلى البيع»', async () => {
    const user = userEvent.setup();
    signInAs('cashier');
    renderAppAt('/app/dashboard');
    const main = await homeMain();
    await user.click(within(main).getByRole('button', { name: HOME_COPY.backToSale }));
    await waitFor(() => {
      expect(screen.queryByText(HOME_COPY.cashierRefusal)).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('heading', { level: 1, name: HOME_COPY.title }),
    ).not.toBeInTheDocument();
  });
});
