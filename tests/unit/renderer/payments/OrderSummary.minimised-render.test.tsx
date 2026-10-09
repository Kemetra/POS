/**
 * T024 — OrderSummary renders only minimised, safe fields.
 *
 * Security invariant: no sensitive IDs (cart_id, operator_session_id,
 * tenant_id, branch_id, terminal_id, handoff_action_id, item_ref,
 * last_action_id, version numbers as debug-visible values) must appear
 * in the rendered DOM.
 *
 * Displayed fields: display_name, quantity, line_subtotal_minor, subtotal_minor.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);

import { OrderSummary } from '../../../../src/renderer/v5/checkout/OrderSummary.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';

const SENTINEL_CART_ID = 'sentinel-cart-secret-99';
const SENTINEL_SESSION_ID = 'sentinel-session-secret-88';
const SENTINEL_TENANT_ID = 'sentinel-tenant-secret-77';
const SENTINEL_BRANCH_ID = 'sentinel-branch-secret-66';
const SENTINEL_TERMINAL_ID = 'sentinel-terminal-secret-55';
const SENTINEL_HANDOFF_ID = 'sentinel-handoff-action-44';
const SENTINEL_ITEM_REF = 'sentinel-item-ref-33';
const SENTINEL_LAST_ACTION = 'sentinel-last-action-22';
const SENTINEL_OP_ID = 'sentinel-op-secret-11';

function makeEnvelope(): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: SENTINEL_CART_ID,
    operator_session_id: SENTINEL_SESSION_ID,
    owning_operator_id: SENTINEL_OP_ID,
    tenant_id: SENTINEL_TENANT_ID,
    branch_id: SENTINEL_BRANCH_ID,
    terminal_id: SENTINEL_TERMINAL_ID,
    lines: [
      {
        line_id: 'line-1',
        item_ref: SENTINEL_ITEM_REF,
        display_name: 'Safe Display Name',
        quantity: 3,
        unit_price_minor: 200,
        line_subtotal_minor: 600,
        note: null,
        version: 7,
        last_action_id: SENTINEL_LAST_ACTION,
      },
    ],
    discount_placeholders: [],
    subtotal_minor: 600,
    created_at: '2026-05-21T10:00:00.000Z',
    handoff_action_id: SENTINEL_HANDOFF_ID,
  };
}

describe('OrderSummary — minimised safe render', () => {
  it('renders the component', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.getByTestId('payment-cart-summary')).toBeInTheDocument();
  });

  it('does not render cart_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_CART_ID);
  });

  it('does not render operator_session_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_SESSION_ID);
  });

  it('does not render tenant_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_TENANT_ID);
  });

  it('does not render branch_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_BRANCH_ID);
  });

  it('does not render terminal_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_TERMINAL_ID);
  });

  it('does not render handoff_action_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_HANDOFF_ID);
  });

  it('does not render item_ref in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_ITEM_REF);
  });

  it('does not render last_action_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_LAST_ACTION);
  });

  it('does not render owning_operator_id in the DOM', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(document.body.innerHTML).not.toContain(SENTINEL_OP_ID);
  });

  it('renders display_name (the safe field)', () => {
    render(<OrderSummary envelope={makeEnvelope()} />);
    expect(screen.getByText('Safe Display Name')).toBeInTheDocument();
  });
});
