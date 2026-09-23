import { useEffect, useId, useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI, SalesBridgeAPI } from '../../../shared/bridge-api.js';
import type { SaleId } from '../../../shared/sales/types.js';

/**
 * T290 — `<PrinterFailureBanner>` (008 Slice 3, /impeccable craft against §A1 §(f)).
 *
 * A persistent, non-modal banner that surfaces a failed receipt print. It is
 * the embodiment of PRODUCT.md Principle 3 ("Failure is loud, never silent"):
 * the sale is already durably finalized at the data layer, so this is a
 * *workflow-degrading*, recoverable condition — amber, not red (DESIGN.md
 * Status-Color Containment). It never auto-dismisses and has no close-X; the
 * only way out is to resolve the condition (retry succeeds, reprint, or manual
 * override).
 *
 * Data source (T261): `sales.subscribe({ topic: 'banner_state' })` for live
 * banner-state push. That handler is currently the `not_implemented` stub (the
 * webContents.send push primitive is unbuilt), so the live subscription is
 * INERT in production today — the banner renders from its injected
 * `printFailure` prop regardless, and degrades gracefully on a refused
 * subscribe. See coordination.md S3c preflight #2 (wired-but-inert gap).
 *
 * Affordance gating (T262 / AD-10): Retry is the live action (calls
 * `receipts.retryPrint` with a fresh idempotency key per FR-053). Reprint is
 * DISABLED until a prior successful print exists (AD-10 precondition —
 * contract line 310); in the failure state none exists, so it is disabled.
 * Manual receipt (T512) calls `receipts.manualOverride` directly with a fresh
 * idempotency key, mirroring Retry: a local in-flight phase guards the button,
 * and the banner dismisses via the parent projection (the manual_override row
 * is a later print_events row, so banner-state-projector stops surfacing the
 * failure) — no local force-dismiss.
 *
 * T512 /impeccable POLISH pass (2026-05-30): the in-flight action now shows the
 * shared `.btn__spinner` (DESIGN.md §5 "loading shows a spinner at the button's
 * leading edge; label remains visible") + `aria-busy` on the active button. The
 * `mutationPhase` value already distinguished retry vs manual-override; the UI
 * now surfaces WHICH action is running instead of only disabling all three —
 * closing the gap PRODUCT.md Principle 3 requires (the cashier must know the
 * real state). Run as `polish` not `craft` because the component shipped green
 * (preflight §4.2: a craft marker against green tests is a violation; polish is
 * the post-merge marker). Spinner is `aria-hidden` — `aria-busy` is the SR
 * signal — and is reduced-motion-neutralised by the global `.btn__spinner` rule.
 */

/** The projected banner state: which sale's print failed + whether reprint is eligible. */
export interface PrinterFailureState {
  sale_id: string;
  failure_reason: string;
  /** AD-10: true iff a prior successful PrintEvent exists → Reprint enabled. */
  has_successful_print: boolean;
}

export interface PrinterFailureBannerProps {
  /** Null → the banner is unmounted (not hidden). Non-null → a print failed. */
  printFailure: PrinterFailureState | null;
  /**
   * Entry-point for the Slice-5 reprint surface (T4xx — `receipts.reprint`
   * does not exist yet); receives the sale id. REQUIRED (not optional) to
   * preserve the enabled⟹wired invariant: the Reprint button is only ever
   * enabled when `has_successful_print`, and an enabled button must always
   * have a real handler (PRODUCT.md Principle 1 — no affordance without a
   * result). Symmetric with `onManualOverride`.
   */
  onReprint: (saleId: string) => void;
  /** Injected for tests; production falls back to `window.api.receipts`. */
  _testReceiptsBridge?: ReceiptsBridgeAPI;
  /** Injected for tests; production falls back to `window.api.sales`. */
  _testSalesBridge?: SalesBridgeAPI;
  /** Injected for tests so the fresh-key assertion is deterministic. */
  _idempotencyKeyFactory?: () => string;
}

function resolveReceiptsBridge(injected?: ReceiptsBridgeAPI): ReceiptsBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { receipts?: ReceiptsBridgeAPI } }).api;
  return api?.receipts ?? null;
}

function resolveSalesBridge(injected?: SalesBridgeAPI): SalesBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { sales?: SalesBridgeAPI } }).api;
  return api?.sales ?? null;
}

function defaultKeyFactory(): string {
  // crypto.randomUUID is available in the renderer (secure context).
  return globalThis.crypto.randomUUID();
}

// A single in-flight phase shared across BOTH mutating actions (Retry +
// Manual receipt). One shared phase means starting either mutation disables ALL
// three action buttons until it settles, so a cashier cannot fire two
// conflicting mutations against the same failed print (CodeRabbit #294). The
// value records which mutation is active (for future per-action affordances);
// the lock itself only cares that it is not `idle`.
type MutationPhase = 'idle' | 'retrying' | 'manual_override';

