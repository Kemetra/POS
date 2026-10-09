import { useState, type JSX } from 'react';

import { validateExternalReference } from '../../../shared/payments/external-reference-format.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { PinnedPrimary } from './CheckoutActionBar.js';
import { mapDigits } from '../forms/normalize-digits.js';
import { formatHumanMoney } from '../format/human-format.js';
import { Notice } from '../../v5/foundation/Notice.js';

/**
 * 006-payments-tender Slice 2 + S3d T151, recomposed for RT-243 W1-C
 * (freeze 15 §2 S10; 06 `CardTerminalEntry`; 08 I-10; VN-R4) —
 * <ExternalCardTerminalEntry>.
 *
 * The cashier charges the standalone terminal, then records the result here.
 * The entry shows three things: the instruction (M-P6), the amount to key into
 * the terminal, and the optional reference (M-P14, 0–6 characters).
 *
 * The amount is a fact, not a field. A card line must equal what is still owed
 * (no overpay and no underpay on a non-cash tender; main refuses either), so the
 * entry records exactly `remainingBalanceMinor` and shows that figure. The
 * editable amount it replaces could only ever be wrong, and its refusal copy
 * was the only way out.
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

export function ExternalCardTerminalEntry({
  remainingBalanceMinor,
  onConfirm,
  onBack,
  paymentAttemptId,
  tenderApply,
  onApplied,
}: ExternalCardTerminalEntryProps): JSX.Element {
  const [referenceInput, setReferenceInput] = useState<string>('');
  const [bridgeRefusal, setBridgeRefusal] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);

  // The card charges what is still owed; nothing to charge is nothing to record.
  const isAmountValid = Number.isSafeInteger(remainingBalanceMinor) && remainingBalanceMinor > 0;
  const isReferenceValid = validateExternalReference(referenceInput);
  const isReferenceProvided = referenceInput !== '';

  const canConfirm = isAmountValid && isReferenceValid && !isApplying;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm) {
      return;
    }

    if (tenderApply !== undefined && paymentAttemptId !== undefined) {
      setBridgeRefusal(false);
      setIsApplying(true);
      try {
        const request: TenderApplyRequest = {
          payment_attempt_id: paymentAttemptId,
          tender_type: 'external_card_terminal',
          amount_applied_minor: remainingBalanceMinor,
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
      amountAppliedMinor: remainingBalanceMinor,
      externalReference: isReferenceProvided ? referenceInput : null,
    });
  }

  return (
    <section
      className="external-card-terminal-entry v5-card"
      data-testid="external-card-terminal-entry"
      aria-label="إدخال مرجع جهاز الشبكة"
    >
      {/* M-P6: the instruction. The terminal does the charge; POS records it. */}
      <Notice tone="info" announce={false} testId="external-card-instruction">
        أكمل العملية على جهاز البطاقات، ثم سجّل النتيجة.
      </Notice>

      {/* The amount to key into the terminal: what is still owed, as a fact. */}
      <p className="v5-card__amount" data-testid="external-card-amount">
        <span className="v5-card__amount-label">المبلغ المُقتطع</span>
        <bdi className="v5-card__amount-value" dir="ltr" data-testid="external-card-amount-value">
          {formatHumanMoney(remainingBalanceMinor)}
        </bdi>
      </p>

      <div className="v5-card__field">
        <label className="v5-card__label" htmlFor="external-card-reference-input">
          المرجع (اختياري، حتى 6 خانات)
        </label>
        {/* SECURITY: the reference field accepts up to 6 chars ^[A-Z0-9]{0,6}$.
            This pattern makes a PAN literally unrepresentable in this field
            (FR-007 / Constitution §P6). A scan here is refused (M-S5). */}
        <input
          id="external-card-reference-input"
          data-scan-refuse="reference"
          data-testid="external-card-reference-input"
          className="v5-card__input"
          type="text"
          inputMode="text"
          autoComplete="off"
          maxLength={6}
          placeholder="T1A2B3"
          dir="ltr"
          aria-invalid={isReferenceProvided && !isReferenceValid ? 'true' : undefined}
          aria-describedby={
            isReferenceProvided && !isReferenceValid ? 'external-card-reference-error' : undefined
          }
          value={referenceInput}
          onChange={(e) => {
            setReferenceInput(mapDigits(e.target.value));
            setBridgeRefusal(false);
          }}
        />
        {isReferenceProvided && !isReferenceValid && (
          <p
            id="external-card-reference-error"
            className="v5-card__error"
            data-testid="external-card-reference-error"
            role="status"
            aria-live="polite"
          >
            صيغة المرجع غير صحيحة. استخدم حتى 6 أحرف إنجليزية كبيرة أو أرقام.
          </p>
        )}
      </div>

      <div className="external-card-terminal-entry__actions">
        {/* RT-238: the primary action lives in the pinned slot; PaymentSurface decides who owns it. */}
        <PinnedPrimary>
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
          <button
            type="button"
            className="external-card-terminal-entry__confirm checkout-commit"
            data-testid="external-card-confirm"
            style={{ minHeight: touchTarget.commit }}
            disabled={!canConfirm}
            aria-disabled={!canConfirm ? 'true' : undefined}
            onClick={() => {
              void handleConfirm();
            }}
          >
            تأكيد معالجة جهاز البطاقات
          </button>
        </PinnedPrimary>
        {onBack !== undefined && (
          <button
            type="button"
            className="external-card-terminal-entry__back"
            data-testid="external-card-back"
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
