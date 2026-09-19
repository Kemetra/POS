/**
 * 022-pos-ui-v4-rescue — US4a: Sale-success honesty (TDD RED→GREEN).
 *
 * Covers T010/T012/T013a/T014/T016/T018/T019/T019a. The load-bearing idea is
 * NFR-6 / P2 (truthfulness): `setPhase('settled')` fires on `payments.confirm`
 * alone — BEFORE the AD-2 worker finalizes the sale. So the settled phase has
 * two genuinely different meanings, and the copy must not blur them:
 *
 *   (a) payment settled, sale NOT yet finalized  → say exactly that.
 *       No "sale complete" claim, no receipt, no fabricated sale number.
 *   (b) sale finalized (recent.finalized_at >= settled_at) → the Arabic-first
 *       success state, with the settled amount dominant and ReceiptPreview
 *       mounted for the retained sale_id.
 *
 * Neither state is an error. The distinction is *what the system knows*.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  ReceiptsBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

const SETTLED_AT = '2026-09-19T10:00:00.000Z';
const FINALIZED_AT = '2026-09-19T10:00:00.400Z';
const STALE_FINALIZED_AT = '2026-09-19T09:59:00.000Z';
const SALE_ID = '11111111-2222-4333-8444-555555555555';
const SALE_NUMBER = 'S-000042';

function makeEnvelope(subtotalMinor = 5000): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: subtotalMinor,
    created_at: '2026-09-19T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function signIn(): void {
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
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
}

interface RecentFixture {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
}

type TestBridge = {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales?: SalesBridgeAPI;
};

/**
 * ReceiptPreview resolves `window.api.receipts` on its own — that is the ONLY
 * path in production, so the test installs a receipts bridge there rather than
 * injecting a prop. Without it ReceiptPreview falls into its role="alert"
 * error state, which must never appear inside the success surface.
 */
function installReceiptsBridge(): void {
  const receipts = {
    preview: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        preview: { html: '<p>receipt</p>' },
      }),
    ),
  } as unknown as ReceiptsBridgeAPI;
  (window as unknown as { api?: { receipts: ReceiptsBridgeAPI } }).api = { receipts };
}

/**
 * A bridge whose `payments.confirm` settles, and whose `sales.subscribe`
 * returns whatever `recent` the test supplies. `recent: null` models the
 * not-yet-finalized window (a); a recent with finalized_at >= settled_at
 * models the finalized state (b).
 */
function makeBridge(
  recent: RecentFixture | null,
  opts: { salesThrows?: boolean; omitSales?: boolean } = {},
): TestBridge {
  const payments = {
    start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
    confirm: vi.fn(() => Promise.resolve({ kind: 'ok' as const, settled_at: SETTLED_AT })),
    cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as PaymentsBridgeAPI;

  const tender = {
    apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as TenderBridgeAPI;

  const sales = {
    subscribe: vi.fn(() => {
      if (opts.salesThrows === true) return Promise.reject(new Error('bridge down'));
      return Promise.resolve({ kind: 'ok' as const, recent });
    }),
  } as unknown as SalesBridgeAPI;

  return opts.omitSales === true ? { payments, tender } : { payments, tender, sales };
}

/**
 * An attempt snapshot carrying one applied cash line. `hasAppliedLine` is what
 * makes the confirm button render, which is how the test reaches the settled
 * phase.
 */
function makeAttemptSnapshot(): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: 5000,
    started_at: '2026-09-19T09:59:00.000Z',
    tender_lines: [
      {
        tender_line_id: 'tl-001',
        tender_type: 'cash',
        state: 'applied',
        amount_applied_minor: 5000,
        applied_at: '2026-09-19T09:59:30.000Z',
        apply_order: 1,
      },
    ],
  };
}

/**
 * Drive PaymentSurface into the settled phase the way the cashier does:
 * render, then confirm through the surface's own confirm button, so the test
 * exercises the real `setSettledAt` → poll → render sequence rather than
 * poking component state.
 *
 * The snapshot is seeded AFTER render on purpose: PaymentSurface's mount
 * effect calls `clearAttempt()` (to stop a stale tender banner carrying across
 * a new attempt), so a slice seeded before render would be wiped on the first
 * effect pass and the confirm button would never appear.
 */
async function renderSettled(bridge: TestBridge, onNewSale?: () => void): Promise<void> {
  render(
    onNewSale === undefined ? (
      <PaymentSurface _testBridge={bridge} />
    ) : (
      <PaymentSurface _testBridge={bridge} onNewSale={onNewSale} />
    ),
  );
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(makeAttemptSnapshot());
  });
  const confirm = await screen.findByTestId('payment-surface-confirm');
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  signIn();
  installReceiptsBridge();
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization: true,
    productSearch: true,
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// T010 — retain sale_id (the enabling change)
// ---------------------------------------------------------------------------

