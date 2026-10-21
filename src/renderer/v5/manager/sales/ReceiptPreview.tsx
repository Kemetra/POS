import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI, ReceiptsPreviewResponse } from '../../../../shared/bridge-api';
import type { SaleId } from '../../../../shared/sales/types';
import { Dialog, DialogHost, useHasDialogHost } from '../../foundation/Dialog';
import { Notice } from '../../foundation/Notice';
import { SALES_COPY } from './sales-copy';
import './sales.css';
import './receipt-preview.css';

/**
 * RT-659 — the receipt preview on the one V5 Dialog (G-6 addendum,
 * G6P-Receipt-Preview, owner option A, 2026-10-17). Replaces the 008
 * `ui/receipts/ReceiptPreview` (inline styles, its own ✕, zoom and a
 * «طباعة» that could never be pressed).
 *
 * - Modal: the frame behind is inert, Tab stays inside, Esc closes and focus
 *   returns to «معاينة الإيصال» (the Dialog).
 * - «إغلاق» is the only control and takes focus on open. Reprint stays on the
 *   result row; the dialog prints nothing.
 * - The sale number sits under the title as an LTR code and describes the
 *   dialog. No accessible name carries the sale id.
 * - The slip is the main-process engine's minimised HTML, unchanged, in a
 *   focusable scroll region at the 12px floor (80mm, so no zoom). The trust
 *   boundary is main: the engine never emits card or voucher data (T130-134).
 *
 * Reads `receipts.preview` once per sale (read-only, no side effects).
 */

export interface ReceiptPreviewProps {
  saleId: string;
  saleNumber: string;
  onClose: () => void;
  /** Injected for tests; production falls back to `window.api.receipts`. */
  _testBridge?: ReceiptsBridgeAPI;
}

type LoadState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'failed' };

function resolveBridge(injected?: ReceiptsBridgeAPI): ReceiptsBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { receipts?: ReceiptsBridgeAPI } }).api;
  return api?.receipts ?? null;
}

function usePreview(saleId: string, injected?: ReceiptsBridgeAPI): LoadState {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const receiptsApi = resolveBridge(injected);
    if (receiptsApi === null) {
      setState({ phase: 'failed' });
      return;
    }
    setState({ phase: 'loading' });
    receiptsApi
      .preview({ sale_id: saleId as SaleId, idempotency_key: `preview-${saleId}` })
      .then((res: ReceiptsPreviewResponse) => {
        if (!cancelled) {
          setState(
            res.kind === 'ok' ? { phase: 'ready', html: res.preview.html } : { phase: 'failed' },
          );
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [saleId, injected]);

  return state;
}

function SlipWell({ state }: Readonly<{ state: LoadState }>): JSX.Element {
  if (state.phase === 'ready') {
    return (
      // A scrollable region must be reachable by keyboard (axe
      // scrollable-region-focusable), so the well takes a tab stop.
      <div
        className="v5-receipt-well"
        role="region"
        aria-label={SALES_COPY.previewSlip}
        tabIndex={0}
      >
        {/* The engine's minimised output; main is the sanitisation point. */}
        <div className="v5-receipt-slip" dangerouslySetInnerHTML={{ __html: state.html }} />
      </div>
    );
  }
  return (
    <div className="v5-receipt-well v5-receipt-well--message">
      {state.phase === 'loading' ? (
        <p role="status" className="v5-receipt-loading">
          {SALES_COPY.previewLoading}
        </p>
      ) : (
        <Notice tone="warning">{SALES_COPY.previewFailed}</Notice>
      )}
    </div>
  );
}

function PreviewDialog({
  saleId,
  saleNumber,
  onClose,
  _testBridge,
}: Readonly<ReceiptPreviewProps>): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const numberId = useId();
  const state = usePreview(saleId, _testBridge);

  return (
    <Dialog
      label={SALES_COPY.preview}
      onCancel={onClose}
      initialFocusRef={closeRef}
      describedBy={numberId}
    >
      <div className="v5-receipt-head">
        <h2>{SALES_COPY.preview}</h2>
        <p id={numberId}>
          <bdi dir="ltr">{saleNumber}</bdi>
        </p>
      </div>
      <SlipWell state={state} />
      <div className="v5-receipt-actions">
        <button
          ref={closeRef}
          type="button"
          className="v5-sales-btn v5-sales-btn--primary v5-btn v5-btn--primary"
          onClick={onClose}
        >
          {SALES_COPY.previewClose}
        </button>
      </div>
    </Dialog>
  );
}

export function ReceiptPreview(props: Readonly<ReceiptPreviewProps>): JSX.Element {
  // Inside the V5 frame the dialog portals into the frame's host; standalone
  // (tests) it brings its own.
  const hasHost = useHasDialogHost();
  if (hasHost) return <PreviewDialog {...props} />;
  return (
    <DialogHost>
      <PreviewDialog {...props} />
    </DialogHost>
  );
}
