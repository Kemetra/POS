/**
 * 022 US3 T070/T071 — checkout composition: amount-due hierarchy + tender grid.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT AVOIDS GEOMETRY
 * --------------------------------------------------
 * jsdom performs no layout. `getComputedStyle().width` is empty, and a media
 * query never matches, so an assertion on computed geometry is either vacuous
 * or measuring the test environment rather than the product.
 *
 * So this file asserts what is genuinely observable in jsdom and genuinely
 * load-bearing:
 *
 *   - DOM ORDER (FR-23). Tab order follows DOM order, and neither CSS
 *     positioning nor `dir="rtl"` changes it. The designer's prototype ordered
 *     page shells left-to-right in source; carrying that over would send focus
 *     to the centre methods column before the visually-preceding amount panel.
 *     This is the assertion with real failure modes, so it comes first.
 *   - STRUCTURE — the columns exist, and carry the classes the stylesheet and
 *     the narrow-tier media rules key off.
 *   - THE TENDER SET — exactly three tiles, exactly the supported types.
 *   - SELECTED STATE — the selected tile carries its class and check badge.
 *
 * Geometry (392/400 widths, radius 14, padding 18 14, the 44/700 numeric) lives
 * in `tailwind.css` as tokens and is verified by the T0E1 visual capture, not
 * here. `token-guard.test.ts` independently forbids those values entering as
 * inline literals.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { TenderSelection } from '../TenderSelection.js';

const SUBTOTAL_MINOR = 5000;

function makeEnvelope(subtotalMinor = SUBTOTAL_MINOR): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [
      {
        line_id: 'line-001',
        item_ref: 'item-001',
        display_name: 'باراسيتامول ٥٠٠ مجم',
        quantity: 2,
        unit_price_minor: 1250,
        line_subtotal_minor: 2500,
        note: null,
        version: 1,
        last_action_id: 'act-001',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: subtotalMinor,
    created_at: '2026-09-19T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function seedSession(): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
}

function makeBridge(): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: SUBTOTAL_MINOR,
    started_at: '2026-09-19T09:59:00.000Z',
    tender_lines: [],
  };
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: attempt })),
      confirm: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-19T10:00:00.000Z' }),
      ),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    },
    tender: { apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })) },
  } as unknown as { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
}

beforeEach(seedSession);

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// T070 — three-column composition + amount-due hierarchy
// ---------------------------------------------------------------------------

describe('022 US3 T070 — checkout three-column composition', () => {
  it('renders the three columns of the composition', () => {
    render(<PaymentSurface />);
    const body = screen.getByTestId('payment-surface-body');
    expect(body.querySelector('.payment-surface__amount')).not.toBeNull();
    expect(body.querySelector('.payment-surface__methods')).not.toBeNull();
    expect(body.querySelector('.payment-surface__summary')).not.toBeNull();
  });

  it('DOM order is amount → methods → summary, matching the RTL visual order (FR-23)', () => {
    // THE load-bearing assertion of this file. Tab order follows DOM order; a
    // dir="rtl" attribute does not reorder it. The handoff warns that the
    // designer's LTR source order (summary → methods → amount) would send
    // keyboard focus to the centre column before the visually-preceding amount
    // panel — violating spec FR-23: "Keyboard focus traversal order MUST follow
    // the RTL visual order."
    render(<PaymentSurface />);
    const columns = Array.from(screen.getByTestId('payment-surface-body').children).map(
      (el) => el.className,
    );

    expect(columns).toHaveLength(3);
    expect(columns[0]).toContain('payment-surface__amount');
    expect(columns[1]).toContain('payment-surface__methods');
    expect(columns[2]).toContain('payment-surface__summary');
  });

  it('the amount-due numeric is the dominant value: LTR, tabular, its own class', () => {
    render(<PaymentSurface />);
    const value = screen.getByTestId('payment-surface-amount-due');
    // FR-21: money is LTR mono and never bidi-reordered, whatever the surface dir.
    expect(value).toHaveAttribute('dir', 'ltr');
    // FR-16: the dominant numeric carries the hierarchy class the token sizes.
    expect(value.className).toContain('payment-surface__amount-value');
  });

  it('the amount column carries an Arabic label for the amount due', () => {
    render(<PaymentSurface />);
    const label = screen.getByTestId('payment-surface-amount-label');
    expect(label.textContent).toMatch(/[؀-ۿ]/);
  });

  it('the body carries the reflow hook the narrow-tier media rule keys off', () => {
    // The 1024-1279px reflow (amount panel below the methods) is expressed as a
    // media query on this class, NOT gated on `useViewportTier`.
    //
    // That is deliberate and load-bearing: `useViewportTier` DEBOUNCES tier
    // changes by 100ms while CSS applies the instant the viewport crosses a
    // breakpoint. A React-gated reflow would leave ~100ms of broken layout on
    // every crossing — the same defect documented for the `.sale-layout` and
    // `.tender-method-grid` narrow rules (#450/#451), which must NOT be deleted
    // as dead CSS for exactly this reason.
    render(<PaymentSurface />);
    expect(screen.getByTestId('payment-surface-body').className).toContain('payment-surface__body');
  });
});

// ---------------------------------------------------------------------------
// T071 — tender grid: exactly three tiles
// ---------------------------------------------------------------------------

describe('022 US3 T071 — tender grid renders exactly the three supported tenders', () => {
  it('renders three tiles and no more', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    const tiles = document.querySelectorAll('.tender-method-grid .method-card');
    expect(tiles).toHaveLength(3);
  });

  it('renders exactly cash, external_card_terminal and internal_voucher', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.getByTestId('tender-cash')).toBeInTheDocument();
    expect(screen.getByTestId('tender-external-card')).toBeInTheDocument();
    expect(screen.getByTestId('tender-voucher')).toBeInTheDocument();
  });

  it('never renders an unsupported tender (RECONCILIATION §B non-capabilities)', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    const text = document.body.textContent;
    // The mockup's six-tile grid carries these; they are NOT authorised here.
    for (const forbidden of ['مدى', 'بطاقة ائتمان', 'شركة تأمين', 'محفظة', 'قسيمة هدية']) {
      expect(text).not.toContain(forbidden);
    }
    expect(document.querySelector('.method-grid--four')).toBeNull();
  });

  it('each tile carries a distinct sub-label, not a synonym of its own name', () => {
    // Guards the copy regression caught in review: translating the <small>
    // glosses produced near-synonyms stacked on one tile (نقدي / نقداً). The
    // slot is a muted DESCRIPTIVE sub-label per the mockup, not a second name.
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    for (const testid of ['tender-cash', 'tender-external-card', 'tender-voucher']) {
      const tile = screen.getByTestId(testid);
      const labelNode = tile.querySelector('.tender-selection__option-label');
      const subNode = tile.querySelector('small');
      if (labelNode === null || subNode === null) {
        throw new Error(`${testid}: expected both a label and a sub-label node`);
      }
      const label = labelNode.textContent.trim();
      const sub = subNode.textContent.trim();
      expect(label).toBeTruthy();
      expect(sub).toBeTruthy();
      expect(sub).not.toBe(label);
      // A sub-label that merely re-states the label is the regression this
      // guards; require it to be a real description.
      expect(sub.length).toBeGreaterThan(label.length);
    }
  });

  it('the selected tile carries the selected class and a check badge', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const cash = screen.getByTestId('tender-cash');
    expect(cash.className).toContain('method-card--selected');
    expect(cash.getAttribute('aria-checked')).toBe('true');
    expect(cash.querySelector('.method-card__check')).not.toBeNull();
  });
});
