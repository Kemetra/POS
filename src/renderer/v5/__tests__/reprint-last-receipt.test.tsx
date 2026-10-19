import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { ReceiptsBridgeAPI, SalesBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import { resetScanGuardForTests } from '../../scan/ScanGuardHost';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { expectNoAxeViolations } from '../../test-utils/axe-config';
import { canReprintLast, ReprintLastReceipt } from '../sale/ReprintLastReceipt';
import { SALES_COPY } from '../manager/sales/sales-copy';
import { addLineByScan, makeBridges, renderSale, signIn } from './__helpers__/live-sale-harness';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  usePaymentStore.getState().reset();
  resetScanGuardForTests();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

const LABEL = SALES_COPY.reprintLast;
const D1_LABEL = 'إعادة طباعة آخر إيصال';
const SALE = { sale_id: 'sale-9', sale_number: 'T1-2026-10-19-000047', finalized_at: 'x' };

function bridges(
  recent: unknown = { kind: 'ok', subscription_token: 't', recent: SALE },
  reprint: unknown = {
    kind: 'ok',
    print_event_id: 'pe-1',
    duplicate_copy_sequence_number: 1,
    reprinted_at: 'x',
    render_path: 'os_print',
  },
) {
  const subscribe = vi.fn().mockResolvedValue(recent);
  const reprintFn = vi.fn().mockResolvedValue(reprint);
  return {
    subscribe,
    reprint: reprintFn,
    sales: { subscribe } as unknown as SalesBridgeAPI,
    receipts: { reprint: reprintFn } as unknown as ReceiptsBridgeAPI,
  };
}

function renderButton(b: ReturnType<typeof bridges>, key = () => 'key-1') {
  render(
    <ReprintLastReceipt
      _testSalesBridge={b.sales}
      _testReceiptsBridge={b.receipts}
      _idempotencyKeyFactory={key}
    />,
  );
  return userEvent.setup();
}

describe('canReprintLast (RT-249 / D1: empty cart only, cashier only)', () => {
  it.each([
    ['cashier', null, 0, true],
    ['cashier', CartState.empty, 0, true],
    ['cashier', CartState.editing, 0, true],
    ['cashier', CartState.editing, 1, false],
    ['cashier', CartState.discount_pending_attribution, 0, false],
    ['cashier', CartState.handing_off, 0, false],
    ['cashier', CartState.frozen_handed_off, 0, false],
    ['cashier', CartState.cancelled, 0, false],
    ['manager', null, 0, false],
    ['admin', null, 0, false],
  ] as const)('%s, cart %s, %i lines -> %s', (role, state, lines, expected) => {
    expect(canReprintLast(role, state, lines)).toBe(expected);
  });
});

describe('ReprintLastReceipt', () => {
  it("uses the owner's D1 wording", () => {
    expect(SALES_COPY.reprintLast).toBe(D1_LABEL);
  });

  it('reads nothing until it is used', () => {
    const b = bridges();
    renderButton(b);
    expect(screen.getByRole('button', { name: LABEL })).toBeEnabled();
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(b.reprint).not.toHaveBeenCalled();
  });

  it("reprints the cashier's last sale through the existing channels, naming no operator", async () => {
    const b = bridges();
    const user = renderButton(b);
    await user.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => {
      expect(b.reprint).toHaveBeenCalledTimes(1);
    });
    // Exact-shape matches: the renderer sends no operator, terminal or role field.
    expect(b.subscribe).toHaveBeenCalledWith({ topic: 'recent' });
    expect(b.reprint).toHaveBeenCalledWith({ sale_id: 'sale-9', idempotency_key: 'key-1' });
  });

  it('says which sale went to the printer, and never claims it printed', async () => {
    const user = renderButton(bridges());
    await user.click(screen.getByRole('button', { name: LABEL }));
    const note = await screen.findByTestId('reprint-last-sent');
    expect(note).toHaveTextContent(SALES_COPY.reprintSent);
    expect(note).toHaveTextContent(SALE.sale_number);
    expect(note).not.toHaveTextContent('طُبع');
  });

  it('asks again on every use: the last sale is resolved at click time', async () => {
    const b = bridges();
    let n = 0;
    const user = renderButton(b, () => `key-${String((n += 1))}`);
    await user.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => {
      expect(b.reprint).toHaveBeenCalledTimes(1);
    });
    await user.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => {
      expect(b.reprint).toHaveBeenCalledTimes(2);
    });
    expect(b.subscribe).toHaveBeenCalledTimes(2);
    expect(
      b.reprint.mock.calls.map((c) => (c[0] as { idempotency_key: string }).idempotency_key),
    ).toEqual(['key-1', 'key-2']);
  });

  it('no sale on this terminal yet: nothing is printed and the existing not-found copy shows', async () => {
    const b = bridges({ kind: 'ok', subscription_token: 't', recent: null });
    const user = renderButton(b);
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(await screen.findByTestId('reprint-last-failed')).toHaveTextContent(
      'لم يُعثر على هذا البيع.',
    );
    expect(b.reprint).not.toHaveBeenCalled();
  });

  it('a refused read never reaches the printer', async () => {
    const b = bridges({ kind: 'refused', reason: 'no_session' });
    const user = renderButton(b);
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(await screen.findByTestId('reprint-last-failed')).toBeInTheDocument();
    expect(b.reprint).not.toHaveBeenCalled();
  });

  it('subscribe snapshot of the banner topic shape is not mistaken for a sale', async () => {
    const b = bridges({ kind: 'ok', subscription_token: 't', banner_state: {} });
    const user = renderButton(b);
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(await screen.findByTestId('reprint-last-failed')).toBeInTheDocument();
    expect(b.reprint).not.toHaveBeenCalled();
  });

  it.each([
    ['not_yet_printed', 'لم يُطبع الإيصال الأصلي لهذا البيع على هذا الجهاز.'],
    ['printer_unavailable', 'تعذّرت الطباعة. تحقق من الطابعة وحاول مرة أخرى.'],
    ['sale_not_found', 'لم يُعثر على هذا البيع.'],
    ['sale_voided', 'لا يمكن طباعة نسخة طبق الأصل لهذا البيع.'],
    ['role_denied', SALES_COPY.reprintFailed],
  ])('a %s refusal uses existing copy', async (reason, copy) => {
    const user = renderButton(bridges(undefined, { kind: 'refused', reason }));
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(await screen.findByTestId('reprint-last-failed')).toHaveTextContent(copy);
    expect(screen.queryByTestId('reprint-last-sent')).not.toBeInTheDocument();
  });

  it('a rejected call shows the failure copy and the button can be used again', async () => {
    const b = bridges();
    b.reprint.mockRejectedValueOnce(new Error('ipc'));
    const user = renderButton(b);
    await user.click(screen.getByRole('button', { name: LABEL }));
    expect(await screen.findByTestId('reprint-last-failed')).toHaveTextContent(
      SALES_COPY.reprintFailed,
    );
    expect(screen.getByRole('button', { name: LABEL })).toBeEnabled();
  });

  it('one call at a time: a second click while one is running is ignored', async () => {
    const b = bridges();
    let release: (v: unknown) => void = () => undefined;
    b.reprint.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = renderButton(b);
    const button = screen.getByRole('button', { name: LABEL });
    await user.click(button);
    await user.click(button);
    await waitFor(() => {
      expect(b.reprint).toHaveBeenCalledTimes(1);
    });
    expect(b.subscribe).toHaveBeenCalledTimes(1);
    release({ kind: 'ok' });
    await screen.findByTestId('reprint-last-sent');
  });

  it('does nothing when there is no bridge (no window.api)', async () => {
    render(<ReprintLastReceipt />);
    await userEvent.setup().click(screen.getByRole('button', { name: LABEL }));
    expect(screen.queryByTestId('reprint-last-sent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reprint-last-failed')).not.toBeInTheDocument();
  });

  it('is axe-clean in every state', async () => {
    const user = renderButton(bridges());
    await expectNoAxeViolations(document.body);
    await user.click(screen.getByRole('button', { name: LABEL }));
    await screen.findByTestId('reprint-last-sent');
    await expectNoAxeViolations(document.body);
  });

  it('is axe-clean in the failed state', async () => {
    const user = renderButton(
      bridges(undefined, { kind: 'refused', reason: 'printer_unavailable' }),
    );
    await user.click(screen.getByRole('button', { name: LABEL }));
    await screen.findByTestId('reprint-last-failed');
    await expectNoAxeViolations(document.body);
  });
});

