import { useMemo, useState, type JSX } from 'react';

import { validateExternalReference } from '../../../shared/payments/external-reference-format.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { parseCurrencyToMinor, formatMinorToInput } from './parse-currency-to-minor.js';

/**
 * 006-payments-tender Slice 2 + S3d T151 — <ExternalCardTerminalEntry>.
 *
 * Modes:
 *   • Slice-2 (display-only): caller passes `onConfirm`. Confirm fires with
 *     `{ amountAppliedMinor, externalReference }`.
 *   • S3d (bridged): caller additionally passes `paymentAttemptId`,
 *     `tenderApply`, `onApplied`. Confirm builds a `TenderApplyRequest`
 *     with a fresh UUID v4 idempotency_key, calls the bridge, and either
 *     fires `onApplied(response)` on success or renders generic refusal
 *     copy on `{ kind: 'refused' }`.
 *
 * SECURITY (FR-007 / FR-008 / Constitution §P6 / §P7):
 *   - No PAN / CVV / track / cardholder / expiry / auth-payload fields.
 *   - external_reference is regex-bounded to ^[A-Z0-9]{0,6}$ which makes
 *     a PAN literally unrepresentable in this field.
 *   - Generic refusal copy at the renderer; the structured reason names
 *     never cross into the DOM.
 */

export interface ExternalCardTerminalEntryProps {
  remainingBalanceMinor: number;
  /**
   * Slice-2 callback. When `tenderApply` is provided, this is NOT invoked —
   * the bridge response is surfaced through `onApplied` instead.
   */
  onConfirm?: (applied: { amountAppliedMinor: number; externalReference: string | null }) => void;
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

export function ExternalCardTerminalEntry({
  remainingBalanceMinor,
  onConfirm,
  onBack,
  paymentAttemptId,
  tenderApply,
  onApplied,
}: ExternalCardTerminalEntryProps): JSX.Element {
  const [amountInput, setAmountInput] = useState<string>(() =>
    formatMinorToInput(remainingBalanceMinor),
  );
  const [referenceInput, setReferenceInput] = useState<string>('');
  const [bridgeRefusal, setBridgeRefusal] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);

  const amountAppliedMinor = useMemo(() => parseCurrencyToMinor(amountInput), [amountInput]);
  const isExactAmount = amountAppliedMinor === remainingBalanceMinor;
  const isOverpay = amountAppliedMinor !== null && amountAppliedMinor > remainingBalanceMinor;
  const isUnderpay = amountAppliedMinor !== null && amountAppliedMinor < remainingBalanceMinor;

  const isReferenceValid = validateExternalReference(referenceInput);
  const isReferenceProvided = referenceInput !== '';

  const canConfirm = isExactAmount && isReferenceValid && !isApplying;

  async function handleConfirm(): Promise<void> {
    if (amountAppliedMinor === null || !isExactAmount) {
      return;
    }

    if (tenderApply !== undefined && paymentAttemptId !== undefined) {
      setBridgeRefusal(false);
      setIsApplying(true);
      try {
        const request: TenderApplyRequest = {
          payment_attempt_id: paymentAttemptId,
          tender_type: 'external_card_terminal',
          amount_applied_minor: amountAppliedMinor,
          idempotency_key: crypto.randomUUID(),
          ...(isReferenceProvided ? { external_reference: referenceInput } : {}),
        };
        const response = await tenderApply(request);
        if (response.kind === 'ok') {
          onApplied?.(response);
        } else {
          setBridgeRefusal(true);
        }
      } catch {
        // CR-7: bridge rejection (network / IPC layer error). Surface generic
        // copy; never let the promise reject up as an unhandled rejection
        // through `void handleConfirm()`.
        setBridgeRefusal(true);
      } finally {
        setIsApplying(false);
      }
      return;
    }

    onConfirm?.({
      amountAppliedMinor,
      externalReference: isReferenceProvided ? referenceInput : null,
    });
  }

