/**
 * Shared fixtures for the pilot tender-gate tests: RT-103 (voucher) and RT-700
 * (card). A signed-in cashier, one mounted envelope, and a bridge whose
 * `payments.start` is a spy.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../../PaymentSurface.js';

export function makeEnvelope(): PaymentIntentEnvelope {
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
    subtotal_minor: 2500,
    created_at: '2026-09-30T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

type TestBridge = { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };

/** The bridge plus a direct handle on `payments.start` (asserted without unbinding). */
export function makeBridge(): { bridge: TestBridge; start: ReturnType<typeof vi.fn> } {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: 2500,
    started_at: '2026-09-30T09:59:00.000Z',
    tender_lines: [],
  };
  const start = vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' }));
  const bridge = {
    payments: {
      start,
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: attempt })),
      confirm: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-30T10:00:00.000Z' }),
      ),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    },
    tender: { apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })) },
  } as unknown as TestBridge;
  return { bridge, start };
}

/** The tender flags a test turns on; everything else stays at its fail-closed default. */
export interface TenderFlags {
  voucherTender?: boolean;
  cardTender?: boolean;
}

function seedSurface(flags: TenderFlags): void {
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
        started_at: '2026-09-30T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, ...flags });
}

/** Undo `pickTender` (call from `afterEach`). */
export function resetTenderSurface(): void {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
}

/** Mount PaymentSurface with the given flags, click one tender tile, return the start spy. */
export async function pickTender(
  flags: TenderFlags,
  tileTestId: string,
): Promise<ReturnType<typeof vi.fn>> {
  seedSurface(flags);
  const { bridge, start } = makeBridge();
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId(tileTestId).click();
    await Promise.resolve();
  });
  return start;
}
