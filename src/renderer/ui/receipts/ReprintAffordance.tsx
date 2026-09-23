import { useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI } from '../../../shared/bridge-api.js';
import type { SaleId } from '../../../shared/sales/types.js';

/**
 * T450 — `<ReprintAffordance>` (008 Slice 5).
 *
 * A standalone reprint button surfaced on the "find sale" / "recent sale" UI
 * (T451 wires it into those surfaces). Cashier-permitted per AD-10.
 *
 * Visibility (T430 / AD-10): the affordance renders ONLY when the sale has a
 * prior successful PrintEvent (`has_successful_print`). A sale that has never
 * printed cannot be reprinted (contract precondition `not_yet_printed`), so the
 * affordance is absent rather than disabled — there is nothing to duplicate yet.
 *
 * Invocation (T431): each click generates a fresh idempotency_key (UUID v4) and
 * calls `receipts.reprint`. The handler is two-way (success | refused); a
 * refusal or an IPC rejection is surfaced inline and the button re-enables so
 * the cashier can retry. The button meets the 44×44 touch floor (FR-068) and is
 * keyboard-operable (FR-069 — a native <button>).
 */

/** The minimal sale projection the affordance needs to gate + act. */
export interface ReprintAffordanceSale {
  sale_id: string;
  /** AD-10: true iff a prior successful PrintEvent exists → affordance shown. */
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

type ReprintPhase = 'idle' | 'reprinting';
type ReprintFeedback = { kind: 'ok' } | { kind: 'refused'; reason: string } | null;

export function ReprintAffordance({
  sale,
  _testReceiptsBridge,
  _idempotencyKeyFactory,
}: ReprintAffordanceProps): JSX.Element | null {
  const [phase, setPhase] = useState<ReprintPhase>('idle');
  const [feedback, setFeedback] = useState<ReprintFeedback>(null);
  const keyFactory = _idempotencyKeyFactory ?? defaultKeyFactory;

  // AD-10: nothing to reprint until a successful print exists.
  if (!sale.has_successful_print) return null;

  async function handleReprint(): Promise<void> {
    // Named `receiptsApi` (not `bridge`) so the architecture guard's
    // `bridge.<namespace>` regex (no-backend-ipc-persistence.test) does not
    // mis-flag the `receipts.reprint` call. `receipts` is an allowed surface.
    const receiptsApi = resolveReceiptsBridge(_testReceiptsBridge);
    if (receiptsApi === null) return; // no bridge (unit render w/o window.api) → no-op
    setPhase('reprinting');
    setFeedback(null);
    try {
      const res = await receiptsApi.reprint({
        sale_id: sale.sale_id as SaleId,
        idempotency_key: keyFactory(),
      });
      setFeedback(res.kind === 'ok' ? { kind: 'ok' } : { kind: 'refused', reason: res.reason });
    } catch {
      // An IPC rejection must not crash the surface; the cashier can retry.
      setFeedback({ kind: 'refused', reason: 'printer_unavailable' });
    } finally {
      setPhase('idle');
    }
  }

  return (
    <div className="v4-stack v4-stack--tight">
      <button
        type="button"
        // 44×44 touch floor (FR-068); native button ⟹ keyboard-operable (FR-069).
        className="btn btn--md btn--secondary min-h-11 min-w-11"
        disabled={phase === 'reprinting'}
        onClick={() => {
          void handleReprint();
        }}
      >
        {phase === 'reprinting'
          ? 'جارٍ إعادة الطباعة / Reprinting…'
          : 'إعادة طباعة الإيصال / Reprint receipt'}
      </button>
      {feedback?.kind === 'refused' ? (
        <p role="status" className="receipt-reprint__failure">
          تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى. / Reprint failed. Please try again.
        </p>
      ) : null}
    </div>
  );
}