describe('the Sale places the action only for an empty cart, for a cashier', () => {
  // Main registers sales.* / receipts.* only when saleFinalization is on; with
  // it off (the default and the rollback profile) the button would only fail.
  it('is absent while saleFinalization is off, even for a cashier with an empty cart', async () => {
    signIn();
    useFeatureFlagsStore.setState({ saleFinalization: false });
    renderSale(makeBridges());
    await screen.findByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
    expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
  });

  it('shows for a cashier with an empty cart, hides once a line is added, and is axe-clean', async () => {
    signIn();
    useFeatureFlagsStore.setState({ saleFinalization: true });
    const b = makeBridges();
    renderSale(b);
    expect(await screen.findByRole('button', { name: LABEL })).toBeInTheDocument();
    await expectNoAxeViolations(document.body);

    await addLineByScan(userEvent.setup());
    expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
  });

  it('works end to end through window.api from the Sale', async () => {
    const r = bridges();
    (window as unknown as { api: unknown }).api = { sales: r.sales, receipts: r.receipts };
    signIn();
    useFeatureFlagsStore.setState({ saleFinalization: true });
    renderSale(makeBridges());
    await userEvent.setup().click(await screen.findByRole('button', { name: LABEL }));
    await waitFor(() => {
      expect(r.reprint).toHaveBeenCalledTimes(1);
    });
    const [request] = r.reprint.mock.calls[0] as [{ sale_id: string; idempotency_key: string }];
    expect(request.sale_id).toBe('sale-9');
    expect(request.idempotency_key).not.toBe('');
  });

  it("is not shown to a manager (the terminal's last sale there is anyone's)", async () => {
    signIn();
    useFeatureFlagsStore.setState({ saleFinalization: true });
    useOperatorSessionStore.getState().reset();
    useOperatorSessionStore.getState().hydrateSignedIn({
      id: 'session-1',
      operator_id: 'op-2',
      display_name: 'مدير',
      role: 'manager',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      started_at: '2026-09-23T20:00:00Z',
    });
    renderSale(makeBridges());
    await screen.findByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
    expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument();
  });
});
