/**
 * T023 — PaymentSurface operator badge visibility.
 *
 * When a signed-in operator session exists, OperatorBadge must appear in
 * the PaymentSurface header. When signed out, PaymentSurface returns null.
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

function makeEnvelope(overrides: Partial<PaymentIntentEnvelope> = {}): PaymentIntentEnvelope {
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
    ...overrides,
  };
}

function seedSignedInSession(): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'session-uuid',
        operator_id: 'op-uuid',
        display_name: 'Jane Smith',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-05-21T08:00:00.000Z',
      },
    },
  });
}

describe('PaymentSurface — operator badge', () => {
  afterEach(() => {
    useOperatorSessionStore.getState().reset();
    usePaymentStore.getState().reset();
  });

  it('renders the OperatorBadge when signed in and envelope is present', () => {
    seedSignedInSession();
    usePaymentStore.getState().mount(makeEnvelope());
    render(<PaymentSurface />);
    expect(screen.getByTestId('operator-badge')).toBeInTheDocument();
  });

  it('shows the operator display_name in the badge', () => {
    seedSignedInSession();
    usePaymentStore.getState().mount(makeEnvelope());
    render(<PaymentSurface />);
    expect(screen.getByTestId('operator-badge')).toHaveTextContent('Jane Smith');
  });

  it('returns null when signed out', () => {
    useOperatorSessionStore.getState().reset();
    usePaymentStore.getState().mount(makeEnvelope());
    const { container } = render(<PaymentSurface />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when envelope is null even if signed in', () => {
    seedSignedInSession();
    usePaymentStore.getState().reset();
    const { container } = render(<PaymentSurface />);
    expect(container.firstChild).toBeNull();
  });
});

describe('PaymentSurface — tender selection feedback', () => {
  afterEach(() => {
    useOperatorSessionStore.getState().reset();
    usePaymentStore.getState().reset();
  });

  it('shows the cash tender-selected status after selecting cash', async () => {
    const user = userEvent.setup();
    seedSignedInSession();
    usePaymentStore.getState().mount(makeEnvelope());
    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-cash'));
    expect(screen.getByTestId('payment-surface-tender-selected')).toHaveTextContent(
      'تم اختيار النقد',
    );
  });

  it('shows the card-terminal tender-selected status after selecting card', async () => {
    const user = userEvent.setup();
    seedSignedInSession();
    usePaymentStore.getState().mount(makeEnvelope());
    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-external-card'));
    expect(screen.getByTestId('payment-surface-tender-selected')).toHaveTextContent(
      'تم اختيار جهاز الشبكة',
    );
  });
});
