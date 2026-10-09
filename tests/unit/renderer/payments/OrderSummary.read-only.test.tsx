/**
 * T022 — OrderSummary is read-only.
 *
 * No edit affordances (quantity steppers, remove buttons, note editing) must appear.
 * Lines are rendered with display_name, quantity, and line_subtotal_minor.
 * subtotal_minor from the envelope is rendered.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

import { OrderSummary } from '../../../../src/renderer/v5/checkout/OrderSummary.js';
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
      {
        line_id: 'line-2',
        item_ref: 'SKU-002',
        display_name: 'Amoxicillin 250mg',
        quantity: 1,
        unit_price_minor: 500,
        line_subtotal_minor: 500,
        note: 'take with food',
        version: 1,
        last_action_id: 'action-2',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: 800,
    created_at: '2026-05-21T10:00:00.000Z',
    handoff_action_id: 'handoff-001',
    ...overrides,
  };
}

describe('OrderSummary — line rendering', () => {
  it('renders display_name for each line', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.getByText('Paracetamol 500mg')).toBeInTheDocument();
    expect(screen.getByText('Amoxicillin 250mg')).toBeInTheDocument();
  });

  it('renders quantity for each line', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByText('×1')).toBeInTheDocument();
  });

  it('renders line_subtotal_minor formatted as currency', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    // line-1: 300 minor = 3.00 EGP
    expect(screen.getByTestId('payment-summary-line-subtotal-0')).toHaveTextContent('3.00 EGP');
    // line-2: 500 minor = 5.00 EGP
    expect(screen.getByTestId('payment-summary-line-subtotal-1')).toHaveTextContent('5.00 EGP');
  });

  it('renders the envelope subtotal_minor', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    // makeEnvelope subtotal_minor: 800 = 8.00 EGP
    expect(screen.getByTestId('payment-summary-subtotal')).toHaveTextContent('8.00 EGP');
  });
});

describe('OrderSummary — unsafe integer guard', () => {
  it('renders em-dash placeholder when line_subtotal_minor is not a safe integer', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const env = makeEnvelope({
      lines: [
        {
          line_id: 'line-x',
          item_ref: 'SKU-X',
          display_name: 'Unsafe item',
          quantity: 1,
          unit_price_minor: unsafe,
          line_subtotal_minor: unsafe,
          note: null,
          version: 1,
          last_action_id: 'action-x',
        },
      ],
      subtotal_minor: unsafe,
    });
    render(<OrderSummary envelope={env} />);
    // The em-dash fallback should appear (at least twice — line + subtotal)
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('OrderSummary — no edit affordances', () => {
  it('does not render quantity increment/decrement buttons', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.queryByRole('button', { name: /increment|decrement|\+|-/i })).toBeNull();
  });

  it('does not render remove buttons', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.queryByRole('button', { name: /remove|delete/i })).toBeNull();
  });

  it('does not render note edit affordances', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.queryByRole('button', { name: /note|edit note/i })).toBeNull();
  });
});
