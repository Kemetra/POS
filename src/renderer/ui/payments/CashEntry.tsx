import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { computeChangeDueMinor } from '../../../shared/payments/money-math.js';
import { isCashAmountWithinBound } from '../../../shared/payments/cash-bound.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { parseCurrencyToMinor, formatMinorToInput } from './parse-currency-to-minor.js';
import { normalizeNumericInput } from '../forms/normalize-digits.js';
import { PinnedPrimary } from './CheckoutActionBar.js';
import { QuickAmounts } from '../../v5/checkout/QuickAmounts.js';
import { CashKeypad } from '../../v5/checkout/CashKeypad.js';
import { Notice } from '../../v5/foundation/Notice.js';

/**
 * 006-payments-tender Slice 2 + S3d T151, recomposed for RT-243 W1-C
 * (freeze 15 §6 Checkout / cash; VN-B2) — <CashEntry>.
 *
 * The cash entry is the amount field, the quick amounts and an LTR keypad, all
 * three editing one value. It shows no money of its own: the amount due, the
 * change and any shortfall are in the pinned ledger (`PaymentLedger`), so none of
 * them can scroll below the fold (RT-255 item 1). The typed amount reaches the
 * ledger through `onDraftChange`.
 *
 * Modes:
 *   • Slice-2 (display-only): caller passes `onConfirm`. Confirm fires with
 *     `{ amountAppliedMinor, changeDueMinor }`.
 *   • S3d (bridged): caller additionally passes `paymentAttemptId`,
 *     `tenderApply`, `onApplied`. Confirm builds a `TenderApplyRequest`
 *     with a fresh UUID v4 idempotency_key (R-10), calls the bridge, and
 *     either fires `onApplied(response)` on success or renders generic
 *     refusal copy on `{ kind: 'refused' }`.
 *
 * Cash stays two-step (D-P2): this apply records the cash line; the settle is
 * the ledger's «تأكيد الدفع».
 *
 * SECURITY:
 *   - No card data of any kind (this is the cash surface).
 *   - No sensitive IDs rendered.
 *   - Structured `refusal.reason` strings never enter the DOM — only the
 *     generic copy required by FR-005 / US1-AS3.
 *   - Money is integer minor units only (Constitution §II).
 */

export interface CashEntryProps {
  remainingBalanceMinor: number;
  /**
   * Slice-2 callback. Called with the parsed amount + computed change when
   * the cashier confirms a sufficient cash amount. When `tenderApply` is
   * provided, this callback is NOT invoked — the bridge response is
   * surfaced through `onApplied` instead.
   */
  onConfirm?: (applied: { amountAppliedMinor: number; changeDueMinor: number }) => void;
  onBack?: () => void;
  /** Payment attempt id from the main process (required when `tenderApply` is set). */
  paymentAttemptId?: string;
  /** Bridge callback. Receives a fully-formed TenderApplyRequest. */
  tenderApply?: (req: TenderApplyRequest) => Promise<TenderApplyResponse>;
  /** Fires with the `{ kind: 'ok', ... }` response on successful apply. */
  onApplied?: (response: Extract<TenderApplyResponse, { kind: 'ok' }>) => void;
  /**
   * The amount in the field, integer minor units, or null when it is empty or
   * does not parse. Called on every change and with null when the entry closes,
   * so the ledger never previews an amount that is no longer on screen.
   */
  onDraftChange?: (receivedMinor: number | null) => void;
  /**
   * RT-339 — main refused the cash because nothing is left to pay: this screen
   * has not seen a tender main already holds. The caller reads main again.
   */
  onNothingOwed?: () => void;
}

