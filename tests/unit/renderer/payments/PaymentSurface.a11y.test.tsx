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
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    expect(label).toMatch(/cash/);
  });

  it('external card tender button has an accessible label', () => {
    setup();
    render(<PaymentSurface />);
    const btn = screen.getByTestId('tender-external-card');
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    expect(label).toMatch(/card/);
  });

  it('all enabled tender buttons meet 44px touch target', () => {
    setup();
    render(<PaymentSurface />);
    for (const id of ['tender-cash', 'tender-external-card', 'tender-voucher']) {
      const btn = screen.getByTestId(id);
      const style = btn.getAttribute('style') ?? '';
      expect(style).toMatch(/min-height:\s*44/);
    }
  });

  it('keyboard Tab reaches the cash tender button', async () => {
    const user = userEvent.setup();
    setup();
    render(<PaymentSurface />);
    await user.tab();
    // The first Tab from the surface root should land on the cash tender button
    // (it's the first focusable interactive element in the body).
    expect(screen.getByTestId('tender-cash')).toHaveFocus();
  });
});
