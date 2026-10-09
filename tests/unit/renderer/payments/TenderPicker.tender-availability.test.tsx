/**
 * T021 — TenderPicker tender availability.
 *
 * Cash and external_card_terminal are enabled and selectable.
 * internal_voucher is always reserved (aria-disabled + "(not available)" sub-label).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('TenderPicker — cash', () => {
  it('renders a cash tender button that is enabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} />);
    const btn = screen.getByTestId('tender-cash');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('calls onTenderSelect with "cash" when clicked', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={handler} />);
    await user.click(screen.getByTestId('tender-cash'));
    expect(handler).toHaveBeenCalledWith('cash');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('TenderPicker — external_card_terminal', () => {
  it('renders an external card terminal button that is enabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} />);
    const btn = screen.getByTestId('tender-external-card');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('calls onTenderSelect with "external_card_terminal" when clicked', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={handler} />);
    await user.click(screen.getByTestId('tender-external-card'));
    expect(handler).toHaveBeenCalledWith('external_card_terminal');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('TenderPicker — internal_voucher (Wave 5c T291 — enabled configuration)', () => {
  // Wave 5c T291 — when the voucher tender is enabled, the slot routes to
  // <VoucherEntry> via onTenderSelect('internal_voucher'). RT-103: it is enabled
  // only by opt-in (`voucherEnabled`); the pilot default (disabled) is covered in
  // src/renderer/ui/payments/__tests__/voucher-pilot-restriction.test.tsx.

  it('renders the voucher slot as visible and enabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} voucherEnabled />);
    const btn = screen.getByTestId('tender-voucher');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('does NOT render the legacy "(not available)" sub-label', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} />);
    // The Slice-1 reserved-disabled hint element is gone.
    expect(screen.queryByTestId('tender-voucher-hint')).not.toBeInTheDocument();
  });

  it('calls onTenderSelect with "internal_voucher" when clicked', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={handler} voucherEnabled />);
    await user.click(screen.getByTestId('tender-voucher'));
    expect(handler).toHaveBeenCalledWith('internal_voucher');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('TenderPicker — touch targets', () => {
  /**
   * RT-243 W1-C — a SOURCE TRIPWIRE, not a cascade check: the tiles take their
   * size from checkout.css (DESIGN.md: 84px comfortable, 72px compact, never
   * under the 44px floor). jsdom does no layout; the packaged capture measures it.
   */
  const css = readFileSync(
    resolve(__dirname, '../../../../src/renderer/v5/checkout/checkout.css'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('declares the tile height for both densities, both above the 44px floor', () => {
    const sizes = [...css.matchAll(/\.v5-tender-tile\s*\{[^}]*min-block-size:\s*(\d+)px/g)].map(
      (m) => Number(m[1]),
    );
    expect(sizes).toEqual([84, 72]);
  });

  it('renders every tender as a tile the stylesheet sizes', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={() => {}} />);
    for (const id of ['tender-cash', 'tender-external-card', 'tender-voucher']) {
      expect(screen.getByTestId(id)).toHaveClass('v5-tender-tile');
    }
  });
});
