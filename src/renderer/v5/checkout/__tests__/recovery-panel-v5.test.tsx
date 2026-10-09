/**
 * RT-243 W1-C — the recovery side of Checkout on V5 (freeze 15 §4
 * `RecoveryPanel`, §5 M-P7 and M-P15–M-P20; 06 RecoveryPanel; RT-116 §3).
 *
 *   - M-P7: a cancel here does not void a charge on the standalone terminal.
 *     When one may stand, the cashier confirms first, with «رجوع» focused.
 *   - RecoveryPanel: the recovery lines in the pinned action bar, with the
 *     cancel-outcome-unknown line (M-P18) as a danger Notice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope';
import type {
  PaymentsBridgeAPI,
  PaymentsCancelResponse,
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
import { RecoveryPanel } from '../RecoveryPanel';

const DUE = 5_000;
const M_P7_TITLE = 'إلغاء الدفع هنا لا يلغي الخصم على جهاز البطاقات.';
const M_P7_BODY = 'ألغِ العملية على الجهاز أولاً، ثم أكّد.';
const CANCEL_UNKNOWN =
  'تعذّر التأكد من إلغاء عملية الدفع. لا تسجّل أي مبلغ. اضغط «إلغاء» مرة أخرى للتحقق.';
const CANCEL_FAILED = 'تعذّر إلغاء عملية الدفع. اضغط «إلغاء» للمحاولة مرة أخرى.';

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

interface Options {
  /** The card apply's answer never arrives (main may still have committed it). */
  readonly cardApplyLost?: boolean;
  /** What each cancel call does, in order; the last repeats. */
  readonly cancel?: readonly (() => Promise<PaymentsCancelResponse>)[];
  /** The read-back after a lost cancel fails too. */
  readonly readFailsAfterCancel?: boolean;
}

const CANCEL_OK = (reversed: string[]): (() => Promise<PaymentsCancelResponse>) => {
  return () =>
    Promise.resolve({
      kind: 'ok' as const,
      cancelled_at: '2026-10-09T09:02:00.000Z',
      reversed_tender_line_ids: reversed,
      reversal_pending_tender_line_ids: [],
    });
};

function makeBridge(opts: Options = {}): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  cancel: ReturnType<typeof vi.fn>;
} {
  let lines: TenderLineRendererView[] = [];
  let cancelCalls = 0;
  const steps = opts.cancel ?? [CANCEL_OK(['tl-1'])];
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: DUE,
    started_at: '2026-10-09T09:00:30.000Z',
    tender_lines: lines,
  });
  const cancel = vi.fn(() => {
    const step = steps[Math.min(cancelCalls, steps.length - 1)];
    cancelCalls += 1;
    return step === undefined ? Promise.reject(new Error('lost')) : step();
  });
  return {
    cancel,
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() =>
        cancelCalls > 0 && opts.readFailsAfterCancel === true
          ? Promise.resolve({ kind: 'refused' as const, reason: 'internal_error' })
          : Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() }),
      ),
      confirm: vi.fn(),
      cancel,
    } as unknown as PaymentsBridgeAPI,
    tender: {
      apply: vi.fn((req: TenderApplyRequest) => {
        if (req.tender_type === 'external_card_terminal' && opts.cardApplyLost === true) {
          return Promise.reject(new Error('response lost'));
        }
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
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el, { detail: 1 });
    await Promise.resolve();
  });
  await settle();
}

/** A full card line, recorded through the real card entry. */
async function recordCard(bridge: ReturnType<typeof makeBridge>): Promise<void> {
  render(<PaymentSurface _testBridge={bridge} />);
  await click(screen.getByTestId('tender-external-card'));
  await click(screen.getByTestId('external-card-confirm'));
}

/** A full cash line, recorded through the real cash entry. */
async function recordCash(bridge: ReturnType<typeof makeBridge>): Promise<void> {
  render(<PaymentSurface _testBridge={bridge} />);
  await click(screen.getByTestId('tender-cash'));
  fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '50' } });
  await click(screen.getByTestId('cash-entry-confirm'));
}

function dialog(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: M_P7_TITLE });
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

