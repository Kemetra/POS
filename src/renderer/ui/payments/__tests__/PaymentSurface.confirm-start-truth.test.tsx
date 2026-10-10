/**
 * RT-340 / RT-341 — Checkout never says more than main has shown.
 *
 * RT-340: a confirm that main refused, or whose answer was lost, used to show
 * «… يرجى المحاولة مرة أخرى.» whatever the reason, including `attempt_terminal`
 * for an attempt main had already settled. The surface now reads main and
 * follows it: settled → Completion (no remount needed); ended → dropped; still
 * open → a line that only invites a retry when a retry can succeed.
 *
 * RT-341: after a successful `payments.start`, a failed read showed «تعذّر بدء
 * عملية الدفع» although main held a started attempt, and a refused read was
 * ignored. Both now keep apply and settle out of reach and offer the read
 * retry until main has been read.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type {
  PaymentAttemptRendererView,
  RefusalReason,
  TenderLineRendererView,
} from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  PaymentsReadResponse,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

const TRY_AGAIN = 'يرجى المحاولة مرة أخرى';
const COULD_NOT_START = 'تعذّر بدء عملية الدفع';

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 1300,
  created_at: '2026-10-10T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

function cash(amount: number): TenderLineRendererView {
  return {
    tender_line_id: 'tl-1',
    tender_type: 'cash',
    state: 'applied',
    amount_applied_minor: amount,
    applied_at: '2026-10-10T09:01:00.000Z',
    apply_order: 1,
  };
}

const FULL_CASH = [cash(1300)];

function attempt(
  state: PaymentAttemptRendererView['state'],
  lines: readonly TenderLineRendererView[] = FULL_CASH,
): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state,
    envelope_subtotal_minor: ENVELOPE.subtotal_minor,
    started_at: '2026-10-10T09:00:30.000Z',
    ...(state === 'settled' ? { settled_at: '2026-10-10T09:02:00.000Z' } : {}),
    tender_lines: lines,
  };
}

const ok = (a: PaymentAttemptRendererView): PaymentsReadResponse => ({
  kind: 'ok',
  payment_attempt: a,
});

interface Harness {
  readonly bridge: { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
  readonly read: Mock<PaymentsBridgeAPI['read']>;
  readonly confirm: Mock<PaymentsBridgeAPI['confirm']>;
}

function makeHarness(): Harness {
  const read = vi.fn<PaymentsBridgeAPI['read']>(() => Promise.resolve(ok(attempt('started'))));
  const confirm = vi.fn<PaymentsBridgeAPI['confirm']>();
  return {
    read,
    confirm,
    bridge: {
      payments: {
        start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
        read,
        confirm,
        cancel: vi.fn(),
      } as unknown as PaymentsBridgeAPI,
      tender: { apply: vi.fn() } as unknown as TenderBridgeAPI,
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

async function pickCash(h: Harness): Promise<void> {
  render(
    <PaymentSurface
      _testBridge={h.bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await settle();
}

async function pressConfirm(): Promise<void> {
  await act(async () => {
    screen.getByTestId('payment-surface-confirm').click();
    await Promise.resolve();
  });
  await settle();
}

function refusalText(): string {
  return screen.queryByTestId('payment-surface-bridge-refusal')?.textContent ?? '';
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
        started_at: '2026-10-10T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(ENVELOPE);
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

describe('RT-340 — a refused or lost confirm follows main', () => {
  it('a lost confirm answer while main settled ends on Completion, without a remount', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockRejectedValueOnce(new Error('ipc lost'));
    h.read.mockResolvedValue(ok(attempt('settled')));

    await pressConfirm();

    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('settled');
    expect(document.body.textContent).not.toContain(TRY_AGAIN);
  });

  it('attempt_terminal on a settled attempt ends on Completion, never «try again»', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'attempt_terminal' });
    h.read.mockResolvedValue(ok(attempt('settled')));

    await pressConfirm();

    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TRY_AGAIN);
  });

  it('an attempt that ended another way is dropped, with no retry offered', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'attempt_terminal' });
    h.read.mockResolvedValue(ok(attempt('cancelled')));

    await pressConfirm();

    expect(usePaymentStore.getState().paymentSlice).toBeNull();
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
    expect(refusalText()).toContain('انتهت عملية الدفع هذه دون أن تكتمل');
    expect(refusalText()).not.toContain(TRY_AGAIN);
  });

  it('tender_underpaid refreshes the projection; the commit reason explains, not «try again»', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'tender_underpaid' });
    h.read.mockResolvedValue(ok(attempt('started', [cash(500)])));

    await pressConfirm();

    expect(refusalText()).not.toContain(TRY_AGAIN);
    expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent('8.00');
  });

  it('tender_underpaid while main still shows the sale fully tendered is never silent', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'tender_underpaid' });
    h.read.mockResolvedValue(ok(attempt('started')));

    await pressConfirm();

    // The commit is still offered, so the refusal must say something.
    expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    expect(refusalText()).not.toBe('');
  });

  // M-P26 for role / owner / tenant; M-P28 (sign in again) when main's session ended.
  it.each<[RefusalReason, string]>([
    ['no_session', 'انتهت الجلسة. سجّل الدخول من جديد ثم أكمل الدفع.'],
    ['role_denied', 'لا يمكن إتمام هذا الدفع من هذه الجلسة'],
    ['wrong_owner', 'لا يمكن إتمام هذا الدفع من هذه الجلسة'],
    ['tenant_isolation', 'لا يمكن إتمام هذا الدفع من هذه الجلسة'],
  ])(
    '%s names who can act, never «try again» and never a read retry that cannot succeed',
    async (reason, copy) => {
      const h = makeHarness();
      await pickCash(h);
      const readsBefore = h.read.mock.calls.length;
      h.confirm.mockResolvedValueOnce({ kind: 'refused', reason });
      // payments.read passes the same session gate, so main refuses it too.
      h.read.mockResolvedValue({ kind: 'refused', reason });

      await pressConfirm();

      expect(refusalText()).toContain(copy);
      expect(refusalText()).not.toContain(TRY_AGAIN);
      expect(screen.queryByTestId('payment-surface-reread')).not.toBeInTheDocument();
      expect(h.read.mock.calls.length).toBe(readsBefore);
    },
  );

  it('a refusal a retry can clear keeps «try again» while main still holds the attempt open', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'internal_error' });
    h.read.mockResolvedValue(ok(attempt('started')));

    await pressConfirm();

    expect(refusalText()).toContain(TRY_AGAIN);
    expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
  });

  it('a lost confirm with a lost read offers the read retry, never the commit', async () => {
    const h = makeHarness();
    await pickCash(h);
    h.confirm.mockRejectedValueOnce(new Error('ipc lost'));
    h.read.mockRejectedValue(new Error('ipc lost'));

    await pressConfirm();

    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-reread')).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-reread-notice')).toHaveTextContent('لا تكرر الدفع');
    expect(document.body.textContent).not.toContain(TRY_AGAIN);

    // The retry follows main: the settle had landed, so Completion.
    h.read.mockResolvedValue(ok(attempt('settled')));
    await act(async () => {
      screen.getByTestId('payment-surface-reread').click();
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
  });
});

describe('RT-341 — a started attempt is never reported as «could not start»', () => {
  it.each([
    ['throws', (): Promise<PaymentsReadResponse> => Promise.reject(new Error('ipc lost'))],
    [
      'is refused',
      (): Promise<PaymentsReadResponse> =>
        Promise.resolve({ kind: 'refused', reason: 'internal_error' }),
    ],
  ] as const)(
    'when the read after a successful start %s: read retry, no apply, no «could not start»',
    async (_label, failingRead) => {
      const h = makeHarness();
      h.read.mockImplementation(failingRead);
      await pickCash(h);

      expect(document.body.textContent).not.toContain(COULD_NOT_START);
      expect(screen.queryByTestId('cash-entry-confirm')).not.toBeInTheDocument();
      expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
      expect(screen.getByTestId('payment-surface-reread')).toBeInTheDocument();
      const notice = screen.getByTestId('payment-surface-reread-notice');
      expect(notice).toHaveTextContent('بدأت عملية الدفع');
      // No amount is recorded yet, so M-P15's «تم تسجيل المبلغ» would be untrue.
      expect(notice).not.toHaveTextContent('تم تسجيل المبلغ');
      // Main holds the started attempt, so the store must too (sign-out stays blocked).
      expect(usePaymentStore.getState().paymentSlice?.payment_attempt_id).toBe('pa-001');
    },
  );

  it('no apply is offered while the read after a start is still pending', async () => {
    const h = makeHarness();
    h.read.mockImplementation(() => new Promise<PaymentsReadResponse>(() => undefined));
    await pickCash(h);

    expect(screen.queryByTestId('cash-entry-confirm')).not.toBeInTheDocument();
  });

  it('the retry reads main and opens the cash entry as it stood', async () => {
    const h = makeHarness();
    h.read.mockRejectedValue(new Error('ipc lost'));
    await pickCash(h);

    h.read.mockResolvedValue(ok(attempt('started', [])));
    await act(async () => {
      screen.getByTestId('payment-surface-reread').click();
      await Promise.resolve();
    });
    await settle();

    expect(screen.queryByTestId('payment-surface-reread')).not.toBeInTheDocument();
    expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    expect(screen.getByTestId('cash-entry-confirm')).toBeInTheDocument();
  });
});
