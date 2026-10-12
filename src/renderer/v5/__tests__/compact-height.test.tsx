/**
 * RT-407 (RT-312 D12–D14) — the compact-height composition for the 600–767px
 * band.
 *
 * jsdom loads no CSS and does no layout, so this file pins what it can: the
 * CSS that drives the composition (source tripwires), the money columns'
 * structure that CSS relies on, and that both screens mount with their pinned
 * elements at 600/767/768 (and the notice at 599) with 0, 1 and 3 banners.
 * The layout proof — every pinned element fully visible across the band — is
 * the Chromium measurement recorded on RT-407.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { JSX } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenderLineRendererView } from '../../../shared/payments/types';
import { CartState } from '../../../shared/cart/cart-state';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { CheckoutProof, resetCheckoutProofForTests } from '../checkout/dev/CheckoutProof';
import { PaymentLedger } from '../checkout/PaymentLedger';
import { Banner } from '../foundation/Banner';
import { V5Frame } from '../frame/V5Frame';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';
import { makeBridges, signIn } from './__helpers__/live-sale-harness';
import { installViewport } from './__helpers__/viewport-bands';

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

const frameCss = read('../frame/frame.css');
const saleCss = read('../sale/sale-direction-b.css');
const liveSaleCss = read('../sale/live-sale.css');
const checkoutCss = read('../checkout/checkout.css');

/** The body of the one rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const bodies = css
    .split('}')
    .map((r) => r.split('{'))
    .filter(([sel]) => sel?.trim() === selector)
    .map(([, body]) => body ?? '');
  if (bodies.length === 0) throw new Error(`no rule for ${selector}`);
  return bodies.join('\n');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
});

describe('D12 — compact is chosen by height as well as by width (CSS tripwire)', () => {
  it('a viewport under 768px high marks the screen container', () => {
    const media = /@media \(height < 768px\)\s*\{\s*\.v5-frame__main\s*\{([^}]*)\}/.exec(frameCss);
    expect(media?.[1]).toMatch(/--v5-screen-height:\s*compact/);
  });

  it('the screen container stays an inline-size container (never `size`)', () => {
    expect(rule(frameCss, '.v5-frame__main')).toMatch(/container:\s*v5-screen \/ inline-size/);
    for (const css of [frameCss, saleCss, liveSaleCss, checkoutCss]) {
      expect(css).not.toMatch(/container-type:\s*size/);
      expect(css).not.toMatch(/container:\s*v5-screen \/ size/);
    }
  });

  it.each([
    ['sale-direction-b.css', saleCss],
    ['live-sale.css', liveSaleCss],
    ['checkout.css', checkoutCss],
  ])('every v5-screen compact query in %s also reads the height mark', (_name, css) => {
    const queries = css.match(/@container v5-screen[^{]*/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.trim()).toBe(
        '@container v5-screen (max-width: 1120px) or style(--v5-screen-height: compact)',
      );
    }
  });
});

describe('D14 — the Sale money column gives way from the top (CSS tripwire)', () => {
  it('the counts are the only part that shrinks, and then scrolls', () => {
    const counts = rule(saleCss, '.v5-sale-money-counts');
    expect(counts).toMatch(/flex:\s*0 1 auto/);
    expect(counts).toMatch(/min-block-size:\s*0/);
    expect(counts).toMatch(/overflow-y:\s*auto/);
  });

  it.each(['.v5-sale-money-title', '.v5-sale-money-commit', '.v5-sale-money-secondary'])(
    '%s never shrinks',
    (selector) => {
      expect(rule(saleCss, selector)).toMatch(/flex:\s*none/);
    },
  );

  it('the total and commit stay at the foot, the void below them', () => {
    expect(rule(saleCss, '.v5-sale-money-commit')).toMatch(/margin-block-start:\s*auto/);
  });
});

const line = (id: string, amount: number, change = 0): TenderLineRendererView => ({
  tender_line_id: id,
  tender_type: 'cash',
  state: 'applied',
  amount_applied_minor: amount,
  ...(change > 0 ? { change_due_minor: change } : {}),
  applied_at: '2026-10-12T09:00:00.000Z',
  apply_order: 1,
});

function ledgerParts(): {
  due: Element;
  change: Element | null;
  middle: Element;
  actions: Element;
} {
  const column = screen.getByRole('region', { name: 'المبلغ المستحق' });
  const part = (s: string): Element | null => column.querySelector(`:scope > ${s}`);
  return {
    due: part('.v5-ledger__due') as Element,
    change: part('.v5-ledger__change'),
    middle: part('.v5-ledger__middle') as Element,
    actions: part('.v5-ledger__actions') as Element,
  };
}

