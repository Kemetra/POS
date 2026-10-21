import { useEffect, useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI, SalesBridgeAPI } from '../../../shared/bridge-api.js';
import type { SaleId } from '../../../shared/sales/types.js';
import { Banner } from '../../v5/foundation/Banner';

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
 *
 * RT-605 (owner scope extension, 2026-10-17): restyled onto the V5 warning
 * `Banner` in the notices stack, with V5 banner buttons and its own printer
 * glyph (never the offline banner's triangle). The spinner is now
 * `.v5-banner__spinner`. Copy, actions, reprint gating, `aria-busy` and the
 * `banner_state` feed are unchanged.
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
}: Readonly<PrinterFailureBannerProps>): JSX.Element | null {
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
    <Banner
      tone="warning"
      icon="print"
      testId="printer-failure-banner"
      actions={
        <>
          <button
            type="button"
            className="v5-btn"
            onClick={handleRetry}
            disabled={mutationPhase !== 'idle'}
            aria-busy={mutationPhase === 'retrying' ? 'true' : undefined}
          >
            {mutationPhase === 'retrying' && <BusySpinner />}
            <span lang="ar">إعادة المحاولة</span>
          </button>
          <button
            type="button"
            className="v5-btn"
            disabled={!reprintEnabled || mutationPhase !== 'idle'}
            onClick={() => {
              onReprint(printFailure.sale_id);
            }}
            title={reprintEnabled ? undefined : 'تتوفر النسخة بعد نجاح الطباعة الأولى'}
          >
            <span lang="ar">نسخة</span>
          </button>
          <button
            type="button"
            className="v5-btn"
            onClick={handleManualOverride}
            disabled={mutationPhase !== 'idle'}
            aria-busy={mutationPhase === 'manual_override' ? 'true' : undefined}
          >
            {mutationPhase === 'manual_override' && <BusySpinner />}
            <span lang="ar">إيصال يدوي</span>
          </button>
        </>
      }
    >
      <p>
        <span lang="ar">فشل طباعة الإيصال</span>
        {' · '}
        <span lang="ar">جرّب مرة أخرى أو حوّل للوضع اليدوي</span>
      </p>
    </Banner>
  );
}

/** The running action's spinner; `aria-busy` on its button is the SR signal. */
function BusySpinner(): JSX.Element {
  return <span className="v5-banner__spinner" aria-hidden="true" />;
}