describe('US4a T010 — PaymentSurface retains sale_id from the recent poll', () => {
  it('retains the finalized sale_id, not only the sale_number', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);
    // Review round 2: the id no longer drives any renderable CLAIM — the
    // terminal cannot tie the finalized record to this payment, so it never
    // asserts completion. The observable consequence of a resolved poll is
    // the quotable number, shown outside any success frame.
    expect(await screen.findByTestId('payment-surface-sale-number')).toHaveTextContent(SALE_NUMBER);
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
  });

  it('ignores a STALE recent snapshot (finalized_at < settled_at)', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: STALE_FINALIZED_AT,
    });
    await renderSettled(bridge);
    // A prior sale's snapshot must never be adopted as this sale's result.
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
    expect(screen.queryByText(SALE_NUMBER)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T012 — Arabic-first completion copy
// ---------------------------------------------------------------------------

describe('US4a T012 — Arabic-first completion copy', () => {
  it('renders Arabic primary copy and no English-only operator strings', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);

    const surface = await screen.findByTestId('payment-surface');
    // The superseded English strings must be gone.
    expect(surface).not.toHaveTextContent('Payment settled.');
    expect(surface).not.toHaveTextContent('New sale');
    // Arabic-first: success statement, reference label, next action.
    expect(surface.textContent).toMatch(/[؀-ۿ]/u);
    expect(screen.getByTestId('payment-surface-new-sale').textContent).toMatch(/[؀-ۿ]/u);
  });

  it('keeps the sale number dir="ltr" (FR-21)', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);
    const num = await screen.findByTestId('payment-surface-sale-number');
    expect(num).toHaveAttribute('dir', 'ltr');
    expect(num).toHaveTextContent(SALE_NUMBER);
  });
});

// ---------------------------------------------------------------------------
// T013a — the two truthful states (NFR-6 / P2 — load-bearing)
// ---------------------------------------------------------------------------

describe('US4a T013a — two truthful settled states', () => {
  it('(a) payment settled but sale NOT finalized: no success claim, no receipt, no sale number', async () => {
    const bridge = makeBridge(null);
    await renderSettled(bridge);

    const pending = await screen.findByTestId('payment-surface-settled-pending');
    expect(pending).toBeInTheDocument();
    expect(pending.textContent).toMatch(/[؀-ۿ]/u);

    // Nothing may claim the sale is complete, and nothing may be fabricated.
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-receipt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
  });

  it('(b) a returned recent row yields a NUMBER but never a completion claim', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);

    // EXTERNAL REVIEW P1 (round 2): a prior sale finalizing late satisfies the
    // only available check, so the row cannot prove THIS sale completed. The
    // surface stays on the one state it can support and shows the number
    // outside any success frame — exactly as `main` did.
    expect(await screen.findByTestId('payment-surface-settled-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-sale-number')).toHaveTextContent(SALE_NUMBER);
  });

  it('both states are non-error: the pending state never uses role="alert"', async () => {
    const bridge = makeBridge(null);
    await renderSettled(bridge);
    const pending = await screen.findByTestId('payment-surface-settled-pending');
    expect(pending).not.toHaveAttribute('role', 'alert');
  });
});

// ---------------------------------------------------------------------------
// T014 — totals hierarchy (FR-16)
// ---------------------------------------------------------------------------

describe('US4a T014 — settled amount is the dominant numeric element', () => {
  it('renders the settled amount with the dominant class and dir="ltr" isolation', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);

    const amount = await screen.findByTestId('payment-surface-settled-amount');
    expect(amount).toHaveAttribute('dir', 'ltr');
    expect(amount.className).toContain('payment-surface__settled-amount');
  });
});

// ---------------------------------------------------------------------------
// T016 — mount the existing receipt
// ---------------------------------------------------------------------------