describe('M-P7 — confirm before cancelling when a card charge may stand (RT-116 §3)', () => {
  it('asks first after a card line, with the catalogue copy and «رجوع» focused', async () => {
    const bridge = makeBridge();
    await recordCard(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d).toHaveTextContent(M_P7_TITLE);
    expect(d).toHaveTextContent(M_P7_BODY);
    expect(d).toHaveAccessibleDescription(M_P7_BODY);
    expect(screen.getByRole('button', { name: 'رجوع' })).toHaveFocus();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('«رجوع» closes it and cancels nothing; the payment stays as it was', async () => {
    const bridge = makeBridge();
    await recordCard(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    await click(screen.getByRole('button', { name: 'رجوع' }));
    expect(dialog()).toBeNull();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
  });

  it('Esc closes it like «رجوع» and goes no further (not Back, not the entry)', async () => {
    const bridge = makeBridge();
    await recordCard(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    const d = dialog();
    if (d === null) throw new Error('expected the M-P7 dialog');
    await act(async () => {
      fireEvent.keyDown(d, { key: 'Escape' });
      await Promise.resolve();
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('payment-surface-entry')).toBeInTheDocument();
  });

  it('«تأكيد الإلغاء» sends the one cancel, and the terminal-void fact (M-P13) is set', async () => {
    // The M-P13 line itself renders with Back (the route); RT-256's suite owns it.
    const bridge = makeBridge();
    await recordCard(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    await click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(dialog()).toBeNull();
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(usePaymentStore.getState().cardSafety?.voidRequired).toBe(true);
  });

  it('asks too after a card apply whose answer was lost (the charge may stand, RT-256)', async () => {
    const bridge = makeBridge({ cardApplyLost: true });
    await recordCard(bridge);
    expect(usePaymentStore.getState().cardSafety?.cardApplyAttempted).toBe(true);
    await click(screen.getByTestId('payment-surface-cancel'));
    expect(dialog()).not.toBeNull();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('does not ask for a cash-only cancel: nothing stands on a terminal', async () => {
    const bridge = makeBridge({ cancel: [CANCEL_OK(['tl-1'])] });
    await recordCash(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    expect(dialog()).toBeNull();
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not ask again for the retry of a cancel already sent (the same key replays)', async () => {
    const lost = (): Promise<PaymentsCancelResponse> => Promise.reject(new Error('lost'));
    const bridge = makeBridge({ cancel: [lost, CANCEL_OK(['tl-1'])], readFailsAfterCancel: true });
    await recordCard(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    await click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(CANCEL_UNKNOWN);
    await click(screen.getByTestId('payment-surface-cancel'));
    expect(dialog()).toBeNull();
    expect(bridge.cancel).toHaveBeenCalledTimes(2);
  });

  it('is axe-clean with the confirm open', async () => {
    await recordCard(makeBridge());
    await click(screen.getByTestId('payment-surface-cancel'));
    await expectNoAxeViolations(document.body);
  });
});

describe('RecoveryPanel — the recovery lines, toned by what they mean', () => {
  it('renders nothing when there is nothing to recover', () => {
    const { container } = render(
      <RecoveryPanel refusal={null} refusalIsUnknownOutcome={false} reversalPending={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('M-P18 (cancel outcome unknown) is a danger Notice, announced as an alert', () => {
    render(
      <RecoveryPanel
        refusal={CANCEL_UNKNOWN}
        refusalIsUnknownOutcome
        reversalPending={false}
        testIds={{ refusal: 'refusal' }}
      />,
    );
    const line = screen.getByTestId('refusal');
    expect(line).toHaveAttribute('data-tone', 'danger');
    expect(line).toHaveAttribute('role', 'alert');
    expect(line).toHaveTextContent(CANCEL_UNKNOWN);
  });

  it('any other refusal is a neutral status line (M-P17, M-P19, M-P20)', () => {
    render(
      <RecoveryPanel
        refusal={CANCEL_FAILED}
        refusalIsUnknownOutcome={false}
        reversalPending={false}
        testIds={{ refusal: 'refusal' }}
      />,
    );
    const line = screen.getByTestId('refusal');
    expect(line).not.toHaveAttribute('data-tone');
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveTextContent(CANCEL_FAILED);
  });

  it('a pending reversal is an info Notice (recorded, not proven)', () => {
    render(
      <RecoveryPanel
        refusal={null}
        refusalIsUnknownOutcome={false}
        reversalPending
        testIds={{ reversalPending: 'pending' }}
      />,
    );
    expect(screen.getByTestId('pending')).toHaveAttribute('data-tone', 'info');
  });

  it('in Checkout, the unknown-outcome line sits in the pinned action bar as danger', async () => {
    const lost = (): Promise<PaymentsCancelResponse> => Promise.reject(new Error('lost'));
    const bridge = makeBridge({ cancel: [lost], readFailsAfterCancel: true });
    await recordCash(bridge);
    await click(screen.getByTestId('payment-surface-cancel'));
    const line = screen.getByTestId('payment-surface-bridge-refusal');
    expect(line).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByTestId('payment-surface-actions')).toContainElement(line);
    await expectNoAxeViolations(document.body);
  });
});

describe('recovery CSS — tripwires (jsdom loads no CSS)', () => {
  const css = readFileSync(resolve(__dirname, '../checkout.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('the plain refusal line is styled neutral (no tone colour of its own)', () => {
    const rule = /\.v5-recovery__line\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--color-text\)/);
    expect(rule).not.toMatch(/danger|warning|success/);
  });
});
