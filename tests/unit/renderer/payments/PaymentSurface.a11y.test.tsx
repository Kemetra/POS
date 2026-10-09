/**
 * T034 — PaymentSurface accessibility.
 *
 * - 44×44 px touch targets on interactive elements.
 * - Keyboard operability: Tab reaches all enabled tender buttons.
 * - ARIA landmarks: payment surface has a `main` or `region` role.
 * - Tender buttons have accessible labels.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

import { PaymentSurface } from '../../../../src/renderer/ui/payments/PaymentSurface.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
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
    for (let i = 0; i < 4 && document.activeElement !== cash; i += 1) {
      await user.tab();
      if (document.activeElement !== cash) {
        expect(summary.contains(document.activeElement)).toBe(true);
      }
    }
    expect(cash).toHaveFocus();
  });
});