  return (
    <section
      className="external-card-terminal-entry"
      data-testid="external-card-terminal-entry"
      aria-label="إدخال مرجع جهاز الشبكة"
    >
      {/*
        POS v3.5 Slice 4 — amount-due-card (prototype TenderScreen structure).
        Value is dir="ltr" mono (D-006 — money is never bidi-reordered).
      */}
      <div className="amount-due-card">
        <span className="amount-due-card__label">المطلوب دفعه (Amount due)</span>
        <span className="amount-due-card__value" dir="ltr">
          {formatMinorUnits(remainingBalanceMinor)}
        </span>
      </div>

      {/*
        v3.5 tender-slots / tender-row layout for the card terminal path.
        Row 1: instruction (tender-row__body — Arabic + English).
        Row 2: exact-amount input field.
        Row 3 (totals): the charged amount in a dir="ltr" mono span.
        The card reference input is below the slots (not part of the
        prototype's tender-row structure; kept as a functional field).
      */}
      <div className="tender-slots">
        {/* Instruction row */}
        <div className="tender-row">
          <span className="tender-row__label">جهاز الدفع</span>
          <span className="tender-row__body">
            أكمل العملية على جهاز البطاقات ثم أكّد. (Complete on the card terminal, then confirm.)
          </span>
        </div>

        {/* Amount input row */}
        <div className="tender-row" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <label
            className="tender-row__label external-card-terminal-entry__amount-label"
            htmlFor="external-card-amount-input"
          >
            المبلغ المخصوم (Amount applied ¤)
          </label>
          <span className="tender-row__value">
            <input
              id="external-card-amount-input"
              data-testid="external-card-amount-input"
              className="external-card-terminal-entry__amount-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={amountInput}
              onChange={(e) => {
                const next = e.target.value;
                if (next === '' || /^\d*\.?\d{0,2}$/.test(next)) {
                  setAmountInput(next);
                  setBridgeRefusal(false);
                }
              }}
            />
          </span>
        </div>

        {/* Totals row: the amount in a dir="ltr" mono span (D-006). */}
        <div className="tender-row tender-row--totals">
          <span className="tender-row__label">المبلغ المُقتطع</span>
          <span className="tender-row__value">
            <span dir="ltr" className="mono">
              {formatMinorUnits(remainingBalanceMinor)}
            </span>
          </span>
        </div>
      </div>

      {isOverpay && (
        <div
          className="external-card-terminal-entry__refusal"
          data-testid="external-card-refusal"
          role="status"
          aria-live="polite"
        >
          The amount must be exact for a card-terminal payment.
        </div>
      )}

      {isUnderpay && (
        <div
          className="external-card-terminal-entry__refusal"
          data-testid="external-card-refusal-underpay"
          role="status"
          aria-live="polite"
        >
          The amount must match the remaining balance.
        </div>
      )}

      <label
        className="external-card-terminal-entry__reference-label"
        htmlFor="external-card-reference-input"
      >
        المرجع (Reference, optional, 6 chars max)
      </label>
      {/* SECURITY: the reference field accepts up to 6 chars ^[A-Z0-9]{0,6}$.
          This pattern makes a PAN literally unrepresentable in this field
          (FR-007 / Constitution §P6). */}
      <input
        id="external-card-reference-input"
        data-testid="external-card-reference-input"
        className="external-card-terminal-entry__reference-input"
        type="text"
        inputMode="text"
        autoComplete="off"
        maxLength={6}
        placeholder="مثال: T1A2B3"
        dir="ltr"
        value={referenceInput}
        onChange={(e) => {
          setReferenceInput(e.target.value);
          setBridgeRefusal(false);
        }}
      />

      {isReferenceProvided && !isReferenceValid && (
        <div
          className="external-card-terminal-entry__reference-error"
          data-testid="external-card-reference-error"
          role="status"
          aria-live="polite"
        >
          Reference format is invalid. Use up to 6 uppercase letters or digits.
        </div>
      )}

      {bridgeRefusal && (
        <div
          className="external-card-terminal-entry__bridge-refusal"
          data-testid="external-card-bridge-refusal"
          role="status"
          aria-live="polite"
        >
          تعذّر تطبيق الدفعة. يرجى المحاولة مرة أخرى.
        </div>
      )}

      <div className="external-card-terminal-entry__actions">
        <button
          type="button"
          className="external-card-terminal-entry__confirm"
          data-testid="external-card-confirm"
          style={{ minHeight: touchTarget.min }}
          disabled={!canConfirm}
          aria-disabled={!canConfirm ? 'true' : undefined}
          onClick={() => {
            void handleConfirm();
          }}
        >
          تأكيد معالجة جهاز البطاقات (Confirm terminal processed payment)
        </button>
        {onBack !== undefined && (
          <button
            type="button"
            className="external-card-terminal-entry__back"
            data-testid="external-card-back"
            style={{ minHeight: touchTarget.min }}
            onClick={onBack}
          >
            Back
          </button>
        )}
      </div>
    </section>
  );
}
