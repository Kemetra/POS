import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { CartBridgeAPI } from '../../../../shared/bridge-api';
import { CartState } from '../../../../shared/cart/cart-state';
import type {
  CartParkBridgeAPI,
  CartParkResponse,
  ParkedSaleView,
} from '../../../../shared/cart/park-types';
import { resetScanGuardForTests } from '../../../scan/ScanGuardHost';
import { useCartStore } from '../../../stores/cart-store';
import { useCatalogueSearchStore } from '../../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { usePaymentStore } from '../../../stores/payment-store';
import { LiveSaleWorkspace } from '../../sale/LiveSaleWorkspace';
import { ParkedSalesScreen } from '../ParkedSalesScreen';
import { PARK_COPY } from '../park-copy';
import {
  addLineByScan,
  makeBridges,
  signIn,
  type Bridges,
} from '../../__tests__/__helpers__/live-sale-harness';

function resetStores(): void {
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  usePaymentStore.getState().reset();
  resetScanGuardForTests();
}

afterEach(() => {
  cleanup();
  resetStores();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
});

/**
 * A stand-in for main's parked set (spec 024): a park adds a row; it outlives
 * the renderer, as the durable `carts` row does across a restart (K2).
 */
function fakeMain(parkAnswer?: () => Promise<CartParkResponse>) {
  const rows: ParkedSaleView[] = [];
  const park = vi.fn<CartParkBridgeAPI['park']>(async (req) => {
    const answer = parkAnswer ? await parkAnswer() : ({ kind: 'parked' } as const);
    if (answer.kind === 'parked')
      rows.unshift({
        cart_id: req.cart_id,
        label: req.label ?? null,
        line_count: 2,
        total_minor: 4000,
        parked_at: new Date().toISOString(),
        stale: false,
      });
    return answer;
  });
  const resume = vi.fn<CartParkBridgeAPI['resume']>((req) =>
    Promise.resolve({ kind: 'resumed', cart_id: req.cart_id }),
  );
  const parked: CartParkBridgeAPI = {
    park,
    listParked: vi.fn(() => Promise.resolve({ kind: 'parked_sales' as const, items: [...rows] })),
    previewResume: vi.fn(() =>
      Promise.resolve({ kind: 'preview' as const, changes: [], unavailable: [], diff_token: 'd' }),
    ),
    resume,
  };
  return { parked, park, resume, rows };
}

function renderSale(bridges: Bridges, parked: CartParkBridgeAPI, onShowParked = vi.fn()) {
  const cart = { ...bridges.cart, parked } as CartBridgeAPI;
  render(
    <LiveSaleWorkspace
      cartBridge={cart}
      catalogueBridge={bridges.catalogue}
      onPaymentContinue={vi.fn()}
      onShowParked={onShowParked}
    />,
  );
  return onShowParked;
}

const parkButton = (): HTMLElement => {
  const [first] = screen.getAllByRole('button', { name: PARK_COPY.parkAction });
  if (first === undefined) throw new Error('no park button');
  return first;
};
const parkedButton = (): HTMLElement => screen.getByRole('button', { name: /المبيعات المعلّقة/ });

