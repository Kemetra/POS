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
  // 022 US4a (T011) — the sale id is NO LONGER retained.
  //
  // It existed to mount ReceiptPreview and to discriminate T013a's two settled
  // states. External review round 2 established that neither use is sound: the
  // `recent` row cannot be tied to THIS payment, so an id taken from it could
  // belong to a prior sale. Both the receipt (T017) and the completion claim
  // (T013a) are blocked on a correlating identifier, so holding the id would
  // be dead state inviting the same mistake again. Re-introduce it together
  // with the correlation key, not before.
  // `settled_at` is no longer retained: it existed solely to discriminate the
  // recent-sale poll's results, and that poll is gone (round-3 P1 above). It
  // returns with the correlating identifier, if the correlation ends up
  // needing it.
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
    usePaymentStore.getState().clearAttempt();
  }, [sessionState.kind, envelopeHandoffId]);

  // EXTERNAL REVIEW P1 (round 3) — "Stop polling until finalized sales can be
  // correlated". The recent-sale poll is REMOVED, not merely capped.
  //
  // Round 2 replaced a 10-attempt cap with a backoff that kept watching for the
  // life of the settled surface. That fixed "late finalization is never seen"
  // and, in doing so, widened the miscorrelation window from a bounded ~2s to
  // UNBOUNDED: any prior sale finalizing at any later point satisfies
  // `finalized_at >= settled_at` and would be adopted as this sale's number.
  //
  // The number rested on exactly the evidence that already disqualified the
  // receipt (T017) and the completion claim (T013a) — a terminal-wide row with
  // no tie to this payment. It survived earlier rounds only on "no worse than
  // `main`", and the uncapped poll made that false: `main` was bounded.
  //
  // So the surface shows no sale number, and nothing polls for one. This is a
  // DELIBERATE REDUCTION below `main` (it contradicts 006 invariant 13, which
  // asserts the number displays) accepted on safety grounds: a wrong
  // cashier-quotable reference is worse than none. It returns with the
  // correlating identifier, alongside T013a and T017.

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
        setBridgeRefusalCopy('تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى.');
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
      setBridgeRefusalCopy('تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى.');
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
        setBridgeRefusalCopy('تعذّر إلغاء عملية الدفع. يرجى المحاولة مرة أخرى.');
      }
    } catch {
      setBridgeRefusalCopy('تعذّر إلغاء عملية الدفع. يرجى المحاولة مرة أخرى.');
    } finally {
      setIsCancelling(false);
    }
  }

  // 023 V5 sale lifecycle — the settled phase above is component state and
  // dies with this surface, so the payment projection must carry the settle
  // for a Sale screen reopened later to recognise the sale as paid.
  // The confirm `ok` is main's authoritative settle: record it at once so a
  // failed follow-up read can never leave the sale payable again. The re-read
  // then only refines the projection, and is discarded if the payment context
  // moved on (New sale / another envelope) while it was in flight.
  function recordSettledFromConfirm(attemptId: string, settledAt: string): void {
    const store = usePaymentStore.getState();
    const slice = store.paymentSlice;
    if (slice?.payment_attempt_id !== attemptId) return;
    store.applyAttemptSnapshot({ ...slice, state: 'settled', settled_at: settledAt });
  }

  async function refineSettledAttempt(attemptId: string): Promise<void> {
    if (bridge === null) return;
    const envelopeAtConfirm = usePaymentStore.getState().envelope;
    try {
      const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
      const store = usePaymentStore.getState();
      const sameContext =
        store.envelope === envelopeAtConfirm &&
        store.paymentSlice?.payment_attempt_id === attemptId;
      if (
        readResponse.kind === 'ok' &&
        sameContext &&
        readResponse.payment_attempt.payment_attempt_id === attemptId
      ) {
        store.applyAttemptSnapshot(readResponse.payment_attempt);
      }
    } catch {
      // Keep the settle already recorded from the confirm response.
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
        setPhase('settled');
        recordSettledFromConfirm(paymentAttemptId, response.settled_at);
        void refineSettledAttempt(paymentAttemptId);
      } else {
        setBridgeRefusalCopy('تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.');
      }
    } catch {
      setBridgeRefusalCopy('تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.');
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
    // 022 US4a — NFR-6 / P2, as REVISED by external review round 2.
    //
    // The original design split this phase in two: "payment taken, sale not
    // yet finalized" vs "sale finalized". That split required knowing the
    // finalized record belongs to THIS payment — and the terminal cannot know
    // that. `RecentSaleSummary` carries no attempt/handoff identifier and
    // `payments.confirm` returns only `settled_at`, so `finalized_at >=
    // settled_at` is the only available test and a PRIOR sale finalizing late
    // satisfies it.
    //
    // Round 1 dropped the receipt but kept the "sale complete" headline on
    // that same evidence — fixing the symptom while keeping the assertion.
    // So the states collapse to the ONE the terminal can actually support:
    // the payment was taken. No sale number or receipt is shown without a
    // correlation key tying the finalized sale to this attempt.
    //
    // T013a and T017 are both unticked, blocked on the same backend gap: an
    // identifier on the `recent` projection tying the finalized sale to this
    // payment. 011 already derives one from `envelope_handoff_action_id`.

    return (
      <section
        className="v4-screen payment-surface--settled"
        data-testid="payment-surface"
        aria-label="الدفع"
      >
        <header className="v4-screen__header">
          <h1 className="v4-screen__title">الدفع</h1>
          <OperatorBadge display_name={display_name} role={role} />
        </header>

        {/* `payment-surface-settled` is the STABLE marker for "the settled
            phase is on screen" — the contract existing tests assert (006
            FR-031, invariant 14's never-stuck check, and the cart→checkout
            integration walk). 022 US4a splits what is *inside* it into the two
            truthful states below; the wrapper's meaning is unchanged, so those
            tests keep passing unmodified. */}
        <div className="v4-panel payment-surface__settled" data-testid="payment-surface-settled">
          {/* EXTERNAL REVIEW P1 (round 2) — "Require correlation before
              declaring the current sale complete".
              
              Round 1 removed the receipt but LEFT an `isFinalized` branch that
              rendered "تم إتمام البيع" (the sale is complete) from the SAME
              uncorrelated `recent` row. That fixed the symptom and kept the
              assertion: a prior sale finalizing late still promoted an
              unrelated record into proof that THIS sale completed.

              The terminal cannot establish that correlation — `recent` carries
              no attempt/handoff identifier and `confirm` returns only
              `settled_at` — so it must not claim completion at all. The two
              truthful states of T013a collapse into the one the terminal can
              actually support: the payment was taken.

              Unblocks with T017, on the same backend identifier. */}
          <div
            className="v4-stack payment-surface__settled-pending"
            data-testid="payment-surface-settled-pending"
            // role="status", never "alert" — a truthful terminal state, not an
            // error and not a failure.
            role="status"
            aria-live="polite"
          >
            <span className="payment-surface__settled-mark" aria-hidden="true">
              ✓
            </span>
            <p className="payment-surface__settled-headline">تم استلام المبلغ</p>
            {/* The flag governs what can be said about the RECEIPT only.
                ON: 008's listener may write one, but the worker also starts
                only for a terminal paired at boot (src/main/index.ts:1120-1126),
                so we say no receipt has issued YET rather than promising one is
                underway — true whether it arrives shortly or next launch, since
                the startup recovery scan re-fires settled-but-unfinalized rows.
                OFF: the whole 008 stack is unregistered (:441, :983), so no
                receipt will ever exist and the copy says exactly that. */}
            <p className="payment-surface__settled-detail">
              {saleFinalizationFlag
                ? 'تم تسجيل المبلغ. لم يصدر إيصال بعد.'
                : 'لن يُسجَّل هذا البيع ولا يوجد إيصال له.'}
            </p>
            {/* FR-16: the settled amount is the dominant numeric element.
                dir="ltr" isolates the numeral run inside RTL copy (FR-21). */}
            <p
              className="payment-surface__settled-amount"
              data-testid="payment-surface-settled-amount"
              dir="ltr"
            >
              {formatMinorUnits(envelope.subtotal_minor)}
            </p>
          </div>
        </div>

        <button
          type="button"
          className="btn btn--lg btn--primary payment-surface__new-sale"
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
      </section>
    );
  }

  return (
    <section className="payment-surface" data-testid="payment-surface" aria-label="الدفع">
      <header className="payment-surface__header">
        <h1 className="payment-surface__title">الدفع</h1>
        <OperatorBadge display_name={display_name} role={role} />
      </header>

      {/*
        022 US3 T070 — three-column composition.

        DOM ORDER IS AMOUNT → METHODS → SUMMARY, and that is load-bearing, not
        incidental. Tab order follows DOM order; neither CSS placement nor
        `dir="rtl"` reorders it. The design handoff's own README orders page
        shells left-to-right in source (summary → methods → amount), which would
        send keyboard focus to the centre methods column before the visually
        preceding amount panel — violating spec FR-23 ("Keyboard focus traversal
        order MUST follow the RTL visual order"). The prototype had no keyboard
        requirement; this product does, so the source order is RTL here and the
        stylesheet does not re-order it.

        The 1024–1279px reflow (amount panel drops below the methods) is a media
        query on `.payment-surface__body`, NOT a `useViewportTier` branch — the
        hook debounces tier changes by 100ms while CSS applies instantly, so a
        React-gated reflow would leave ~100ms of broken layout on every
        crossing. Same reasoning as the `.sale-layout` / `.tender-method-grid`
        narrow rules, which #450/#451 documented as NOT dead CSS.
      */}
      <div className="payment-surface__body" data-testid="payment-surface-body">
        <section className="payment-surface__amount" aria-label="المبلغ المستحق">
          <span
            className="payment-surface__amount-label"
            data-testid="payment-surface-amount-label"
          >
            المبلغ المستحق
          </span>
          <span
            className="payment-surface__amount-value"
            data-testid="payment-surface-amount-due"
            dir="ltr"
          >
            {formatMinorUnits(remainingBalanceMinor)}
          </span>
        </section>

        <div className="payment-surface__methods">
          <TenderSelection
            envelope={envelope}
            selectedTender={selectedTender}
            onTenderSelect={(tender) => {
              void handleTenderSelect(tender);
            }}
          />

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
        </div>

        <div className="payment-surface__summary">
          <PaymentCartSummary envelope={envelope} />
        </div>
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
            ? 'تم اختيار النقد'
            : selectedTender === 'external_card_terminal'
              ? 'تم اختيار جهاز الشبكة'
              : 'تم اختيار القسيمة'}
        </div>
      )}

      {/*
        022 US3-B — footer action bar.

        The two actions were previously loose siblings of the body grid, so they
        stacked full-bleed under the columns. The reference pairs them on one
        row at the foot of the surface, confirm leading. This is a PRESENTATION
        wrapper only: both buttons keep their class, testid, disabled state and
        handler exactly as before, and the confirm/cancel conditions are
        unchanged — so `hasAppliedLine` still gates confirm and the entry phase
        still gates cancel.

        DOM order stays confirm → cancel: the primary action precedes the
        escape hatch in traversal, and under RTL the row renders confirm at the
        inline-start edge as the reference shows.
      */}
      {bridge !== null && (hasAppliedLine || phase === 'entry') && (
        <div className="payment-surface__actions" data-testid="payment-surface-actions">
          {hasAppliedLine && (
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
              تأكيد الدفع
            </button>
          )}

          {phase === 'entry' && (
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
              إلغاء
            </button>
          )}
        </div>
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
          هناك عمليات عكس قيد المعالجة وستتم قريباً.
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
    </section>
  );
}