export function PrinterFailureBanner({
  printFailure,
  onReprint,
  _testReceiptsBridge,
  _testSalesBridge,
  _idempotencyKeyFactory,
}: PrinterFailureBannerProps): JSX.Element | null {
  const messageId = useId();
  const [mutationPhase, setMutationPhase] = useState<MutationPhase>('idle');
  const keyFactory = _idempotencyKeyFactory ?? defaultKeyFactory;

  const saleId = printFailure?.sale_id ?? null;

  // T261 — observe `banner_state` for live updates. The subscription is
  // best-effort: a refused / not_implemented response degrades silently (the
  // banner still renders from `printFailure`). Re-subscribes per active sale;
  // unsubscribes on unmount / sale change.
  useEffect(() => {
    if (saleId === null) return;
    const sales = resolveSalesBridge(_testSalesBridge);
    if (sales === null) return;
    let token: string | null = null;
    let cancelled = false;
    void sales
      .subscribe({ topic: 'banner_state' })
      .then((res) => {
        if (res.kind !== 'ok') return;
        if (cancelled) {
          // Cleanup already ran before subscribe resolved — the token would
          // otherwise leak (no unsubscribe ever issued). Release it now.
          void sales.unsubscribe({ subscription_token: res.subscription_token }).catch(() => {});
          return;
        }
        token = res.subscription_token;
      })
      .catch(() => {
        /* inert subscription — the injected printFailure still drives render */
      });
    return () => {
      cancelled = true;
      if (token !== null) void sales.unsubscribe({ subscription_token: token }).catch(() => {});
    };
  }, [saleId, _testSalesBridge]);

  if (printFailure === null) return null;

  const reprintEnabled = printFailure.has_successful_print;

  const handleRetry = (): void => {
    const bridge = resolveReceiptsBridge(_testReceiptsBridge);
    if (bridge === null) return;
    setMutationPhase('retrying');
    void bridge
      .retryPrint({ sale_id: printFailure.sale_id as SaleId, idempotency_key: keyFactory() })
      .then(() => {
        // The banner's mount/unmount is driven by the parent's projected
        // printFailure (refreshed from banner_state). We only clear the local
        // in-flight phase; a still-failed retry leaves the banner up.
        setMutationPhase('idle');
      })
      .catch(() => {
        setMutationPhase('idle');
      });
  };

  // T512 — Manual receipt override. Mirrors handleRetry: calls
  // `receipts.manualOverride` directly with a fresh key, manages the shared
  // in-flight phase, and lets the parent projection dismiss the banner (the
  // manual_override row supersedes the failure in banner-state-projector — no
  // local force-dismiss).
  const handleManualOverride = (): void => {
    const bridge = resolveReceiptsBridge(_testReceiptsBridge);
    if (bridge === null) return;
    setMutationPhase('manual_override');
    void bridge
      .manualOverride({ sale_id: printFailure.sale_id as SaleId, idempotency_key: keyFactory() })
      .then(() => {
        setMutationPhase('idle');
      })
      .catch(() => {
        setMutationPhase('idle');
      });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-describedby={messageId}
      className="v4-row printer-failure-banner"
      data-testid="printer-failure-banner"
      dir="rtl"
    >
      <PrinterWarningIcon />
      <p id={messageId} className="printer-failure-banner__message">
        <span lang="ar">فشل طباعة الإيصال</span>
        <span aria-hidden="true" className="printer-failure-banner__sep">
          {' — '}
        </span>
        <span lang="en">Receipt print failed</span>
        <span className="printer-failure-banner__hint">
          {' · '}
          <span lang="ar">جرّب مرة أخرى أو حوّل للوضع اليدوي</span>
          <span aria-hidden="true">{' — '}</span>
          <span lang="en">Retry, or switch to manual receipt</span>
        </span>
      </p>
      <div className="v4-row printer-failure-banner__actions">
        <button
          type="button"
          className="btn btn--md btn--primary"
          onClick={handleRetry}
          disabled={mutationPhase !== 'idle'}
          aria-busy={mutationPhase === 'retrying' ? 'true' : undefined}
          aria-label="إعادة المحاولة — Retry print"
        >
          {mutationPhase === 'retrying' && (
            <span className="btn__spinner" role="status" aria-hidden="true" />
          )}
          <span lang="ar">إعادة المحاولة</span>
          <span aria-hidden="true">{' / '}</span>
          <span lang="en">Retry</span>
        </button>
        <button
          type="button"
          className="btn btn--md btn--secondary"
          disabled={!reprintEnabled || mutationPhase !== 'idle'}
          onClick={() => {
            onReprint(printFailure.sale_id);
          }}
          aria-label="نسخة — Reprint"
          title={
            reprintEnabled
              ? undefined
              : 'تتوفر النسخة بعد نجاح الطباعة الأولى — Reprint is available only after a successful print'
          }
        >
          <span lang="ar">نسخة</span>
          <span aria-hidden="true">{' / '}</span>
          <span lang="en">Reprint</span>
        </button>
        <button
          type="button"
          className="btn btn--md btn--ghost"
          onClick={handleManualOverride}
          disabled={mutationPhase !== 'idle'}
          aria-busy={mutationPhase === 'manual_override' ? 'true' : undefined}
          aria-label="إيصال يدوي — Manual receipt"
        >
          {mutationPhase === 'manual_override' && (
            <span className="btn__spinner" role="status" aria-hidden="true" />
          )}
          <span lang="ar">إيصال يدوي</span>
          <span aria-hidden="true">{' / '}</span>
          <span lang="en">Manual receipt</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Printer-with-warning composite — NOT a generic alert triangle (per §A1 brief:
 * the iconography must make the source instantly recognizable so the banner is
 * never confused with the offline banner). Decorative; the message text carries
 * the meaning (color is never the sole signal — FR-068).
 */
function PrinterWarningIcon(): JSX.Element {
  return (
    <svg
      className="printer-failure-banner__icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* printer body */}
      <path
        d="M6 9V4h12v5M6 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1M6 15h12v5H6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* warning mark on the slip */}
      <path
        d="M12 16.5v1.2M12 19.4v.05"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
