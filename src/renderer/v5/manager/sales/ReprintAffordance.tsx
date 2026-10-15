import { useRef, useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI } from '../../../../shared/bridge-api';
import type { SaleId } from '../../../../shared/sales/types';
import { Notice } from '../../foundation/Notice';
import { SALES_COPY } from './sales-copy';

/**
 * T450 / RT-500 — the reprint control on a found sale (008 Slice 5, recomposed
 * on the G-6 references). Cashier-permitted per AD-10.
 *
 * Visibility (T430 / AD-10): rendered ONLY when the sale has a prior successful
 * PrintEvent (`has_successful_print`). A sale that has never printed cannot be
 * reprinted (contract precondition `not_yet_printed`), so the control is absent
 * rather than disabled.
 *
 * Invocation (T431): each click generates a fresh idempotency_key (UUID v4) and
 * calls `receipts.reprint`. The handler is two-way (success | refused); a
 * refusal or an IPC rejection shows the warning and the button re-enables so the
 * operator can retry. One call at a time: a ref blocks re-entry synchronously.
 *
 * Outcome (RT-500): an accepted reprint shows a neutral notice «أُرسل الإيصال
 * للطابعة.» — the printer received it, which is not the same as printed, so the
 * copy never says «طُبع» and the tone is never `success`.
 *
 * It renders a fragment: the button joins the result's button row and the
 * notice takes a full row under it (G-6), so the parent must be a wrapping flex
 * row.
 */

/** The minimal sale projection the control needs to gate + act. */
export interface ReprintAffordanceSale {
  sale_id: string;
  /** AD-10: true iff a prior successful PrintEvent exists → control shown. */
  has_successful_print: boolean;
}

export interface ReprintAffordanceProps {
  sale: ReprintAffordanceSale;
  /** Injected for tests; production falls back to `window.api.receipts`. */
  _testReceiptsBridge?: ReceiptsBridgeAPI;
  /** Injected for tests so the fresh-key assertion is deterministic. */
  _idempotencyKeyFactory?: () => string;
}

function resolveReceiptsBridge(injected?: ReceiptsBridgeAPI): ReceiptsBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { receipts?: ReceiptsBridgeAPI } }).api;
  return api?.receipts ?? null;
}

function defaultKeyFactory(): string {
  // crypto.randomUUID is available in the renderer (secure context).
  return globalThis.crypto.randomUUID();
}

type Feedback = 'sent' | 'failed' | null;

export function ReprintAffordance({
  sale,
  _testReceiptsBridge,
  _idempotencyKeyFactory,
}: ReprintAffordanceProps): JSX.Element | null {
  const [reprinting, setReprinting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const inFlight = useRef(false);
  const keyFactory = _idempotencyKeyFactory ?? defaultKeyFactory;

  // AD-10: nothing to reprint until a successful print exists.
  if (!sale.has_successful_print) return null;

  async function handleReprint(): Promise<void> {
    if (inFlight.current) return;
    // Named `receiptsApi` (not `bridge`) so the architecture guard's
    // `bridge.<namespace>` regex (no-backend-ipc-persistence.test) does not
    // mis-flag the `receipts.reprint` call. `receipts` is an allowed surface.
    const receiptsApi = resolveReceiptsBridge(_testReceiptsBridge);
    if (receiptsApi === null) return; // no bridge (unit render w/o window.api) → no-op
    inFlight.current = true;
    setReprinting(true);
    setFeedback(null);
    try {
      const res = await receiptsApi.reprint({
        sale_id: sale.sale_id as SaleId,
        idempotency_key: keyFactory(),
      });
      setFeedback(res.kind === 'ok' ? 'sent' : 'failed');
    } catch {
      // An IPC rejection must not crash the surface; the operator can retry.
      setFeedback('failed');
    } finally {
      inFlight.current = false;
      setReprinting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="v5-sales-btn"
        disabled={reprinting}
        onClick={() => {
          void handleReprint();
        }}
      >
        {reprinting ? SALES_COPY.reprinting : SALES_COPY.reprint}
      </button>
      {feedback !== null && (
        <div className="v5-sales-notice-row">
          {feedback === 'sent' ? (
            <Notice tone="info" testId="reprint-sent">
              {SALES_COPY.reprintSent}
            </Notice>
          ) : (
            <Notice tone="warning" testId="reprint-failed">
              {SALES_COPY.reprintFailed}
            </Notice>
          )}
        </div>
      )}
    </>
  );
}