describe('the Sale: park (PK3-SaleReady … Parked)', () => {
  it('SaleEmpty: park is disabled with no line; the parked list is a visible button with the count', async () => {
    signIn();
    const main = fakeMain();
    const onShowParked = renderSale(makeBridges(), main.parked);
    expect(parkButton()).toBeDisabled();
    await waitFor(() => {
      expect(parkedButton()).toHaveTextContent('0');
    });
    await userEvent.setup().click(parkedButton());
    expect(onShowParked).toHaveBeenCalledOnce();
  });

  it('I-2: park is apart from «إلغاء البيع» and never shares its danger style', async () => {
    signIn();
    const main = fakeMain();
    renderSale(makeBridges(), main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    const park = parkButton();
    const voidBtn = screen.getByRole('button', { name: 'إلغاء البيع' });
    expect(park).toBeEnabled();
    expect(park.className).not.toMatch(/danger|void/);
    expect(park.parentElement).toBe(voidBtn.parentElement);
    expect(park.nextElementSibling).toHaveClass('v5-park-sep');
  });

  it('D-K1: no key opens park or the list (F3 / F4 stay unbound)', async () => {
    signIn();
    const main = fakeMain();
    const onShowParked = renderSale(makeBridges(), main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    fireEvent.keyDown(document.body, { key: 'F4' });
    fireEvent.keyDown(document.body, { key: 'F3' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onShowParked).not.toHaveBeenCalled();
  });

  it('I-13: the sale stays on screen while main saves, and clears only after `parked`', async () => {
    signIn();
    let release: (a: CartParkResponse) => void = () => undefined;
    const main = fakeMain(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const bridges = makeBridges();
    renderSale(bridges, main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    await addLineByScan(user);
    await user.click(parkButton());
    const dialog = screen.getByRole('dialog', { name: PARK_COPY.dialogTitle });
    expect(dialog).toHaveTextContent('صنفان');
    expect(dialog).toHaveTextContent('40.00 EGP');
    await user.type(within(dialog).getByLabelText(PARK_COPY.labelField), 'ينتظر المحفظة');
    await user.click(within(dialog).getByRole('button', { name: PARK_COPY.parkAction }));
    await within(dialog).findByText(PARK_COPY.saving);
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(2);
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-1');

    await act(async () => {
      release({ kind: 'parked' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(0);
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(screen.getByText(/عُلِّق البيع/)).toHaveTextContent('عُلِّق البيع ينتظر المحفظة.');
    expect(main.park).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1', label: 'ينتظر المحفظة' }),
    );
    // The count is read again from main.
    await waitFor(() => {
      expect(parkedButton()).toHaveTextContent('1');
    });
    // Focus goes back to the scan owner, ready for the next customer.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' })).toHaveFocus();
    });
  });

  it('a refusal keeps the sale; the notice goes with the next line', async () => {
    signIn();
    const main = fakeMain(() => Promise.resolve({ kind: 'refused', reason: 'not_parkable' }));
    renderSale(makeBridges(), main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    await user.click(parkButton());
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: PARK_COPY.parkAction }));
    expect(await within(dialog).findByText(PARK_COPY.generic)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: PARK_COPY.back }));
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(1);
  });

  it('the parked notice is withdrawn when the next sale takes its first line', async () => {
    signIn();
    const main = fakeMain();
    renderSale(makeBridges(), main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    await user.click(parkButton());
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: PARK_COPY.parkAction }),
    );
    expect(await screen.findByText('عُلِّق البيع.')).toBeInTheDocument();
    await addLineByScan(user);
    expect(screen.queryByText('عُلِّق البيع.')).not.toBeInTheDocument();
  });

  it('no park controls without the parked list route or the bridge', () => {
    signIn();
    const bridges = makeBridges();
    render(
      <LiveSaleWorkspace
        cartBridge={bridges.cart}
        catalogueBridge={bridges.catalogue}
        onPaymentContinue={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: PARK_COPY.parkAction })).not.toBeInTheDocument();
  });
});

describe('restart with parked sales (K2 durability, K5 no re-attach)', () => {
  it('after a renderer restart the parked sale is listed, not re-attached, and resumes', async () => {
    signIn();
    const main = fakeMain();
    const bridges = makeBridges();
    renderSale(bridges, main.parked);
    const user = userEvent.setup();
    await addLineByScan(user);
    await user.click(parkButton());
    await user.type(screen.getByLabelText(PARK_COPY.labelField), 'ينتظر الروشتة');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: PARK_COPY.parkAction }),
    );
    await waitFor(() => {
      expect(main.rows).toHaveLength(1);
    });

    // Restart: the renderer loses every store; main keeps its rows.
    cleanup();
    resetStores();
    signIn();
    renderSale(makeBridges(), main.parked);
    // K5: nothing is re-attached: the Sale is empty, the parked sale only counted.
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(0);
    await waitFor(() => {
      expect(parkedButton()).toHaveTextContent('1');
    });

    cleanup();
    const onResumed = vi.fn();
    render(
      <ParkedSalesScreen
        parked={main.parked}
        cart={bridges.cart}
        onResumed={onResumed}
        onBackToSale={vi.fn()}
      />,
    );
    const row = await screen.findByRole('listitem');
    expect(row).toHaveTextContent('ينتظر الروشتة');
    await user.click(within(row).getByRole('button', { name: PARK_COPY.resume }));
    await waitFor(() => {
      expect(onResumed).toHaveBeenCalledWith('cart-1');
    });
    expect(main.resume).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1', current_cart: 'keep' }),
    );
  });

  it('a resumed cart is shown by reading it back from main (the Sale hydrates it)', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.snapshot.mockResolvedValue({
      kind: 'ok',
      snapshot: {
        cart_id: 'p2',
        state: CartState.editing,
        lines: [
          {
            line_id: 'x1',
            display_name: 'بنادول',
            quantity: 3,
            unit_price_minor: 1500,
            line_subtotal_minor: 4500,
            note: null,
            version: 4,
          },
        ],
        discount_placeholders: [],
        paid: false,
        envelope: null,
      },
    });
    // What ParkedSalesRoute does on `resumed`.
    useCartStore.getState().applyCartCreated('p2');
    renderSale(bridges, fakeMain().parked);
    await waitFor(() => {
      expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(1);
    });
    expect(bridges.snapshot).toHaveBeenCalledWith({ cart_id: 'p2' });
    expect(parkButton()).toBeEnabled();
  });
});
