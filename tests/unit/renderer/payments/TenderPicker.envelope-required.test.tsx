/**
 * T020 — TenderPicker refuses to render without envelope.
 *
 * When no envelope is provided, TenderPicker must not render any
 * tender buttons. This guards against mounting the surface before the
 * handoff contract arrives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

import { TenderPicker } from '../../../../src/renderer/v5/checkout/TenderPicker.js';
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

describe('TenderPicker — envelope required', () => {
  it('renders nothing (null) when envelope is null', () => {
    const { container } = render(<TenderPicker envelope={null} onTenderSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tender buttons when envelope is provided', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} />);
    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
  });
});
