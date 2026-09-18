import { useMemo, useRef, useState, type JSX } from 'react';

import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { parseCurrencyToMinor } from './parse-currency-to-minor.js';

/**
 * 006-payments-tender Slice 4 T290 — <VoucherEntry>.
 *
 * Wave 5c renderer surface. Mounts inside PaymentSurface when the
 * cashier selects the `internal_voucher` tender slot. Calls
 * `tender.apply` with `tender_type: 'internal_voucher'` + the typed
 * voucher code + the cashier-supplied amount.
 *
 * The bridge handler (T263 — extended in Wave 4) routes the call to
 * the voucher-authority-client V-A client (T250 — Wave 3) which validates
 * against Data-Pulse-2. On success the line is persisted with state
 * `applied` and the intent token stays main-side (FR-017).
 *
 * SECURITY:
 *   - F-A4B-003 enforcement: all 8 voucher refusal reasons map to
 *     ONE generic renderer copy string. The structured `refusal.reason`
 *     NEVER enters the DOM — that's the §A4-B reviewer decision
 *     recorded in `reviews/a4b-vouchers-bridge-brief.md` §6.
 *   - FR-017: no voucher tokens, no voucher balance, no holder PII,
 *     no campaign metadata in props or rendered output. The voucher
 *     code IS rendered (it's the cashier's own input).
 *   - Money is integer minor units only (Constitution §P9 / P-II).
 *   - No factor-distinguishing copy on refusal (FR-022 / NFR-003 /
 *     PR-2 inherited from 004).
 */

export interface VoucherEntryProps {
  /** Remaining cart balance in minor units; defines the cashier's amount ceiling. */
  remainingBalanceMinor: number;
  /** Payment attempt id from the main process. */
  paymentAttemptId: string;
  /** Bridge callback. Receives a fully-formed TenderApplyRequest. */
  tenderApply: (req: TenderApplyRequest) => Promise<TenderApplyResponse>;
  /** Fires with the `{ kind: 'ok', ... }` response on successful apply. */
  onApplied?: (response: Extract<TenderApplyResponse, { kind: 'ok' }>) => void;
}

/**
 * F-A4B-003 reviewer decision: every voucher refusal reason — closed
 * enum from `contracts/bridge-api.md` §"vouchers.*" + spec FR-006 —
 * maps to this single renderer string. An attacker cannot enumerate
 * voucher validity, balance, or holder existence by probing codes
 * against the POS surface; only the audit log distinguishes.
 */
const GENERIC_VOUCHER_REFUSAL_COPY = 'This voucher cannot be used right now.';

const VOUCHER_CODE_PATTERN = /^[A-Z0-9_-]+$/;

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

function generateIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function VoucherEntry({
  remainingBalanceMinor,
  paymentAttemptId,
  tenderApply,
  onApplied,
}: VoucherEntryProps): JSX.Element {
  const [voucherCode, setVoucherCode] = useState<string>('');
  const [rawAmountInput, setRawAmountInput] = useState<string>('');
  const [bridgeRefusal, setBridgeRefusal] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [appliedOk, setAppliedOk] = useState<boolean>(false);

  // CR-1 (PR #226): React's `disabled` reflects state asynchronously,
  // so two rapid clicks can dispatch two bridge calls before
  // `isApplying` re-renders the button. Because each submission
  // generates a FRESH UUID v4 idempotency_key, the main-process
  // §P5 dedup would NOT collapse the duplicates — each call looks
  // like a distinct intent. The synchronous ref-lock guards against
  // double-fire deterministically; the render-state `disabled` stays
  // as secondary UX feedback.
  const submitLockRef = useRef<boolean>(false);

  const amountAppliedMinor = useMemo(() => parseCurrencyToMinor(rawAmountInput), [rawAmountInput]);

  const codeIsWellFormed = voucherCode.length >= 3 && VOUCHER_CODE_PATTERN.test(voucherCode);
  // CR-2 (PR #226): defence-in-depth — a malformed `remainingBalanceMinor`
  // prop (NaN / Infinity / negative / non-integer) would otherwise let
  // `amountIsWellFormed` evaluate `<=` against a non-money value. The
  // upstream caller (PaymentSurface) already guards this, but the
  // Constitution §P-II posture is "validate at every layer that
  // consumes money".
  const remainingBalanceIsValid =
    Number.isSafeInteger(remainingBalanceMinor) && remainingBalanceMinor >= 0;
  const amountIsWellFormed =
    remainingBalanceIsValid &&
    amountAppliedMinor !== null &&
    amountAppliedMinor > 0 &&
    amountAppliedMinor <= remainingBalanceMinor;

  const canSubmit = codeIsWellFormed && amountIsWellFormed && !isApplying;

  const handleSubmit = (): void => {
    // Synchronous ref-lock first — beats React's render-state lag
    // against rapid double-clicks.
    if (submitLockRef.current) {
      return;
    }
    // Use the raw `amountAppliedMinor` null-check as the guard — this
    // narrows the type cleanly. `canSubmit` is a downstream boolean
    // derived from the same value plus the upper-bound check; checking
    // both `amountAppliedMinor !== null` AND `canSubmit` gives the
    // narrowing without tripping eslint's no-unnecessary-condition.
    if (amountAppliedMinor === null || !canSubmit) {
      return;
    }
    submitLockRef.current = true;
    const amount = amountAppliedMinor;
    setBridgeRefusal(false);
    setIsApplying(true);
    void (async (): Promise<void> => {
      try {
        const response = await tenderApply({
          payment_attempt_id: paymentAttemptId,
          tender_type: 'internal_voucher',
          amount_applied_minor: amount,
          voucher_code: voucherCode,
          idempotency_key: generateIdempotencyKey(),
        });
        if (response.kind === 'ok') {
          setAppliedOk(true);
          onApplied?.(response);
          return;
        }
        // F-A4B-003: every refusal reason collapses to one generic copy.
        // The structured `response.reason` is intentionally NOT rendered.
        setBridgeRefusal(true);
      } catch {
        // A rejected bridge call (IPC error / main-process crash /
        // timeout) MUST NOT leave the surface stuck in `isApplying`.
        // Same generic refusal copy — error details stay upstream.
        setBridgeRefusal(true);
      } finally {
        setIsApplying(false);
        submitLockRef.current = false;
      }
    })();
  };

  return (
    <section className="voucher-entry" data-testid="voucher-entry" aria-label="Apply voucher">
      {/*
        POS v3.5 Slice 4 — amount-due-card (prototype TenderScreen structure).
        Value is dir="ltr" mono (D-006 — money is never bidi-reordered).
      */}
      <div className="amount-due-card">
        <span className="amount-due-card__label">المطلوب دفعه (Amount due)</span>
        <span className="amount-due-card__value" dir="ltr" data-testid="voucher-entry-remaining">
          {formatMinorUnits(remainingBalanceMinor)}
        </span>
      </div>

      {/*
        v3.5 tender-slots / tender-row layout for the voucher path.
        SECURITY invariants (F-A4B-003 / FR-017):
          - The voucher code IS rendered (cashier's own input).
          - No voucher balance, holder PII, or campaign metadata in props or DOM.
          - All 8 refusal reasons collapse to GENERIC_VOUCHER_REFUSAL_COPY only.
          - Client-side voucher lookup is FORBIDDEN — validity is resolved
            MAIN-SIDE via the V-A client. No VOUCHERS table, no voucherKnown.
      */}
      <div className="tender-slots">
        {/* Voucher code row — voucher-field wraps the input + applied indicator */}
        <div className="tender-row">
          <span className="tender-row__label">رمز القسيمة</span>
          <span className="tender-row__value">
            <span className="voucher-field">
              <input
                type="text"
                data-testid="voucher-entry-code-input"
                dir="ltr"
                placeholder="VCH-000"
                aria-label="رمز القسيمة"
                value={voucherCode}
                onChange={(e) => {
                  // Voucher codes are upper-case per receipt convention.
                  setVoucherCode(e.target.value.toUpperCase());
                  if (bridgeRefusal) setBridgeRefusal(false);
                  if (appliedOk) setAppliedOk(false);
                }}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                aria-invalid={voucherCode.length > 0 && !codeIsWellFormed ? 'true' : undefined}
              />
              {/* SECURITY: appliedOk is set only by the bridge ok response.
                  It does NOT reflect any client-side table lookup. */}
              {appliedOk && (
                <span className="voucher-applied voucher-applied--ok" aria-label="Voucher applied">
                  ✓
                </span>
              )}
            </span>
          </span>
        </div>

        {/* Amount-to-apply row */}
        <div className="tender-row">
          <label className="tender-row__label voucher-entry__label" htmlFor="voucher-amount-input">
            المبلغ المطبّق (Amount to apply ¤)
          </label>
          <span className="tender-row__value">
            <input
              id="voucher-amount-input"
              type="text"
              data-testid="voucher-entry-amount-input"
              value={rawAmountInput}
              onChange={(e) => {
                const next = e.target.value;
                if (next === '' || /^\d*\.?\d{0,2}$/.test(next)) {
                  setRawAmountInput(next);
                  if (bridgeRefusal) setBridgeRefusal(false);
                }
              }}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={rawAmountInput.length > 0 && !amountIsWellFormed ? 'true' : undefined}
            />
          </span>
        </div>
      </div>

      {/* Voucher code error: shown when code length >= 2 but malformed (not well-formed).
          SECURITY: this is a FORMAT error only, NOT a validity signal.
          The bridge is the only authority on voucher validity (F-A4B-003). */}
      {voucherCode.length > 0 && !codeIsWellFormed && (
        <p className="voucher-error" role="status">
          رمز القسيمة غير صالح — يجب ألا يقل عن ٣ أحرف.
        </p>
      )}

      {/* Voucher hint: generic input guidance, no demo codes (SECURITY). */}
      <p className="voucher-hint">أدخل رمز القسيمة والمبلغ المطلوب تطبيقه، ثم اضغط «تطبيق».</p>

      <button
        type="button"
        className="voucher-entry__confirm"
        data-testid="voucher-entry-confirm"
        style={{ minHeight: touchTarget.min }}
        disabled={!canSubmit}
        aria-disabled={!canSubmit ? 'true' : undefined}
        onClick={handleSubmit}
      >
        تطبيق القسيمة (Apply voucher)
      </button>

      {isApplying && (
        <div data-testid="voucher-entry-applying" aria-busy="true">
          جارٍ التطبيق… (Applying…)
        </div>
      )}

      {bridgeRefusal && (
        <div data-testid="voucher-entry-refused" role="alert">
          {GENERIC_VOUCHER_REFUSAL_COPY}
        </div>
      )}
    </section>
  );
}
