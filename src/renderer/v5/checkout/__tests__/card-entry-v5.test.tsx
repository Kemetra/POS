/**
 * RT-243 W1-C — the card terminal entry on V5 (freeze 15 §2 S10; 06
 * `CardTerminalEntry`; 08 I-10; VN-R4), inside `PaymentSurface`.
 *
 * The entry records a charge the cashier made on the standalone terminal: the
 * M-P6 instruction, the amount (exactly what is owed, a fact rather than a
 * field) and the optional 0–6 character reference. These tests pin the request
 * it sends, where the result appears (the pinned ledger), split tender after
 * cash, axe, and the CSS that jsdom cannot see.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope';
import type {
  PaymentsBridgeAPI,
  TenderApplyRequest,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api';
import type {
  PaymentAttemptRendererView,
  TenderLineRendererView,
} from '../../../../shared/payments/types';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { usePaymentStore } from '../../../stores/payment-store';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';
import { PaymentSurface } from '../../../ui/payments/PaymentSurface';

const DUE = 37_500; // 375.00 EGP

function envelope(): PaymentIntentEnvelope {
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
        line_id: 'line-0',
        item_ref: 'item-0',
        display_name: 'صنف 1',
        quantity: 1,
        unit_price_minor: DUE,
        line_subtotal_minor: DUE,
        note: null,
        version: 1,
        last_action_id: 'act-0',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: DUE,
    created_at: '2026-10-09T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

/** Main-like bridge: each apply records a line of its tender type that `read` projects back. */
function makeBridge(): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  applied: TenderApplyRequest[];
} {
  const applied: TenderApplyRequest[] = [];
  let lines: TenderLineRendererView[] = [];
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: DUE,
    started_at: '2026-10-09T09:00:30.000Z',
    tender_lines: lines,
  });
  return {
    applied,
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() })),
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as PaymentsBridgeAPI,
    tender: {
      apply: vi.fn((req: TenderApplyRequest) => {
        applied.push(req);
        lines = [
          ...lines,
          {
            tender_line_id: `tl-${String(lines.length + 1)}`,
            tender_type: req.tender_type,
            state: 'applied',
            amount_applied_minor: req.amount_applied_minor,
            applied_at: '2026-10-09T09:01:00.000Z',
            apply_order: lines.length + 1,
          },
        ];
        return Promise.resolve({
          kind: 'ok' as const,
          tender_line_id: `tl-${String(lines.length)}`,
          applied_at: '2026-10-09T09:01:00.000Z',
        });
      }),
    } as unknown as TenderBridgeAPI,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function pick(testId: string): Promise<void> {
  await act(async () => {
    screen.getByTestId(testId).click();
    await Promise.resolve();
  });
  await settle();
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
    await Promise.resolve();
  });
  await settle();
}

function ledger(): HTMLElement {
  return screen.getByRole('region', { name: 'المبلغ المستحق' });
}

beforeEach(() => {
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
        started_at: '2026-10-09T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(envelope());
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization: true,
    productSearch: true,
  });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('CardTerminalEntry in Checkout (S10)', () => {
  it('shows the instruction, the amount owed and the optional reference; nothing else to type', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    await pick('tender-external-card');
    const entry = screen.getByTestId('external-card-terminal-entry');
    expect(within(entry).getByTestId('external-card-instruction')).toHaveTextContent(
      'أكمل العملية على جهاز البطاقات، ثم سجّل النتيجة.',
    );
    expect(within(entry).getByTestId('external-card-amount-value')).toHaveTextContent('375.00 EGP');
    expect(within(entry).getAllByRole('textbox')).toEqual([
      screen.getByLabelText('المرجع (اختياري، حتى 6 خانات)'),
    ]);
    // The record-result commit is pinned in the money column (RT-238).
    expect(within(ledger()).getByTestId('external-card-confirm')).toBeEnabled();
  });

  it('records exactly the amount owed, with the reference when given', async () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await pick('tender-external-card');
    fireEvent.change(screen.getByTestId('external-card-reference-input'), {
      target: { value: 'A1B2C3' },
    });
    await click('external-card-confirm');
    expect(bridge.applied).toHaveLength(1);
    expect(bridge.applied[0]).toMatchObject({
      tender_type: 'external_card_terminal',
      amount_applied_minor: DUE,
      external_reference: 'A1B2C3',
    });
  });

  it('blocks the record while the reference is malformed, and says why next to the field', async () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await pick('tender-external-card');
    const field = screen.getByTestId('external-card-reference-input');
    fireEvent.change(field, { target: { value: 'ab' } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('external-card-confirm')).toBeDisabled();
    await click('external-card-confirm');
    expect(bridge.applied).toHaveLength(0);
  });

  it('after the record, the card line is recorded money in the pinned ledger and the due is zero', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    await pick('tender-external-card');
    await click('external-card-confirm');
    const recorded = within(ledger()).getByTestId('payment-ledger');
    expect(recorded).toHaveTextContent('بطاقة');
    expect(recorded).toHaveTextContent('375.00 EGP');
    expect(within(ledger()).getByTestId('payment-surface-amount-due')).toHaveTextContent(
      '0.00 EGP',
    );
    // No change and no cash preview on a card line.
    expect(screen.queryByTestId('payment-ledger-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
  });

  it('after a partial cash apply, the card records what is still owed (split tender)', async () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await pick('tender-cash');
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '100' } });
    await click('cash-entry-confirm');
    await pick('tender-external-card');
    expect(screen.getByTestId('external-card-amount-value')).toHaveTextContent('275.00 EGP');
    await click('external-card-confirm');
    expect(bridge.applied.map((r) => [r.tender_type, r.amount_applied_minor])).toEqual([
      ['cash', 10_000],
      ['external_card_terminal', 27_500],
    ]);
  });

  it('is axe-clean, with and without a reference error', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    await pick('tender-external-card');
    await expectNoAxeViolations(document.body);
    fireEvent.change(screen.getByTestId('external-card-reference-input'), {
      target: { value: 'ab' },
    });
    await expectNoAxeViolations(document.body);
  });
});

describe('card entry CSS — tripwires (jsdom loads no CSS)', () => {
  const css = readFileSync(resolve(__dirname, '../checkout.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));

  it('the reference field keeps a system border under forced colours', () => {
    expect(forced).toMatch(/\.v5-card__input\s*\{[^}]*ButtonText/);
  });

  it('an invalid reference is marked by more than colour under forced colours', () => {
    expect(forced).toMatch(
      /\.v5-card__input\[aria-invalid='true'\]\s*\{[^}]*border-style:\s*dashed/,
    );
  });

  it('the reference field draws no focus treatment over the frame ring', () => {
    expect(css).not.toMatch(/\.v5-card__input[^{]*:focus-visible/);
    expect(css).not.toMatch(/\.v5-card__input:focus\s*\{[^}]*outline:\s*(none|0)/);
  });
});
