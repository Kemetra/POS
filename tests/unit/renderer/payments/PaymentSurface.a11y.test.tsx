/**
 * T034 — PaymentSurface accessibility.
 *
 * - 44×44 px touch targets on interactive elements.
 * - Keyboard operability: Tab reaches all enabled tender buttons.
 * - ARIA landmarks: payment surface has a `main` or `region` role.
 * - Tender buttons have accessible labels.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

// RT-700: these tests drive the card tender, so its flag is on (fail-closed default is off).
beforeEach(() => {
  useFeatureFlagsStore.setState({ cardTender: true });
});
afterEach(() => {
  useFeatureFlagsStore.getState().reset();
});

import { PaymentSurface } from '../../../../src/renderer/ui/payments/PaymentSurface.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';

function makeEnvelope(): PaymentIntentEnvelope {
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
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 2,
        unit_price_minor: 150,
        line_subtotal_minor: 300,
        note: null,
        version: 1,
        last_action_id: 'action-1',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: 300,
    created_at: '2026-05-21T10:00:00.000Z',
    handoff_action_id: 'handoff-001',
  };
}

function setup() {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'session-uuid',
        operator_id: 'op-uuid',
        display_name: 'Test Operator',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-05-21T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(makeEnvelope());
}

describe('PaymentSurface — accessibility', () => {
  afterEach(() => {
    useOperatorSessionStore.getState().reset();
    usePaymentStore.getState().reset();
  });

  it('has an ARIA landmark for the payment surface', () => {
    setup();
    render(<PaymentSurface />);
    // main or region role
    const landmark =
      screen.queryByRole('main') ?? screen.queryByRole('region', { name: /^(payment|الدفع)$/i });
    expect(landmark).not.toBeNull();
  });

  it('cash tender button has an accessible label', () => {
    setup();
    render(<PaymentSurface />);
    const btn = screen.getByTestId('tender-cash');
    expect(btn).toHaveAttribute('aria-label', 'نقدي');
  });

  it('external card tender button has an accessible label', () => {
    setup();
    render(<PaymentSurface />);
    const btn = screen.getByTestId('tender-external-card');
    expect(btn).toHaveAttribute('aria-label', 'بطاقة');
  });

  it('every tender button is a V5 tender tile (its 72/84px target lives in checkout.css)', () => {
    // RT-243 W1-C: the size is CSS (tile 84px comfortable, 72px compact; see the
    // source tripwire in TenderPicker.tender-availability.test.tsx). jsdom does no
    // layout, so here only the hook the stylesheet keys off is checked.
    setup();
    render(<PaymentSurface />);
    for (const id of ['tender-cash', 'tender-external-card', 'tender-voucher']) {
      expect(screen.getByTestId(id)).toHaveClass('v5-tender-tile');
    }
  });

  it('on arrival, focus is on the first enabled tender tile (freeze 15 §3.2, RT-761)', () => {
    // RT-754 F1: arriving at Checkout left focus on <body>, so the first Tab went to Back.
    setup();
    render(<PaymentSurface />);
    const first = document.querySelector<HTMLElement>(
      '[data-testid="tender-selection"] [role="radio"]:not([disabled])',
    );
    expect(first).not.toBeNull();
    expect(first).toHaveAttribute('data-testid', 'tender-cash');
    expect(first).toHaveFocus();
  });

  describe('held or doubled Enter right after arrival (I-9 pattern, RT-761)', () => {
    // The Enter that left the Sale (on «المتابعة إلى الدفع») can repeat or be tapped twice
    // while focus has just moved onto the first method tile. That is not a choice of cash.
    // Date.now is pinned before render, so the arm window is deterministic, not wall-clock.
    const T = 1_700_000_000_000;
    const ARM_MS = 400;

    function arrive(): void {
      vi.spyOn(Date, 'now').mockReturnValue(T);
      setup();
      render(<PaymentSurface />);
    }
    const selected = () => screen.queryByTestId('payment-surface-tender-selected');

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a key-repeat Enter or Space is swallowed even after the arm window (only `repeat` explains it)', () => {
      arrive();
      const cash = screen.getByTestId('tender-cash');
      vi.spyOn(Date, 'now').mockReturnValue(T + ARM_MS * 5);
      expect(fireEvent.keyDown(cash, { key: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent.keyDown(cash, { key: ' ', repeat: true })).toBe(false);
    });

    it('an Enter or Space inside the arm window is swallowed', () => {
      arrive();
      const cash = screen.getByTestId('tender-cash');
      expect(fireEvent.keyDown(cash, { key: 'Enter' })).toBe(false);
      expect(fireEvent.keyDown(cash, { key: ' ' })).toBe(false);
    });

    it('a deliberate Enter or Space after the arm window is allowed', () => {
      arrive();
      const cash = screen.getByTestId('tender-cash');
      vi.spyOn(Date, 'now').mockReturnValue(T + ARM_MS);
      expect(fireEvent.keyDown(cash, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(cash, { key: ' ' })).toBe(true);
    });

    it('a real Enter or Space right after arrival starts nothing; the same key later chooses cash', async () => {
      const user = userEvent.setup();
      arrive();
      expect(screen.getByTestId('tender-cash')).toHaveFocus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(selected()).toBeNull();
      vi.spyOn(Date, 'now').mockReturnValue(T + ARM_MS * 5);
      await user.keyboard('{Enter}');
      expect(selected()).toBeInTheDocument();
    });

    it('the arm window belongs to the arrival tile: another tile activates normally, a repeat is still swallowed', () => {
      arrive();
      const card = screen.getByTestId('tender-external-card');
      expect(fireEvent.keyDown(card, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(card, { key: ' ' })).toBe(true);
      expect(fireEvent.keyDown(card, { key: 'Enter', repeat: true })).toBe(false);
    });

    it('negative control: a pointer click right after arrival is not guarded', () => {
      arrive();
      fireEvent.click(screen.getByTestId('tender-cash'));
      expect(selected()).toBeInTheDocument();
    });

    it('other keys are never swallowed', () => {
      arrive();
      expect(fireEvent.keyDown(screen.getByTestId('tender-cash'), { key: 'Tab' })).toBe(true);
    });
  });

  it('keyboard Tab reaches the cash tender button, passing only the order summary', async () => {
    // RT-243 W1-C (Direction B): the order summary sits before the tender panel
    // in RTL reading order. It is one tab stop, like the Sale cart: the scrolling
    // line list at 1280, or the «عرض الأصناف» disclosure at 1024 (CSS shows one
    // of the two; jsdom loads no CSS, so both are reachable here).
    const user = userEvent.setup();
    setup();
    render(<PaymentSurface />);
    const summary = screen.getByTestId('payment-cart-summary');
    const cash = screen.getByTestId('tender-cash');
    // RT-761: focus now starts on cash on arrival; leave it so Tab order is walked from <body>.
    (document.activeElement as HTMLElement).blur();
    expect(cash).not.toHaveFocus();
    for (let i = 0; i < 4 && document.activeElement !== cash; i += 1) {
      await user.tab();
      if (document.activeElement !== cash) {
        expect(summary.contains(document.activeElement)).toBe(true);
      }
    }
    expect(cash).toHaveFocus();
  });
});