export function CashEntry({
  remainingBalanceMinor,
  onConfirm,
  onBack,
  paymentAttemptId,
  tenderApply,
  onApplied,
  onDraftChange,
  onNothingOwed,
}: CashEntryProps): JSX.Element {
  const [rawInput, setRawInput] = useState<string>('');
  const [bridgeRefusal, setBridgeRefusal] = useState<boolean>(false);
  const [nothingOwed, setNothingOwed] = useState<boolean>(false);
  // RT-437: the amount main refused as out of range (null when none).
  const [refusedAmountMinor, setRefusedAmountMinor] = useState<number | null>(null);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const amountAppliedMinor = useMemo(() => parseCurrencyToMinor(rawInput), [rawInput]);

  // Freeze 15 §3.2: opening the cash entry puts focus in the amount field
  // (typing allowed; a scan burst there is refused, M-S5; Enter never applies).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isRemainingValid =
    Number.isSafeInteger(remainingBalanceMinor) && remainingBalanceMinor >= 0;
  const isSufficient =
    isRemainingValid && amountAppliedMinor !== null && amountAppliedMinor >= remainingBalanceMinor;
  const isUnderTender =
    isRemainingValid && amountAppliedMinor !== null && amountAppliedMinor < remainingBalanceMinor;

  // T154 split-tender: in bridged mode (tenderApply provided) the cashier may
  // apply a partial cash line for less than the remaining balance — the main
  // process accepts the line and the surface returns to tender selection for
  // the rest. The settlement invariant is enforced at payments.confirm time.
  // In Slice-2 mode (no tenderApply) the legacy "must be >= remaining" gate
  // stays in force.
  const isBridged = tenderApply !== undefined && paymentAttemptId !== undefined;
  const isPositive = amountAppliedMinor !== null && amountAppliedMinor > 0;
  // Defect B guard: in bridged mode, only allow applying a cash line while a
  // balance is still owed (remaining > 0). Once the attempt is fully tendered
  // (remaining == 0), applying more cash only piles all-change lines — the
  // cashier must use "Confirm payment" (settle) instead. Split-tender partial
  // applies remain allowed because they happen while remaining is still > 0.
  // RT-437 (D-F2) — the same pure rule main enforces: above max(cash cap,
  // remaining) the amount is scanner or typing digits, never cash received.
  // Main stays the authority: while the field still holds the amount main
  // refused (its balance can be newer than this screen's), the apply stays off
  // and the ledger does not preview it. The refusal is tied to the amount it
  // answered, so an edit made while it was in flight is never marked refused
  // (Codex P2 ×2 on #652).
  const isOutOfRange =
    (refusedAmountMinor !== null && refusedAmountMinor === amountAppliedMinor) ||
    (isBridged &&
      isRemainingValid &&
      amountAppliedMinor !== null &&
      !isCashAmountWithinBound(amountAppliedMinor, remainingBalanceMinor, 'EGP'));
  const canConfirm = isBridged
    ? isPositive && isRemainingValid && remainingBalanceMinor > 0 && !isOutOfRange
    : isSufficient;

  // The ledger previews what is in the field; the latest callback is kept in a
  // ref so a new function identity from the parent does not re-report. An
  // out-of-range amount (RT-437) is never previewed: its "change" is barcode
  // digits, the F-02 figure the cashier must not be shown.
  const previewMinor = isOutOfRange ? null : amountAppliedMinor;
  const draftRef = useRef(onDraftChange);
  draftRef.current = onDraftChange;
  useEffect(() => {
    draftRef.current?.(previewMinor);
  }, [previewMinor]);
  useEffect(
    () => () => {
      draftRef.current?.(null);
    },
    [],
  );

  function setAmount(next: string): void {
    setRawInput(next);
    setBridgeRefusal(false);
    setNothingOwed(false);
    setRefusedAmountMinor(null);
  }

  async function handleConfirm(): Promise<void> {
    if (!canConfirm || amountAppliedMinor === null) {
      return;
    }

    if (tenderApply !== undefined && paymentAttemptId !== undefined) {
      setBridgeRefusal(false);
      setNothingOwed(false);
      setIsApplying(true);
      try {
        const response = await tenderApply({
          payment_attempt_id: paymentAttemptId,
          tender_type: 'cash',
          amount_applied_minor: amountAppliedMinor,
          idempotency_key: crypto.randomUUID(),
        });
        if (response.kind === 'ok') {
          onApplied?.(response);
        } else if (response.reason === 'cash_amount_out_of_range') {
          // RT-437 (M-P29) — retrying the same amount can never help: keep it
          // in the field for correction and give the field focus back.
          setRefusedAmountMinor(amountAppliedMinor);
          inputRef.current?.focus();
        } else if (response.reason === 'attempt_fully_tendered') {
          // Retrying can never help here, so this is not the generic line.
          setNothingOwed(true);
          onNothingOwed?.();
        } else {
          setBridgeRefusal(true);
        }
      } catch {
        // CR-6: bridge rejection (network / IPC layer error). Treat the same
        // as a structured refusal — surface generic copy, never let the
        // promise reject up through `void handleConfirm()` as an unhandled
        // rejection.
        setBridgeRefusal(true);
      } finally {
        setIsApplying(false);
      }
      return;
    }

    // Slice-2: computeChangeDueMinor throws on under-tender; canConfirm already
    // holds `isSufficient` here.
    onConfirm?.({
      amountAppliedMinor,
      changeDueMinor: computeChangeDueMinor(amountAppliedMinor, remainingBalanceMinor),
    });
  }

  return (
    <section className="cash-entry v5-cash" data-testid="cash-entry" aria-label="إدخال النقد">
      <div className="v5-cash__field">
        <label
          className="v5-cash__label cash-entry__amount-label"
          htmlFor="cash-entry-amount-input"
        >
          المبلغ المستلم (<span dir="ltr">EGP</span>)
        </label>
        <input
          ref={inputRef}
          id="cash-entry-amount-input"
          data-testid="cash-entry-amount-input"
          className="v5-cash__input cash-entry__amount-input"
          type="text"
          inputMode="numeric"
          dir="ltr"
          autoComplete="off"
          aria-invalid={isOutOfRange ? 'true' : undefined}
          aria-describedby={isOutOfRange ? 'cash-entry-out-of-range' : undefined}
          value={rawInput}
          onChange={(e) => {
            const next = normalizeNumericInput(e.target.value);
            // Keystroke guard: digits + optional single decimal, ≤2 frac.
            if (next === '' || /^\d*\.?\d{0,2}$/.test(next)) {
              setAmount(next);
            }
          }}
        />
      </div>

      {/* RT-437 (M-P29) — under the amount it is about, so the cashier corrects
          the figure in place. Never «try again». */}
      {isOutOfRange && (
        <div id="cash-entry-out-of-range">
          <Notice tone="warning" testId="cash-entry-out-of-range">
            المبلغ أكبر من الحد المسموح للنقدية. راجع المبلغ.
          </Notice>
        </div>
      )}

      {/* One group of chips; each SETS the amount (VN-B2), written back as the
          field's own string so the field stays the one source of truth. */}
      {isRemainingValid && (
        <QuickAmounts
          dueMinor={remainingBalanceMinor}
          valueMinor={amountAppliedMinor}
          onSet={(minor) => {
            setAmount(formatMinorToInput(minor));
          }}
        />
      )}

      {/* A view over the same value; written back through formatMinorToInput to
          avoid the 100× parse bug. */}
      <CashKeypad
        valueMinor={amountAppliedMinor}
        onChange={(next) => {
          setAmount(formatMinorToInput(next));
        }}
      />

      {/* Slice-2 under-tender banner. In S3d bridged mode the cashier may apply
          a partial cash line (split tender), so the shortfall is the ledger's
          M-P4 line instead; the main process owns the settlement invariant. */}
      {isUnderTender && !isBridged && (
        <div
          className="cash-entry__refusal"
          data-testid="cash-entry-refusal"
          role="status"
          aria-live="polite"
        >
          المبلغ غير كافٍ لإتمام هذه الدفعة.
        </div>
      )}

      {/* RT-339 (M-P24) — outside the pinned slot, so it stays on screen once
          the read-back shows the money already recorded and the settle takes
          the slot. */}
      {nothingOwed && (
        <Notice tone="warning" testId="cash-entry-nothing-owed">
          لا يوجد مبلغ مستحق على هذا البيع. لم يُسجَّل هذا المبلغ.
        </Notice>
      )}

      <div className="cash-entry__actions">
        {/* RT-238: while money is still owed this is the primary action and it
            lives in the pinned slot; PaymentSurface decides who owns the slot. */}
        <PinnedPrimary>
          {/* The refusal travels with the apply, so it is never below the fold
              while the button is pinned (Codex P2 on #569). */}
          {bridgeRefusal && (
            <div
              className="cash-entry__bridge-refusal"
              data-testid="cash-entry-bridge-refusal"
              role="status"
              aria-live="polite"
            >
              تعذّر تطبيق الدفعة. يرجى المحاولة مرة أخرى.
            </div>
          )}
          <button
            type="button"
            className="cash-entry__confirm checkout-commit"
            data-testid="cash-entry-confirm"
            style={{ minHeight: touchTarget.commit }}
            disabled={!canConfirm || isApplying}
            aria-disabled={!canConfirm || isApplying ? 'true' : undefined}
            onClick={() => {
              void handleConfirm();
            }}
          >
            تأكيد الدفع النقدي
          </button>
        </PinnedPrimary>
        {onBack !== undefined && (
          <button
            type="button"
            className="cash-entry__back"
            data-testid="cash-entry-back"
            style={{ minHeight: touchTarget.min }}
            onClick={onBack}
          >
            رجوع
          </button>
        )}
      </div>
    </section>
  );
}