const follows = (a: Element, b: Element): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('D13 — the recorded change is pinned under the amount due', () => {
  function renderLedger(changeDueMinor: number): void {
    render(
      <PaymentLedger
        dueMinor={0}
        lines={[line('tl-1', 10_000, changeDueMinor)]}
        changeDueMinor={changeDueMinor}
        actions={<button type="button">تأكيد الدفع</button>}
      />,
    );
  }

  it('sits in its own row, outside the scrolling middle, between the due and the lines', () => {
    renderLedger(500);
    const { due, change, middle, actions } = ledgerParts();
    const row = screen.getByTestId('payment-ledger-change');
    expect(change).not.toBeNull();
    expect(change?.contains(row)).toBe(true);
    expect(middle.contains(row)).toBe(false);
    expect(row).toHaveTextContent('الباقي للعميل 5.00 EGP');
    // DOM (= reading) order: due → change → recorded lines → actions.
    expect(follows(due, change as Element)).toBe(true);
    expect(follows(change as Element, middle)).toBe(true);
    expect(follows(middle, actions)).toBe(true);
  });

  it('the recorded lines stay in the scrolling middle', () => {
    renderLedger(500);
    const { middle } = ledgerParts();
    expect(middle.contains(screen.getByTestId('payment-ledger'))).toBe(true);
  });

  it('no change recorded: no change row at all', () => {
    renderLedger(0);
    expect(ledgerParts().change).toBeNull();
    expect(screen.queryByTestId('payment-ledger-change')).not.toBeInTheDocument();
  });

  it('the change row holds nothing focusable, so the Tab order is unchanged', () => {
    renderLedger(500);
    const { change } = ledgerParts();
    expect(change?.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });

  it('the grid names its rows, so an absent change row leaves the 1fr on the middle', () => {
    const ledger = rule(checkoutCss, '.v5-ledger');
    expect(ledger).toMatch(/grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/);
    expect(ledger).toMatch(/grid-template-areas:\s*'due' 'change' 'middle' 'actions'/);
    expect(rule(checkoutCss, '.v5-ledger__change')).toMatch(/grid-area:\s*change/);
    expect(rule(checkoutCss, '.v5-ledger__middle')).toMatch(/grid-area:\s*middle/);
  });

  it('forced colours: nothing in the money column opts out, so the change stays CanvasText', () => {
    const ledgerRules = checkoutCss
      .split('}')
      .filter((r) => /\.v5-ledger/.test(r.split('{')[0] ?? ''));
    for (const body of ledgerRules) expect(body).not.toMatch(/forced-color-adjust/);
  });

  it('no axe violations with the change pinned', async () => {
    renderLedger(500);
    await expectNoAxeViolations(document.body);
  });
});

const BANNERS = [
  'لا توجد وردية مفتوحة على هذا الجهاز. افتح وردية بمبلغ الافتتاح قبل البيع.',
  'تعذّرت طباعة الإيصال. البيع محفوظ. أعد الطباعة أو سلّم إيصالًا يدويًا.',
  'لم يُفتح درج النقود. افتحه يدويًا.',
];

function banners(count: number): JSX.Element | undefined {
  if (count === 0) return undefined;
  return (
    <>
      {BANNERS.slice(0, count).map((text) => (
        <Banner key={text} tone="warning">
          {text}
        </Banner>
      ))}
    </>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const HEIGHTS = [599, 600, 767, 768] as const;
const CASES = HEIGHTS.flatMap((h) => [0, 1, 3].map((n) => [h, n] as const));

describe('Sale across the band, with 0, 1 and 3 banners', () => {
  it.each(CASES)('%ipx high, %i banners', async (height, count) => {
    installViewport(1280, height);
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
        <V5Frame notices={banners(count)}>
          <LiveSaleWorkspace
            cartBridge={bridges.cart}
            catalogueBridge={bridges.catalogue}
            onPaymentContinue={vi.fn()}
          />
        </V5Frame>
      </MemoryRouter>,
    );
    await settle();

    if (height < 600) {
      expect(document.querySelector('.screen-too-small')).toHaveAttribute(
        'data-shortfall',
        'height',
      );
      expect(document.querySelector('.v5-sale-money')).toBeNull();
      return;
    }
    expect(document.querySelectorAll('.v5-banner')).toHaveLength(count);
    const money = document.querySelector('.v5-sale-money') as HTMLElement;
    const parts = Array.from(money.children, (c) => c.className);
    // Title, counts, then the pinned foot: total + commit, then the void.
    expect(parts).toEqual([
      'v5-sale-money-title',
      'v5-sale-money-counts',
      'v5-sale-money-commit',
      'v5-sale-money-secondary',
    ]);
    const commit = money.querySelector('.v5-sale-money-commit') as HTMLElement;
    expect(commit.querySelector('.v5-sale-grand-total')).not.toBeNull();
    expect(commit.querySelector('.v5-sale-checkout')).not.toBeNull();
    expect(money.querySelector('.v5-sale-money-secondary .v5-live-void')).not.toBeNull();
  });
});

describe('Checkout across the band, with recorded change and the Back reason', () => {
  it.each(CASES.filter(([, n]) => n < 2))('%ipx high, %i banner', async (height, count) => {
    installViewport(1280, height);
    window.location.hash = `#/dev/checkout-proof?lines=4&preset=change&banner=${String(count)}`;
    resetCheckoutProofForTests();
    render(<CheckoutProof />);
    await settle();

    if (height < 600) {
      expect(document.querySelector('.screen-too-small')).toHaveAttribute(
        'data-shortfall',
        'height',
      );
      expect(screen.queryByRole('region', { name: 'المبلغ المستحق' })).not.toBeInTheDocument();
      return;
    }
    expect(document.querySelector('.v5-checkout__back-reason')).not.toBeNull();
    const { due, change, middle, actions } = ledgerParts();
    expect(change?.contains(screen.getByTestId('payment-ledger-change'))).toBe(true);
    expect(follows(due, change as Element)).toBe(true);
    expect(follows(change as Element, middle)).toBe(true);
    expect(actions.querySelector('.checkout-actions__slot--end')).not.toBeNull();
    expect(actions.querySelector('.checkout-actions__slot--start')).not.toBeNull();
  });
});
