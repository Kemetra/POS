import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import { ReturnsRoute } from '../ReturnsRoute.js';
import {
  fakeBridge,
  journal,
  lookUpSale,
  pickAndQuote,
  renderReturns,
  resetStores,
  session,
  signIn,
  submitReturn,
} from './returns-test-kit.js';

/** RT-15 S3 — K3 (axe) and X1 (no S4 surface, no other bridge). */
afterEach(() => {
  cleanup();
  resetStores();
  vi.unstubAllGlobals();
});

/** A bridge namespace whose every method is the same spy: any use is visible. */
function watched(spy: ReturnType<typeof vi.fn>): object {
  return new Proxy({}, { get: () => spy });
}

const S4_CONTROL = /درج|صرف|طباعة|إيصال|drawer|payout|print|receipt/i;

function expectNoS4Control(): void {
  for (const el of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
    expect(el.textContent).not.toMatch(S4_CONTROL);
    expect(el.getAttribute('aria-label') ?? '').not.toMatch(S4_CONTROL);
  }
}

describe('accessibility (K3)', () => {
  it('has no axe violations on lookup, picker, summary, outcome and history', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({
      kind: 'ok',
      returns: [journal(), journal({ returnId: 'u', state: 'unknown' })],
    });
    bridge.submit.mockResolvedValueOnce({
      kind: 'unconfirmed',
      ret: journal({ state: 'unknown' }),
    });
    const user = userEvent.setup();
    const { container } = renderReturns({ bridge });
    await screen.findAllByRole('row');
    await expectNoAxeViolations(container);
    await lookUpSale(user);
    await expectNoAxeViolations(container);
    await pickAndQuote(user);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'تأكيد الإرجاع' }));
    await screen.findByRole('button', { name: 'تحقّق مجددًا' });
    await expectNoAxeViolations(container);
  });
});

describe('scope (X1, A1 through window.api)', () => {
  it('uses only window.api.returns and offers no payout, drawer or print control', async () => {
    const returns = fakeBridge();
    const other = { payments: vi.fn(), receipts: vi.fn(), sales: vi.fn(), cart: vi.fn() };
    vi.stubGlobal('api', {
      returns,
      payments: watched(other.payments),
      receipts: watched(other.receipts),
      sales: watched(other.sales),
      cart: watched(other.cart),
    });
    useFeatureFlagsStore.getState().hydrate({ returns: true });
    signIn(session('manager'));
    const user = userEvent.setup();
    render(<ReturnsRoute />);
    expectNoS4Control();
    await lookUpSale(user);
    expectNoS4Control();
    await pickAndQuote(user);
    expectNoS4Control();
    await user.click(screen.getByRole('button', { name: 'تأكيد الإرجاع' }));
    await screen.findByRole('heading', { name: 'نتيجة المرتجع' });
    expectNoS4Control();
    expect(returns.submit).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(other)) expect(fn).not.toHaveBeenCalled();
  });

  it('shows the missing-bridge notice when window.api has no returns namespace', () => {
    vi.stubGlobal('api', {});
    useFeatureFlagsStore.getState().hydrate({ returns: true });
    signIn(session('admin'));
    render(<ReturnsRoute />);
    expect(screen.getByText('المرتجعات غير متاحة في هذه النسخة من التطبيق.')).toBeInTheDocument();
  });
});

describe('admin role', () => {
  it('lets an admin run the flow like a manager (D-b)', async () => {
    const user = userEvent.setup();
    renderReturns({ role: 'admin' });
    await submitReturn(user);
    expect(await screen.findByRole('heading', { name: 'نتيجة المرتجع' })).toBeInTheDocument();
  });
});
