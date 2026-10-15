/**
 * RT-412 (RT-312 D2) — the real Sale and Checkout are guarded, and mark what
 * must stay visible. The test DOM does no layout, so it pins the wiring and
 * the CSS the measurement relies on; the layout proof (the notice shows exactly
 * where a must-see element would be clipped, and nowhere else) is the Chromium
 * measurement recorded on RT-412.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CartState } from '../../../shared/cart/cart-state';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { CheckoutProof, resetCheckoutProofForTests } from '../checkout/dev/CheckoutProof';
import { V5Frame } from '../frame/V5Frame';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';
import { makeBridges, signIn } from './__helpers__/live-sale-harness';
import { installViewport } from './__helpers__/viewport-bands';

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

const frameCss = read('../frame/frame.css');
const guardCss = read('../foundation/fit-guard.css');
const saleCss = read('../sale/sale-direction-b.css');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

describe('CSS the guard relies on (tripwires)', () => {
  it('the guard adds no box, so the RT-407 composition is untouched', () => {
    expect(guardCss).toMatch(/\.v5-fit-guard\s*\{\s*display:\s*contents;?\s*\}/);
    expect(frameCss).toMatch(
      /\.v5-frame__main > \*,\s*\.v5-frame__main > \.v5-fit-guard > \*\s*\{[^}]*flex:\s*1 1 auto/,
    );
  });

  it('<main> is the notice containing block; the notice covers it, opaque', () => {
    expect(frameCss).toMatch(/\.v5-frame__main\s*\{\s*position:\s*relative;?\s*\}/);
    const notice = /\.v5-frame \.v5-fit-block\s*\{([^}]*)\}/.exec(guardCss)?.[1] ?? '';
    expect(notice).toMatch(/position:\s*absolute/);
    expect(notice).toMatch(/inset:\s*0/);
    expect(notice).toMatch(/background:\s*var\(--v5-surface-page\)/);
  });

  it('one row size, 60px comfortable and 52px compact, read by both the rows and the guard', () => {
    expect(saleCss).toMatch(
      /\.v5-live-sale \.v5-sale-cart-table\s*\{[^}]*--v5-fit-row-size:\s*60px;?[^}]*\}/,
    );
    expect(saleCss).toMatch(
      /\.v5-live-sale \.v5-sale-cart-line\s*\{\s*min-block-size:\s*var\(--v5-fit-row-size\)/,
    );
    const compact =
      saleCss.split(
        '@container v5-screen (max-width: 1120px) or style(--v5-screen-height: compact)',
      )[1] ?? '';
    expect(compact).toMatch(/\.v5-sale-cart-table\s*\{\s*--v5-fit-row-size:\s*52px;?\s*\}/);
    // No fixed row height left behind to drift from the guard's number.
    expect(saleCss).not.toMatch(/\.v5-sale-cart-line\s*\{[^}]*min-block-size:\s*\d+px/);
  });

  /*
   * RT-479: the guard counts the cart list's own height as its row space. Sized
   * to its content, an empty or short cart (column labels + the empty message,
   * 85px) never holds 4 rows, so the Sale was blocked at every window size. The
   * list fills the cart region instead, whatever the number of lines.
   */
  it('the cart list fills the cart region, so its row space never depends on the lines drawn', () => {
    const rules = saleCss.match(/\.v5-live-sale \.v5-sale-cart-table\s*\{[^}]*\}/g) ?? [];
    expect(rules.some((rule) => /flex:\s*1 1 auto/.test(rule))).toBe(true);
    // Nothing (the compact composition included) gives the list a fixed or content height back.
    expect(rules.join('')).not.toMatch(/flex:\s*(0|none)|(^|[\s;{])(block-size|height):/);
  });
});

describe('Checkout marks the due, the change and the actions, inside the guard', () => {
  it('with recorded change (preset=change)', async () => {
    installViewport(1280, 600);
    window.location.hash = '#/dev/checkout-proof?lines=4&preset=change';
    resetCheckoutProofForTests();
    render(<CheckoutProof />);
    await settle();

    const guard = document.querySelector('.v5-fit-guard');
    expect(guard?.querySelector('.v5-checkout')).not.toBeNull();
    for (const part of ['.v5-ledger__due', '.v5-ledger__change', '.v5-ledger__actions']) {
      expect(guard?.querySelector(part)).toHaveAttribute('data-fit', 'pinned');
    }
    // The commit and the cancel slot both sit in the pinned actions row.
    const actions = guard?.querySelector('.v5-ledger__actions');
    expect(actions?.querySelector('.checkout-actions__slot--end')).not.toBeNull();
    expect(actions?.querySelector('.checkout-actions__slot--start')).not.toBeNull();
    // Fits in the test DOM (no layout): no notice, nothing inert.
    expect(document.querySelector('[data-testid="fit-block"]')).toBeNull();
    expect(guard).not.toHaveAttribute('inert');
  });
});

describe('Sale marks the total + commit, the void and the 4-row cart, inside the guard', () => {
  it('an editing cart', async () => {
    installViewport(1280, 600);
    signIn();
    const bridges = makeBridges();
    bridges.snapshot.mockResolvedValue({
      kind: 'ok',
      snapshot: {
        cart_id: 'cart-1',
        state: CartState.editing,
        lines: [
          {
            line_id: 'l1',
            display_name: 'بنادول',
            quantity: 1,
            unit_price_minor: 1500,
            line_subtotal_minor: 1500,
            note: null,
            version: 1,
          },
        ],
        discount_placeholders: [],
        paid: false,
        envelope: null,
      },
    });
    useCartStore.setState({
      activeCart: { cart_id: 'cart-1', state: CartState.editing, lastLineId: null },
    });
    render(
      <MemoryRouter initialEntries={['/app/cart']}>
        <V5Frame>
          <LiveSaleWorkspace
            cartBridge={bridges.cart}
            catalogueBridge={bridges.catalogue}
            onPaymentContinue={vi.fn()}
          />
        </V5Frame>
      </MemoryRouter>,
    );
    await settle();

    const guard = document.querySelector('.v5-fit-guard');
    expect(guard?.querySelector('.v5-live-sale')).not.toBeNull();
    const commit = guard?.querySelector('.v5-sale-money-commit');
    expect(commit).toHaveAttribute('data-fit', 'pinned');
    expect(commit?.querySelector('.v5-sale-grand-total')).not.toBeNull();
    expect(commit?.querySelector('.v5-sale-checkout')).not.toBeNull();
    expect(guard?.querySelector('.v5-sale-money-secondary')).toHaveAttribute('data-fit', 'pinned');
    const table = guard?.querySelector('.v5-sale-cart-table');
    expect(table).toHaveAttribute('data-fit-rows', '4');
    expect(table?.querySelector('.v5-sale-cart-columns')).toHaveAttribute('data-fit-exclude');
    // Drawn rows count at their real height (Codex P2 on #651).
    expect(table?.querySelector('.v5-sale-cart-line')).toHaveAttribute('data-fit-row');
    expect(document.querySelector('[data-testid="fit-block"]')).toBeNull();
  });
});
