import { useEffect, useId, useRef, useState, type CSSProperties, type JSX } from 'react';

import type { ReceiptsBridgeAPI, ReceiptsPreviewResponse } from '../../../shared/bridge-api.js';
import type { SaleId } from '../../../shared/sales/types.js';

/**
 * T173 — `<ReceiptPreview>` (008 Slice 2, /impeccable craft against §A1 §(d)).
 *
 * A non-modal dialog card that fetches `receipts.preview` and renders the
 * AD-6 engine's slip HTML in a Lifted-Canvas inset — the preview reads as a
 * physical slip on a holder, not inline content. Honest-surface principle:
 * loading and refusal states are explicit; nothing is faked.
 *
 * Scope (S2): render + close + zoom + a11y + loading/error. The "Print" button
 * is present per the brief but its action (`receipts.print` via the AD-2
 * listener side-effect, AD-5) wires in Slice 3 — it is disabled here with a
 * title that says so, rather than rendered as a dead control that lies.
 *
 * Security: the slip HTML comes from the main-process engine, which only ever
 * emits the minimised ReceiptPayload (no card/voucher data — see the T130-134
 * minimisation tests). The renderer mounts it via dangerouslySetInnerHTML; the
 * trust boundary is the main process, not this component.
 */

export interface ReceiptPreviewProps {
  saleId: string;
  onClose: () => void;
  /** Injected for tests; production falls back to `window.api.receipts`. */
  _testBridge?: ReceiptsBridgeAPI;
}

type LoadState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'error' };

function resolveBridge(injected?: ReceiptsBridgeAPI): ReceiptsBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { receipts?: ReceiptsBridgeAPI } }).api;
  return api?.receipts ?? null;
}

export function ReceiptPreview({ saleId, onClose, _testBridge }: ReceiptPreviewProps): JSX.Element {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [zoomed, setZoomed] = useState(false);

  // Fetch the preview once on mount / when the sale changes.
  useEffect(() => {
    let cancelled = false;
    const bridge = resolveBridge(_testBridge);
    if (bridge === null) {
      setState({ phase: 'error' });
      return;
    }
    setState({ phase: 'loading' });
    bridge
      .preview({ sale_id: saleId as SaleId, idempotency_key: `preview-${saleId}` })
      .then((res: ReceiptsPreviewResponse) => {
        if (cancelled) return;
        setState(
          res.kind === 'ok' ? { phase: 'ready', html: res.preview.html } : { phase: 'error' },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [saleId, _testBridge]);

  // Focus the title on mount (a11y: dialog receives focus); Escape closes.
  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const cardStyle: CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    borderRadius: 'var(--radius-card)',
    boxShadow: 'var(--shadow-pane)',
    display: 'flex',
    flexDirection: 'column',
    maxBlockSize: '100%',
  };

  const titleBandStyle: CSSProperties = {
    blockSize: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingInline: '24px',
    borderBlockEnd: '1px solid var(--color-border, #d8dfe7)',
  };

  const canvasRegionStyle: CSSProperties = {
    backgroundColor: 'var(--color-surface-elevated)',
    padding: '24px',
    flex: '1 1 auto',
    overflow: 'auto',
  };

  const slipStyle: CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    inlineSize: zoomed ? '160mm' : '80mm',
    marginInline: 'auto',
    padding: '12px',
    fontFamily: "ui-monospace, 'Cascadia Code', monospace",
    fontSize: zoomed ? '1.4rem' : '0.7rem',
    lineHeight: 1.35,
    transition: 'opacity 100ms linear',
    boxShadow: 'var(--shadow-card, 0 1px 2px rgba(15,29,46,0.06))',
  };

  const footerStyle: CSSProperties = {
    blockSize: '56px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingInline: '24px',
    backgroundColor: 'var(--color-surface-elevated)',
    borderBlockStart: '1px solid var(--color-border-soft, #e7ecf2)',
  };

  const btnBase: CSSProperties = {
    minBlockSize: '44px',
    minInlineSize: '44px',
    borderRadius: 'var(--radius-control)',
    paddingInline: 'var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-md)',
    fontWeight: 'var(--font-weight-semibold)',
  };

  const primaryBtn: CSSProperties = {
    ...btnBase,
    backgroundColor: 'var(--color-primary)',
    color: 'var(--color-primary-on)',
    border: 'none',
    opacity: 0.5,
    cursor: 'not-allowed',
  };

  const secondaryBtn: CSSProperties = {
    ...btnBase,
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text, #0f1d2e)',
    border: '1px solid var(--color-border, #d8dfe7)',
  };

  const ghostBtn: CSSProperties = {
    ...btnBase,
    backgroundColor: 'transparent',
    color: 'var(--color-text, #0f1d2e)',
    border: 'none',
    marginInlineStart: 'auto',
  };

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      dir="rtl"
      style={cardStyle}
      data-testid="receipt-preview"
    >
      <div style={titleBandStyle}>
        <h2
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          style={{
            fontSize: 'var(--font-size-lg)',
            fontWeight: 'var(--font-weight-semibold)',
            letterSpacing: '-0.005em',
            margin: 0,
            outline: 'none',
          }}
        >
          معاينة الإيصال — Receipt preview
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق المعاينة — Close preview"
          style={{
            ...ghostBtn,
            marginInlineStart: 0,
            display: 'grid',
            placeItems: 'center',
            padding: 0,
          }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div style={canvasRegionStyle}>
        {state.phase === 'loading' && (
          <p style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
            جارٍ التحضير — Preparing preview
          </p>
        )}
        {state.phase === 'error' && (
          <div
            role="alert"
            style={{
              backgroundColor: 'var(--color-warning-soft)',
              color: 'var(--color-warning-emphasis)',
              padding: 'var(--space-4)',
              borderRadius: 'var(--radius-control)',
            }}
          >
            تعذّرت معاينة الإيصال — This receipt cannot be previewed.
          </div>
        )}
        {state.phase === 'ready' && (
          <div
            role="img"
            aria-label={`معاينة الإيصال للعملية رقم ${saleId} — Receipt preview for sale ${saleId}`}
            style={slipStyle}
            // The HTML is the main-process engine's minimised output; the trust
            // boundary is main, and the engine never emits sensitive fields
            // (T130-134). The renderer is not the sanitisation point.
            dangerouslySetInnerHTML={{ __html: state.html }}
          />
        )}
      </div>

      <div style={footerStyle}>
        <button type="button" style={primaryBtn} disabled title="Printing lands in Slice 3">
          طباعة — Print
        </button>
        <button
          type="button"
          style={secondaryBtn}
          aria-pressed={zoomed}
          onClick={() => {
            setZoomed((z) => !z);
          }}
        >
          زر التكبير — Zoom 2×
        </button>
        <button type="button" style={ghostBtn} onClick={onClose}>
          إغلاق — Close
        </button>
      </div>
    </section>
  );
}
