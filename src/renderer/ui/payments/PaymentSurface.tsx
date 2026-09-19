import { useEffect, useState, type JSX } from 'react';

import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { usePaymentStore } from '../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import { OperatorBadge } from '../operator/OperatorBadge.js';
import { format as formatMoney, of as moneyOf } from '../../../shared/money.js';
import { TenderSelection, type TenderKind } from './TenderSelection.js';
import { PaymentCartSummary } from './PaymentCartSummary.js';
import { CashEntry } from './CashEntry.js';
import { ExternalCardTerminalEntry } from './ExternalCardTerminalEntry.js';
import { VoucherEntry } from './VoucherEntry.js';
import type {
  PaymentsBridgeAPI,
  PreloadBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../shared/bridge-api.js';

/**
 * 006-payments-tender S1 + S3d T152 — PaymentSurface.
 *
 * Route guard: returns null unless both a signed-in operator session and a
 * non-null payment envelope exist. This prevents the surface from mounting
 * in an inconsistent state.
 *
 * Modes:
 *   • Slice-1 (no bridge): renders TenderSelection + PaymentCartSummary +
 *     a "tender selected" status banner. No bridge calls. Backwards
 *     compatible with existing tests + Slice-1/Slice-2 callers.
 *   • S3d (bridge wired): when `_testBridge` (tests) or `window.api`
 *     (production) provides `payments` + `tender`, picking a tender
 *     triggers `payments.start`, mounts the entry component with the T151
 *     bridge wiring, and surfaces a "Confirm payment" button when at
 *     least one tender line is applied. Confirm click → `payments.confirm`.
 *     On settled, transitions to a placeholder per FR-031.
 *
 * SECURITY:
 *   - No sensitive IDs in DOM (FR-035).
 *   - No card data (PAN, CVV, cardholder name) of any kind.
 *   - No raw bridge reason strings displayed to cashier. Refusal copy is
 *     generic per FR-005 / FR-006B.
 *   - Manager identity never in cashier-visible UI.
 */

export interface PaymentSurfaceProps {
  /**
   * Test seam: injects payments + tender (+ optional sales) bridge in place of
   * `window.api`. Mirrors the `_testBridge` pattern from CartPane
   * (cart-pane-live-lines). When omitted in production, the surface reads from
   * `window.api.payments` + `window.api.tender` (+ `window.api.sales`) — the
   * typed preload bridge.
   */
  _testBridge?: {
    payments: PaymentsBridgeAPI;
    tender: TenderBridgeAPI;
    sales?: SalesBridgeAPI;
  };
  /**
   * Invoked when the cashier clicks "New sale" on the settled/completed
   * surface. The route owner (CheckoutRoute) wires this to reset the payment +
   * cart stores and navigate back to /app/cart — keeping PaymentSurface
   * Router-agnostic (mirrors CartPane's onPaymentContinue seam, so the
   * bare-render unit tests need no Router ancestor). Optional + guarded: when
   * omitted (tests / Slice-1), the button still renders and is a safe no-op.
   */
  onNewSale?: () => void;
}

type Phase = 'tender_selection' | 'entry' | 'settled';

/**
 * Minor-units → display string, via the shared money module (Constitution §II
 * — integer minor units, `Number.isSafeInteger` guarded, ≥95% covered). Using
 * `money.format` rather than a local copy keeps the completion surface on the
 * same currency rendering as the rest of the app. A non-safe integer renders
 * as an em dash rather than a wrong number.
 */
function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    return '—';
  }
  return formatMoney(moneyOf(minor, 'EGP'));
}

interface ResolvedBridge {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  /**
   * The read-only sales bridge, used after settlement to poll the terminal's
   * most-recently-finalized sale (`subscribe({ topic: 'recent' })`) so the
   * completed surface can show the cashier-quotable sale number. Optional: the
   * surface degrades gracefully (completed state + New sale, no sale number)
   * when sales is absent — `payments.confirm` carries no sale id/number, and
   * the sale finalizes asynchronously in the main process.
   */
  sales?: SalesBridgeAPI;
}