describe('US4a T016 (REVISED) — the receipt is NOT mounted on an uncorrelated sale', () => {
  /**
   * CODEX REVIEW P1 — "Correlate the finalized receipt to this payment".
   *
   * The `recent` projection is terminal-scoped and carries NO payment,
   * attempt or envelope identifier (`RecentSaleSummary` = sale_id +
   * sale_number + finalized_at), and `payments.confirm` returns only
   * `settled_at`. So `finalized_at >= settled_at` is the ONLY discriminator
   * available renderer-side — and a PRIOR sale that finalizes late (a worker
   * retry succeeding while this sale is still delayed) satisfies it.
   *
   * That gap PRE-DATES this slice: `main` already displayed `settledSaleNumber`
   * from the same unverified `recent` (006 invariant 13). What US4a added was a
   * RECEIPT for a sale the terminal cannot prove is this one — turning a wrong
   * number into the previous customer's full receipt document.
   *
   * There is no renderer-only correlation fix: the needed key does not exist on
   * the wire, and adding one is a bridge change (P8 forbids it in 022). Any
   * tighter time window or amount-match would be a heuristic dressed as a fix,
   * which is precisely what this slice exists to refuse.
   *
   * So we UN-AMPLIFY: the receipt is not mounted. The sale number still shows,
   * exactly as on `main` — no better, but no worse. T017 is untieked and the
   * correlation gap is filed for the backend/spec (011 already derives an
   * identifier from `envelope_handoff_action_id`, so the key exists main-side).
   */
  it('does NOT mount ReceiptPreview — the sale cannot be correlated to this payment', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);
    // No receipt, and (round 2) no completion claim either — both rested on
    // the same uncorrelated row.
    expect(await screen.findByTestId('payment-surface-settled-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-receipt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('receipt-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
  });

  it('never renders the internal sale UUID anywhere in the DOM (FR-035)', async () => {
    // CODEX REVIEW P2 — the UUID reached ReceiptPreview's aria-label. With the
    // receipt unmounted it cannot leak at all; this asserts the whole surface,
    // including accessible names, so a future re-mount cannot reintroduce it.
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);
    const surface = await screen.findByTestId('payment-surface');
    expect(surface.innerHTML).not.toContain(SALE_ID);
    for (const el of Array.from(surface.querySelectorAll('[aria-label]'))) {
      expect(el.getAttribute('aria-label') ?? '').not.toContain(SALE_ID);
    }
  });

  it('still shows the cashier-quotable sale number (unchanged from main)', async () => {
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge);
    expect(await screen.findByTestId('payment-surface-sale-number')).toHaveTextContent(SALE_NUMBER);
  });
});

// ---------------------------------------------------------------------------
// T018 — honest degradation when saleFinalization is OFF
// ---------------------------------------------------------------------------

describe('US4a T018 — saleFinalization OFF degrades honestly', () => {
  /**
   * PRODUCTION REALITY (verified in src/main/index.ts:441 + :983): the flag
   * gates the WHOLE 008 stack — the finalize worker, the read-only `sales.*`
   * bridge and `receipts.preview` are all registered inside
   * `if (features.saleFinalization === true)`. So with the flag off:
   * 006 still settles the payment, but 008's finalize listener short-circuits
   * — the sale record is NEVER written and the recent-sale poll can never
   * return one.
   *
   * The honest state is therefore TERMINAL, not transitional: the money was
   * taken; no sale record and no receipt will exist for it. Saying "the sale
   * is being recorded" would be a fake-PENDING claim — the same dishonesty as
   * a fake success, pointed the other way.
   */
  it('says the payment was taken and does NOT claim the sale is being recorded', async () => {
    useFeatureFlagsStore.getState().hydrate({
      cart: true,
      payments: true,
      saleFinalization: false,
      productSearch: true,
    });
    // No sales bridge — production's flag-off shape, since the sales bridge is
    // registered only inside the flag gate.
    const bridge = makeBridge(null, { omitSales: true });
    await renderSettled(bridge);

    const pending = await screen.findByTestId('payment-surface-settled-pending');
    expect(pending.textContent).toMatch(/[؀-ۿ]/u);
    // Must NOT promise a recording that will never happen.
    expect(pending.textContent).not.toMatch(/جارٍ|يجري/u);

    // Nothing fabricated, nothing implied.
    expect(screen.queryByTestId('payment-surface-receipt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-finalized')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T019 — no fabrication when the poll never resolves
// ---------------------------------------------------------------------------

describe('US4a T019 — null sale_id/sale_number fabricates nothing', () => {
  it('omits the completion detail block when the sales bridge is absent', async () => {
    const bridge = makeBridge(null, { omitSales: true });
    await renderSettled(bridge);
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-receipt')).not.toBeInTheDocument();
    expect(await screen.findByTestId('payment-surface-settled-pending')).toBeInTheDocument();
  });

  it('omits the completion detail block when the poll rejects', async () => {
    const bridge = makeBridge(null, { salesThrows: true });
    await renderSettled(bridge);
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-receipt')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T019a — FR-30: "new sale" behaviour preserved through the rewrite
// ---------------------------------------------------------------------------

describe('US4a T019a — onNewSale preserved (FR-30)', () => {
  it('still invokes onNewSale from the finalized state', async () => {
    const onNewSale = vi.fn();
    const bridge = makeBridge({
      sale_id: SALE_ID,
      sale_number: SALE_NUMBER,
      finalized_at: FINALIZED_AT,
    });
    await renderSettled(bridge, onNewSale);
    const btn = await screen.findByTestId('payment-surface-new-sale');
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('still invokes onNewSale from the not-yet-finalized state (no dead end)', async () => {
    const onNewSale = vi.fn();
    const bridge = makeBridge(null);
    await renderSettled(bridge, onNewSale);
    const btn = await screen.findByTestId('payment-surface-new-sale');
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('a missing onNewSale stays a safe no-op', async () => {
    const bridge = makeBridge(null);
    await renderSettled(bridge);
    const btn = await screen.findByTestId('payment-surface-new-sale');
    expect(() => {
      btn.click();
    }).not.toThrow();
  });
});
