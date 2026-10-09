/**
 * RT-103 — the internal voucher tender is unavailable in the pilot cashier UI.
 *
 * RT-10 D2: vouchers are excluded from the pilot. RT-79 already fails closed on the
 * sync side (a voucher-tendered sale is dead-lettered, never sent as another method);
 * this locks the cashier surface so such a sale cannot be started in the first place.
 *
 * The restriction is the DEFAULT: `voucherTender` is a fail-closed feature flag
 * (`POS_PULSE_FEATURE_VOUCHER_TENDER`). With it off the voucher tile renders but is
 * disabled — not clickable, not keyboard-reachable — and PaymentSurface refuses a
 * voucher selection and never mounts VoucherEntry. Cash and external card are unchanged.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { TenderPicker } from '../../../v5/checkout/TenderPicker.js';

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
function makeBridge(): { bridge: TestBridge; start: ReturnType<typeof vi.fn> } {
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

function seedSurface(voucherTender: boolean): void {
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
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, voucherTender });
}

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('RT-103 TenderPicker — pilot restriction (default)', () => {
  it('renders the voucher tile disabled, and cash + card enabled', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.getByTestId('tender-voucher')).toBeDisabled();
    expect(screen.getByTestId('tender-voucher')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('tender-cash')).toBeEnabled();
    expect(screen.getByTestId('tender-external-card')).toBeEnabled();
  });

  it('a click on the voucher tile never selects the voucher tender', async () => {
    const onTenderSelect = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} />);
    await userEvent.click(screen.getByTestId('tender-voucher'));
    expect(onTenderSelect).not.toHaveBeenCalled();
  });

  it('the keyboard path cannot reach or invoke the voucher tender', async () => {
    const onTenderSelect = vi.fn();
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} />);
    const user = userEvent.setup();
    const reached: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      await user.tab();
      reached.push(document.activeElement?.getAttribute('data-testid') ?? null);
      await user.keyboard('{Enter}');
    }
    expect(reached).not.toContain('tender-voucher');
    const selected = onTenderSelect.mock.calls.map((c: unknown[]) => c[0]);
    expect(selected).not.toContain('internal_voucher');
    // Cash and card stay keyboard-operable.
    expect(selected).toEqual(expect.arrayContaining(['cash', 'external_card_terminal']));
  });

  it('tells the cashier the voucher is unavailable (not a silent dead tile)', () => {
    render(<TenderPicker envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.getByTestId('tender-voucher')).toHaveTextContent('غير متاحة حاليًا');
  });
});

describe('RT-103 TenderPicker — voucher explicitly enabled', () => {
  it('the voucher tile is enabled and selects internal_voucher', async () => {
    const onTenderSelect = vi.fn();
    render(
      <TenderPicker envelope={makeEnvelope()} onTenderSelect={onTenderSelect} voucherEnabled />,
    );
    const voucher = screen.getByTestId('tender-voucher');
    expect(voucher).toBeEnabled();
    await userEvent.click(voucher);
    expect(onTenderSelect).toHaveBeenCalledWith('internal_voucher');
  });
});

/** Mount PaymentSurface with the given flag, click one tender tile, return the start spy. */
async function pickTender(
  voucherTender: boolean,
  tileTestId: string,
): Promise<ReturnType<typeof vi.fn>> {
  seedSurface(voucherTender);
  const { bridge, start } = makeBridge();
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId(tileTestId).click();
    await Promise.resolve();
  });
  return start;
}

describe('RT-103 PaymentSurface — pilot restriction from the voucherTender flag', () => {
  it('flag off: selecting the voucher starts no payment and mounts no VoucherEntry', async () => {
    const start = await pickTender(false, 'tender-voucher');
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voucher-entry-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('tender-voucher')).toBeDisabled();
  });

  it.each([
    ['flag off: cash still starts the payment', false, 'tender-cash', 'cash-entry'],
    ['flag on: the voucher starts the payment', true, 'tender-voucher', 'voucher-entry-confirm'],
  ])('%s and mounts its entry', async (_name, voucherTender, tile, entryTestId) => {
    const start = await pickTender(voucherTender, tile);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId(entryTestId)).toBeInTheDocument();
  });
});