/**
 * Resolve the payments + tender (+ sales) bridge. In tests the bridge is
 * supplied via the `_testBridge` prop; in production we read it from the typed
 * preload `window.api`. Returns null only when payments OR tender is absent
 * (e.g. happy-dom with no prop injection — Slice-1 fall-back) so the surface
 * can degrade gracefully. `sales` is optional and never gates resolution.
 */
function resolveBridge(testBridge: ResolvedBridge | undefined): ResolvedBridge | null {
  if (testBridge !== undefined) {
    return testBridge;
  }
  /* v8 ignore next 9 — only reachable in Electron; jsdom never sets window.api */
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (api === undefined || api.payments === undefined || api.tender === undefined) {
    return null;
  }
  // Spread `sales` only when present — `exactOptionalPropertyTypes` forbids
  // assigning an explicit `undefined` to the optional `sales?` property.
  return {
    payments: api.payments,
    tender: api.tender,
    ...(api.sales !== undefined ? { sales: api.sales } : {}),
  };
}

export function PaymentSurface({
  _testBridge,
  onNewSale,
}: PaymentSurfaceProps = {}): JSX.Element | null {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const envelope = usePaymentStore((s) => s.envelope);
  const paymentSlice = usePaymentStore((s) => s.paymentSlice);

  const [selectedTender, setSelectedTender] = useState<TenderKind | null>(null);
  const [phase, setPhase] = useState<Phase>('tender_selection');
  const [bridgeRefusalCopy, setBridgeRefusalCopy] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [reversalPending, setReversalPending] = useState<boolean>(false);
  // The cashier-quotable number of the just-finalized sale. Null until the
  // recent-sale poll resolves (or forever, if sales is absent / the worker is
  // slow — the completed state + New sale never depend on it).
  const [settledSaleNumber, setSettledSaleNumber] = useState<string | null>(null);
  // 022 US4a (T011) — the finalized sale's id, retained alongside the number so
  // the completion surface can mount ReceiptPreview for THIS sale.
  // `RecentSaleSummary` already carries it (shared/sales/types.ts), so this is
  // a new use of existing poll data — no bridge change (P8).
  //
  // It is also the discriminator for the two truthful settled states (T013a):
  // null → payment settled, sale not yet finalized; non-null → sale finalized.
  // It is never rendered as text (FR-035), only passed to ReceiptPreview.
  const [settledSaleId, setSettledSaleId] = useState<string | null>(null);
  // `settled_at` from payments.confirm, used to discriminate THIS sale's
  // `recent` snapshot from a prior sale's. The AD-2 worker finalizes THIS sale
  // AFTER confirm returns, so a `recent` whose finalized_at predates this
  // settled_at is a stale prior sale and must be ignored.
  const [settledAt, setSettledAt] = useState<string | null>(null);
  // 008's finalize listener is gated on this flag. With it off no receipt is
  // ever written, so the completion surface must say so rather than imply a
  // document is on its way.
  const saleFinalizationFlag = useFeatureFlagsStore((s) => s.saleFinalization);

  const bridge = resolveBridge(_testBridge);

  // paymentAttemptId is the source-of-truth from the paymentSlice projection
  // (set by payments.start → payments.read flow, or seeded by tests via
  // applyAttemptSnapshot). Keeping a single source avoids drift.
  const paymentAttemptId = paymentSlice?.payment_attempt_id ?? null;

  // Reset surface state when envelope or session context changes; otherwise a
  // stale "tender selected" status banner could carry across a new payment
  // attempt.
  const envelopeHandoffId = envelope?.handoff_action_id ?? null;
  useEffect(() => {
    setSelectedTender(null);
    setPhase('tender_selection');
    setBridgeRefusalCopy(null);
    setIsConfirming(false);
    setIsCancelling(false);
    setIsStarting(false);
    setReversalPending(false);
    setSettledSaleNumber(null);
    setSettledSaleId(null);
    setSettledAt(null);
    usePaymentStore.getState().clearAttempt();
  }, [sessionState.kind, envelopeHandoffId]);

  // On entering the settled phase, poll the terminal's most-recently-finalized
  // sale to surface the cashier-quotable sale number. The sale finalizes
  // asynchronously in the main process (~200ms after confirm via the AD-2
  // worker); `payments.confirm` returns only `settled_at`. We poll
  // `sales.subscribe({ topic: 'recent' })` (a snapshot poll, no push) a few
  // times to ride out that gap. Graceful: any refusal / absent sales bridge /
  // unmount simply leaves the number unset — the completed surface + New sale
  // do not depend on it (invariant 14 holds regardless).
  //
  // CODEX REVIEW P2 — "Continue checking for late finalization". The original
  // cap gave up after ~2s, so a sale finalizing later (a worker draining many
  // batches, or a transient projection refusal that clears) could never be
  // reported: the surface stayed on "being recorded" forever even once the
  // sale existed. We now BACK OFF rather than stop — fast polls to catch the
  // common ~200ms case, then a slow cadence that keeps watching for the rest
  // of the completion surface's life. The effect is bounded by unmount, which
  // happens on "new sale", so this cannot leak beyond the settled screen.
  const salesBridge = bridge?.sales;
  useEffect(() => {
    if (
      phase !== 'settled' ||
      salesBridge === undefined ||
      settledAt === null ||
      settledSaleNumber !== null
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    // Fast phase: ride out the ~200ms AD-2 worker gap.
    const FAST_ATTEMPTS = 10;
    const FAST_INTERVAL_MS = 200;
    // Slow phase: keep watching for a late finalization without busy-polling.
    const SLOW_INTERVAL_MS = 3000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const response = await salesBridge.subscribe({ topic: 'recent' });
        if (cancelled) return;
        if (
          response.kind === 'ok' &&
          'recent' in response &&
          response.recent !== null &&
          // Discriminate THIS sale from a stale prior one: the AD-2 worker
          // finalizes THIS sale AFTER confirm, so only a recent whose
          // finalized_at is at/after our settled_at is ours. A prior sale's
          // snapshot (finalized before settled_at) is ignored — keep polling.
          response.recent.finalized_at >= settledAt
        ) {
          // 022 US4a (T011) — retain BOTH. The id drives the receipt mount and
          // the finalized/not-yet-finalized discrimination; the number is the
          // cashier-quotable reference.
          setSettledSaleNumber(response.recent.sale_number);
          setSettledSaleId(response.recent.sale_id);
          return;
        }
      } catch {
        // Bridge rejection — treat as "not yet available"; keep polling until
        // the attempt cap, then give up silently (no DOM error surfaced).
      }
      if (!cancelled) {
        const delay = attempts < FAST_ATTEMPTS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
        timer = setTimeout(() => void poll(), delay);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [phase, salesBridge, settledAt, settledSaleNumber]);

  if (sessionState.kind !== 'signedIn' || envelope === null) {
    return null;
  }

  const { display_name, role } = sessionState.session;

  async function handleTenderSelect(tender: TenderKind): Promise<void> {
    setSelectedTender(tender);
    setBridgeRefusalCopy(null);

    if (bridge === null || envelope === null) {
      // Slice-1 behaviour: status banner only.
      return;
    }

    // Split-tender path: an attempt is already started (paymentSlice holds the
    // attempt id from a prior payments.start). Calling payments.start again
    // would be refused with `attempt_already_started_on_terminal`. Skip
    // straight to mounting the new entry component for the remaining balance.
    if (paymentAttemptId !== null) {
      setPhase('entry');
      return;
    }

    // CR-9 guard: rapid-double clicks before the first start/read cycle
    // completes would otherwise fire payments.start multiple times in
    // parallel. paymentAttemptId only updates after the read response lands.
    if (isStarting) {
      return;
    }

    setIsStarting(true);
    try {
      const startResponse = await bridge.payments.start({
        envelope_handoff_action_id: envelope.handoff_action_id,
        envelope_cart_id: envelope.cart_id,
        envelope_subtotal_minor: envelope.subtotal_minor,
        envelope_version: 'v1',
        idempotency_key: crypto.randomUUID(),
      });

      if (startResponse.kind === 'refused') {
        setBridgeRefusalCopy('We could not start this payment. Please try again.');
        return;
      }

      setPhase('entry');

      // Seed the paymentSlice with an initial read so the surface can react to
      // applied lines as they land. This also populates the paymentAttemptId
      // derivation above.
      const readResponse = await bridge.payments.read({
        payment_attempt_id: startResponse.payment_attempt_id,
      });
      if (readResponse.kind === 'ok') {
        usePaymentStore.getState().applyAttemptSnapshot(readResponse.payment_attempt);
      }
    } catch {
      // Bridge rejection (network / IPC layer error). Treat as a generic
      // refusal — no structured reason crosses into the DOM (FR-005 / FR-017).
      setBridgeRefusalCopy('We could not start this payment. Please try again.');
    } finally {
      setIsStarting(false);
    }
  }

  async function handleLineApplied(): Promise<void> {
    if (bridge === null || paymentAttemptId === null || envelope === null) {
      return;
    }
    try {
      const readResponse = await bridge.payments.read({
        payment_attempt_id: paymentAttemptId,
      });
      if (readResponse.kind === 'ok') {
        usePaymentStore.getState().applyAttemptSnapshot(readResponse.payment_attempt);
        // Split-tender (T154): if the running sum is still below the subtotal,
        // return to tender selection so the cashier may add another line. When
        // the sum equals the subtotal, the surface stays put and the confirm
        // button becomes visible. The settlement invariant itself is enforced
        // on the main process at payments.confirm time.
        // CR-11: guard every accumulator step with Number.isSafeInteger
        // (Constitution §II). A malformed minor value silently produces a
        // float-tainted running sum without this check.
        let sumApplied = 0;
        for (const line of readResponse.payment_attempt.tender_lines) {
          if (line.state !== 'applied') continue;
          if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
          sumApplied += line.amount_applied_minor;
          if (!Number.isSafeInteger(sumApplied)) {
            // Running sum overflowed — bail out without changing the phase.
            return;
          }
        }
        if (sumApplied < envelope.subtotal_minor) {
          setSelectedTender(null);
          setPhase('tender_selection');
        }
      }
    } catch {
      // Read failure after a successful apply: keep the current phase so the
      // cashier can retry; do NOT surface a refusal here because the line
      // itself was successfully applied on the main process.
    }
  }

  async function handleCancel(): Promise<void> {
    if (bridge === null || paymentAttemptId === null) {
      return;
    }
    setBridgeRefusalCopy(null);
    setIsCancelling(true);
    try {
      const response = await bridge.payments.cancel({
        payment_attempt_id: paymentAttemptId,
        idempotency_key: crypto.randomUUID(),
      });
      if (response.kind === 'ok') {
        setReversalPending(response.reversal_pending_tender_line_ids.length > 0);
        setSelectedTender(null);
        setPhase('tender_selection');
        usePaymentStore.getState().clearAttempt();
      } else {
        setBridgeRefusalCopy('This payment could not be cancelled. Please try again.');
      }
    } catch {
      setBridgeRefusalCopy('This payment could not be cancelled. Please try again.');
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (bridge === null || paymentAttemptId === null) {
      return;
    }
    setBridgeRefusalCopy(null);
    setIsConfirming(true);
    try {
      const response = await bridge.payments.confirm({
        payment_attempt_id: paymentAttemptId,
        idempotency_key: crypto.randomUUID(),
      });
      if (response.kind === 'ok') {
        // Capture settled_at so the recent-sale poll can tell THIS sale's
        // finalized snapshot from a stale prior one (the worker finalizes
        // after this returns).
        setSettledAt(response.settled_at);
        setPhase('settled');
      } else {
        setBridgeRefusalCopy('This payment could not be settled. Please try again.');
      }
    } catch {
      setBridgeRefusalCopy('This payment could not be settled. Please try again.');
    } finally {
      setIsConfirming(false);
    }
  }

  const appliedLines = (paymentSlice?.tender_lines ?? []).filter((l) => l.state === 'applied');
  const hasAppliedLine = appliedLines.length > 0;
  // Split-tender remaining-balance derivation (T154). Pass to entry components
  // so each successive line is scoped to what's still owed, not the full
  // subtotal.
  // CR-11: skip any line whose amount_applied_minor isn't a safe integer
  // (Constitution §II). The main-process projection should always emit safe
  // integers; this is the renderer-side belt to that braces.
  let sumAppliedMinor = 0;
  for (const line of appliedLines) {
    if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
    sumAppliedMinor += line.amount_applied_minor;
  }
  const remainingBalanceMinor = Number.isSafeInteger(sumAppliedMinor)
    ? Math.max(envelope.subtotal_minor - sumAppliedMinor, 0)
    : 0;

  if (phase === 'settled') {
    // 022 US4a (T013a) — NFR-6 / P2. `setPhase('settled')` fires on
    // payments.confirm ALONE, before the AD-2 worker finalizes the sale, so
    // the settled phase carries two genuinely different meanings. We render
    // whichever one is TRUE, and never blur them:
    //
    //   (a) isFinalized === false — the payment is taken; the sale record is
    //       still being written. No "sale complete" claim, no receipt, no
    //       fabricated sale number. This is also the resting state when
    //       saleFinalization is off (no receipt will ever exist) and when the
    //       poll fails, times out, or the sales bridge is absent.
    //   (b) isFinalized === true — the finalized record for THIS sale has
    //       arrived (the poll already enforces finalized_at >= settled_at, so
    //       a stale prior sale can never land here). Full success state.
    //
    // Neither is an error state; the difference is what the system knows.
    //
    // Two INDEPENDENT facts, deliberately not conflated:
    //   • `isFinalized` — did the finalized record for THIS sale arrive? That
    //     comes from the sales poll alone. A returned record IS the proof the
    //     sale was finalized, so it also licenses quoting the sale number
    //     (006 invariant 13).
    //   • the RECEIPT is not shown at all — see the CODEX REVIEW P1 note in
    //     the finalized branch. The flag still governs the honesty copy below:
    //     with saleFinalization off, 008's listener short-circuits and no
    //     receipt will ever exist, which the surface states plainly (T018).
    const isFinalized = settledSaleId !== null && settledSaleNumber !== null;

    return (
      <main
        className="payment-surface payment-surface--settled"
        data-testid="payment-surface"
        aria-label="الدفع"
      >
        <header className="payment-surface__header">
          <h2 className="payment-surface__title">الدفع</h2>
          <OperatorBadge display_name={display_name} role={role} />
        </header>

        {/* `payment-surface-settled` is the STABLE marker for "the settled
            phase is on screen" — the contract existing tests assert (006
            FR-031, invariant 14's never-stuck check, and the cart→checkout
            integration walk). 022 US4a splits what is *inside* it into the two
            truthful states below; the wrapper's meaning is unchanged, so those
            tests keep passing unmodified. */}
        <div className="payment-surface__settled" data-testid="payment-surface-settled">
          {isFinalized ? (
            <div
              className="payment-surface__finalized"
              data-testid="payment-surface-finalized"
              role="status"
              aria-live="polite"
            >
              <p className="payment-surface__settled-headline">تم إتمام البيع</p>
              {/* FR-16: the settled amount is the dominant numeric element.
                dir="ltr" isolates the numeral run inside RTL copy (FR-21). */}
              <p
                className="payment-surface__settled-amount"
                data-testid="payment-surface-settled-amount"
                dir="ltr"
                // FR-16 hierarchy via EXISTING typography tokens — no raw
                // literals (022 standing constraint: sizes change only in
                // :root). U0/T083 re-reviews this against the v4.0 scale.
                style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 'var(--font-weight-bold)' }}
              >
                {formatMinorUnits(envelope.subtotal_minor)}
              </p>
              {/* T018: the sale is finalized, but with 008's listener gated off
                  no receipt was written. Say so rather than leave the absence
                  of a receipt unexplained. */}
              {!saleFinalizationFlag && (
                <p
                  className="payment-surface__settled-detail"
                  data-testid="payment-surface-no-receipt"
                >
                  لا يوجد إيصال لهذا البيع.
                </p>
              )}
            </div>
          ) : (
            <div
              className="payment-surface__settled-pending"
              data-testid="payment-surface-settled-pending"
              // role="status", never "alert" — this is a truthful intermediate
              // state, not an error.
              role="status"
              aria-live="polite"
            >
              <p className="payment-surface__settled-headline">تم استلام المبلغ</p>
              {/* With the flag ON this is a genuinely transitional state: the
                  finalize worker is running and the record is on its way.
                  With it OFF the whole 008 stack is unregistered
                  (src/main/index.ts:441, :983) — the record will NEVER be
                  written, so promising one would be a fake-pending claim. The
                  honest flag-off message is terminal: money taken, nothing
                  further recorded. */}
              {/* CODEX REVIEW P2 — "Avoid promising finalization after
                  in-process pairing". The AD-2 finalize worker starts only for
                  a terminal that was ALREADY paired at boot
                  (src/main/index.ts:1120-1126); one paired mid-session picks it
                  up on the next launch. The renderer cannot see pairing-at-boot
                  state, so the flag-on copy must not promise recording is
                  underway — that would be a fake-PENDING, the same dishonesty
                  the two-state split exists to remove.

                  It says the payment is recorded and the receipt has not issued
                  YET, which is true in both cases: the worker is running (it
                  arrives shortly), or it starts next launch and the startup
                  recovery scan re-fires any settled-but-unfinalized rows — so
                  the sale is deferred, never lost. */}
              <p className="payment-surface__settled-detail">
                {saleFinalizationFlag
                  ? 'تم تسجيل المبلغ. لم يصدر إيصال بعد.'
                  : 'لن يُسجَّل هذا البيع ولا يوجد إيصال له.'}
              </p>
              <p
                className="payment-surface__settled-amount"
                data-testid="payment-surface-settled-amount"
                dir="ltr"
                // Same token-based hierarchy as the finalized state: the amount
                // taken is the dominant number in BOTH truthful states.
                style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 'var(--font-weight-bold)' }}
              >
                {formatMinorUnits(envelope.subtotal_minor)}
              </p>
            </div>
          )}
        </div>

        {/* Preserved omission behaviour (T019): with no finalized record there
            is no number to quote, so the block stays absent rather than
            fabricating one. */}
        {isFinalized && (
          <div className="payment-surface__sale-number" role="status" aria-live="polite">
            <span className="payment-surface__sale-number-label">رقم البيع</span>{' '}
            <span
              className="payment-surface__sale-number-value"
              data-testid="payment-surface-sale-number"
              dir="ltr"
            >
              {settledSaleNumber}
            </span>
          </div>
        )}

        {/* CODEX REVIEW P1 — the receipt is deliberately NOT mounted here.
            `RecentSaleSummary` carries no payment/attempt/envelope key and
            `payments.confirm` returns only `settled_at`, so `finalized_at >=
            settled_at` is the only discriminator available renderer-side — and
            a PRIOR sale finalizing late (a worker retry succeeding while this
            sale is delayed) satisfies it. Mounting a receipt on that would show
            the previous customer's document.

            The correlation gap pre-dates this slice (`main` already showed the
            number from the same unverified `recent`, 006 invariant 13); what
            US4a added was a receipt for a sale the terminal cannot prove is
            this one. There is no renderer-only fix — the key does not exist on
            the wire and adding one is a bridge change (P8). A tighter time
            window or amount-match would be a heuristic dressed as a fix.

            So the number stays (no worse than main) and the receipt waits for a
            correlatable identifier on the `recent` projection. T017 is untieked
            and the gap is filed; 011 already derives one from
            `envelope_handoff_action_id`, so it exists main-side. */}

        <button
          type="button"
          className="payment-surface__new-sale"
          data-testid="payment-surface-new-sale"
          onClick={() => {
            // Routing + store reset is delegated to the route owner so this
            // component stays Router-agnostic. Guarded — a missing handler is
            // a safe no-op (Slice-1 / bare-render tests).
            onNewSale?.();
          }}
        >
          بيع جديد
        </button>
      </main>
    );
  }

  return (
    <main className="payment-surface" data-testid="payment-surface" aria-label="Payment">
      <header className="payment-surface__header">
        <h2 className="payment-surface__title">Payment</h2>
        <OperatorBadge display_name={display_name} role={role} />
      </header>

      <div className="payment-surface__body">
        <TenderSelection
          envelope={envelope}
          onTenderSelect={(tender) => {
            void handleTenderSelect(tender);
          }}
        />
        <PaymentCartSummary envelope={envelope} />
      </div>

      {/* Slice-1 mode: status banner only (no bridge wiring). */}
      {bridge === null && selectedTender !== null && (
        <div
          className="payment-surface__tender-selected"
          data-testid="payment-surface-tender-selected"
          role="status"
          aria-live="polite"
        >
          {selectedTender === 'cash'
            ? 'Cash selected'
            : selectedTender === 'external_card_terminal'
              ? 'Card terminal selected'
              : 'Voucher selected'}
        </div>
      )}

      {/* S3d mode: entry component for the selected tender. */}
      {bridge !== null && phase === 'entry' && paymentAttemptId !== null && (
        <div className="payment-surface__entry" data-testid="payment-surface-entry">
          {selectedTender === 'cash' && (
            <CashEntry
              remainingBalanceMinor={remainingBalanceMinor}
              paymentAttemptId={paymentAttemptId}
              tenderApply={(req) => bridge.tender.apply(req)}
              onApplied={() => {
                void handleLineApplied();
              }}
            />
          )}
          {selectedTender === 'external_card_terminal' && (
            <ExternalCardTerminalEntry
              remainingBalanceMinor={remainingBalanceMinor}
              paymentAttemptId={paymentAttemptId}
              tenderApply={(req) => bridge.tender.apply(req)}
              onApplied={() => {
                void handleLineApplied();
              }}
            />
          )}
          {selectedTender === 'internal_voucher' && (
            <VoucherEntry
              remainingBalanceMinor={remainingBalanceMinor}
              paymentAttemptId={paymentAttemptId}
              tenderApply={(req) => bridge.tender.apply(req)}
              onApplied={() => {
                void handleLineApplied();
              }}
            />
          )}
        </div>
      )}

      {/* S3d mode: confirm button shows once any line is applied. */}
      {bridge !== null && hasAppliedLine && (
        <button
          type="button"
          className="payment-surface__confirm"
          data-testid="payment-surface-confirm"
          disabled={isConfirming}
          aria-disabled={isConfirming ? 'true' : undefined}
          onClick={() => {
            void handleConfirm();
          }}
        >
          Confirm payment
        </button>
      )}

      {/* S3d mode: cancel button visible during the entry phase. */}
      {bridge !== null && phase === 'entry' && (
        <button
          type="button"
          className="payment-surface__cancel"
          data-testid="payment-surface-cancel"
          disabled={isCancelling}
          aria-disabled={isCancelling ? 'true' : undefined}
          onClick={() => {
            void handleCancel();
          }}
        >
          Cancel
        </button>
      )}

      {/* Slice-4 voucher path: hint shown when reversal_pending_tender_line_ids
          was non-empty in the most recent cancel response. Copy is fixed (no
          id interpolation) per FR-017 / token minimisation. */}
      {reversalPending && (
        <div
          className="payment-surface__reversal-pending-hint"
          data-testid="payment-surface-reversal-pending-hint"
          role="status"
          aria-live="polite"
        >
          Some reversals are pending and will be processed shortly.
        </div>
      )}

      {bridgeRefusalCopy !== null && (
        <div
          className="payment-surface__bridge-refusal"
          data-testid="payment-surface-bridge-refusal"
          role="status"
          aria-live="polite"
        >
          {bridgeRefusalCopy}
        </div>
      )}
    </main>
  );
}
