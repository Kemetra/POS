import { useMemo, useState, type JSX } from 'react';

import { computeChangeDueMinor } from '../../../shared/payments/money-math.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { parseCurrencyToMinor, formatMinorToInput } from './parse-currency-to-minor.js';
import { quickAmounts } from '../../../shared/payments/quick-amounts.js';
import { AmountPad } from './AmountPad.js';
import { MoneyRoll } from './MoneyRoll.js';

/**
 * 006-payments-tender Slice 2 + S3d T151 — <CashEntry>.
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
}

function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    return '—';
  }
  const whole = Math.floor(minor / 100);
  const frac = Math.abs(minor % 100)
    .toString()
    .padStart(2, '0');
  return `¤${whole.toString()}.${frac}`;
}

export function CashEntry({
  remainingBalanceMinor,
  onConfirm,
  onBack,
  paymentAttemptId,
  tenderApply,
  onApplied,
}: CashEntryProps): JSX.Element {
  const [rawInput, setRawInput] = useState<string>('');
  const [bridgeRefusal, setBridgeRefusal] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);

  const amountAppliedMinor = useMemo(() => parseCurrencyToMinor(rawInput), [rawInput]);

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
  const canConfirm = isBridged
    ? isPositive && isRemainingValid && remainingBalanceMinor > 0
    : isSufficient;

  // computeChangeDueMinor throws on under-tender; only compute it when the
  // cash amount actually covers the remaining balance.
  const changeDueMinor = isSufficient
    ? computeChangeDueMinor(amountAppliedMinor, remainingBalanceMinor)
    : null;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm || amountAppliedMinor === null) {
      return;
    }

    if (tenderApply !== undefined && paymentAttemptId !== undefined) {
      setBridgeRefusal(false);
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

    if (changeDueMinor !== null) {
      onConfirm?.({ amountAppliedMinor, changeDueMinor });
    }
  }

  return (
    <section className="cash-entry" data-testid="cash-entry" aria-label="إدخال النقد">
      {/*
        022 Phase C — the amount due is NOT rendered here.

        `PaymentSurface` owns it, as `.payment-surface__amount-value` at 44px/700
        — the dominant numeric on the surface (FR-16 + design handoff). This
        component mounts inside `.payment-surface__methods`, so the v3.5
        `.amount-due-card` that used to live here put the same value on screen a
        second time at 32px with a different label, which structurally defeats
        the hierarchy FR-16 requires.

        `remainingBalanceMinor` is still received and still drives this
        component's own logic (over-tender guard, change-due, quick amounts) —
        only the duplicate PRESENTATION is gone. No money math changed.
      */}

      {/*
        v3.5 tender-slots / tender-row layout.
        The amount-received row wraps the AmountPad + quick-amount chips.
        The totals row shows the change-due via MoneyRoll (engine-computed,
        no client-side subtraction — computeChangeDueMinor owns the math).
      */}
      <div className="tender-slots">
        <div
          className="tender-row"
          style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-3)' }}
        >
          <label
            className="tender-row__label cash-entry__amount-label"
            htmlFor="cash-entry-amount-input"
          >
            المبلغ المستلم (Amount received ¤)
          </label>
          <span className="tender-row__value" style={{ minWidth: 240, flex: 1 }}>
            <input
              id="cash-entry-amount-input"
              data-testid="cash-entry-amount-input"
              className="cash-entry__amount-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={rawInput}
              onChange={(e) => {
                const next = e.target.value;
                // Keystroke guard: digits + optional single decimal, ≤2 frac.
                if (next === '' || /^\d*\.?\d{0,2}$/.test(next)) {
                  setRawInput(next);
                  setBridgeRefusal(false);
                }
              }}
            />
            {/*
              POS v3.5 — AmountPad is a VIEW over the single `rawInput` source
              of truth. Writes back via formatMinorToInput to avoid the 100×
              parse bug (see Merge Reconciliation note in original component).
            */}
            <AmountPad
              valueMinor={amountAppliedMinor}
              totalMinor={isRemainingValid ? remainingBalanceMinor : 0}
              onChange={(next) => {
                setRawInput(formatMinorToInput(next));
                setBridgeRefusal(false);
              }}
            />

            {/*
              Quick-amount chips (prototype .quick-amounts / .quick-amount-btn).
              The first chip is the "exact" label (بالضبط), subsequent chips are
              rounded-up suggestions. All values dir="ltr" mono (D-006).
              AmountPad already includes quick-keys, but we also surface the
              prototype-style quick-amount chips here so the visual layer matches.
            */}
            <span className="quick-amounts" style={{ marginTop: 'var(--space-2)' }}>
              {/* Exact-amount chip */}
              <button
                type="button"
                className={`quick-amount-btn quick-amount-btn--label${amountAppliedMinor === remainingBalanceMinor ? ' quick-amount-btn--selected' : ''}`}
                onClick={() => {
                  setRawInput(formatMinorToInput(remainingBalanceMinor));
                  setBridgeRefusal(false);
                }}
              >
                بالضبط
              </button>
              {/* Rounded-up suggestion chips (prototype pos-app.jsx:783-789).
                  `quickAmounts` returns ascending banknote roll-ups with the
                  exact total first; we already rendered the exact total as the
                  بالضبط chip above, so drop the leading exact value and render
                  the rounded suggestions. Each chip writes the value back as a
                  currency STRING via `formatMinorToInput` — no money arithmetic
                  here (settlement math stays in computeChangeDueMinor). Values
                  are dir="ltr" mono (D-006). */}
              {isRemainingValid &&
                quickAmounts(remainingBalanceMinor)
                  .filter((v) => v > remainingBalanceMinor)
                  .map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`quick-amount-btn${
                        amountAppliedMinor === v ? ' quick-amount-btn--selected' : ''
                      }`}
                      onClick={() => {
                        setRawInput(formatMinorToInput(v));
                        setBridgeRefusal(false);
                      }}
                    >
                      <span dir="ltr">{formatMinorUnits(v)}</span>
                    </button>
                  ))}
            </span>
          </span>
        </div>

        {/* Totals row: change-due animated via MoneyRoll (engine-computed).
            Only rendered when change is actually owed (> 0); exact cash
            produces changeDueMinor = 0 which should not show the row. */}
        {changeDueMinor !== null && changeDueMinor > 0 && (
          <div
            className="tender-row tender-row--totals cash-entry__change-due"
            data-testid="cash-entry-change-due"
          >
            <span className="tender-row__label">الباقي للعميل (Change due)</span>
            <span className="tender-row__value cash-entry__change-due-value change-row__value--positive">
              ¤<MoneyRoll valueMinor={changeDueMinor} className="cash-entry__change-roll" />
            </span>
          </div>
        )}
      </div>

      {/* Slice-2 under-tender banner. In S3d bridged mode the cashier may apply
          a partial cash line (split tender), so the banner is hidden; the main
          process owns the settlement invariant. */}
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

      <div className="cash-entry__actions">
        <button
          type="button"
          className="cash-entry__confirm"
          data-testid="cash-entry-confirm"
          style={{ minHeight: touchTarget.min }}
          disabled={!canConfirm || isApplying}
          aria-disabled={!canConfirm || isApplying ? 'true' : undefined}
          onClick={() => {
            void handleConfirm();
          }}
        >
          تأكيد الدفع النقدي (Confirm cash payment)
        </button>
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
