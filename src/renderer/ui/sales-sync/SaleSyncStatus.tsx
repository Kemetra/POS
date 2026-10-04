import { useCallback, useEffect, useState, type JSX } from 'react';

import type { SaleSyncStatusCounts } from '../../../main/sales-sync/sale-sync-state-repo.js';
import type { PreloadBridgeAPI } from '../../../shared/bridge-api.js';

/**
 * 011-sale-sync-capture-up T054 — `SaleSyncStatus` read-only indicator.
 *
 * Ambient sync-health surface for the cashier. Mirrors `CatalogueFreshness`'s
 * truthful-states discipline (icon + text, never colour-only; absolute `<time>`
 * with the raw ISO for provenance; `role="status"` + polite live region) but is
 * strictly READ-ONLY: it exposes NO button and cannot trigger the drain (the
 * sync engine runs in the main process on its own schedule — §A4 / P8 / WR-1).
 *
 * Four honest states, derived purely from the counts (PRODUCT.md "never lies"):
 *   • never-synced — nothing pending, nothing dead-lettered, never succeeded.
 *   • all-synced   — caught up; shows the absolute last-success time.
 *   • pending      — N sales await sync. INFORMATIONAL, not alarming: being
 *                    offline mid-shift is normal and the queue is durable.
 *   • attention    — N sales dead-lettered. VISIBLE but quiet — this is
 *                    accountability (a sale the backend rejected needs a human),
 *                    not a panic. Never red-screen; icon + plain Arabic text.
 *                    RT-190: when some of them are payload divergences (the
 *                    server holds a different sale than the till), the label
 *                    says how many, so the operator knows what to investigate.
 * A rejected bridge invoke degrades to `unavailable` (loud-but-handled, never a
 * white screen).
 *
 * The `bridge` prop mirrors the 009/010 `_testBridge` seam: tests inject a
 * scripted bridge; production reads `window.api.salesSync`.
 */

/** Just the sale-sync slice of the preload bridge this component needs. */
export interface SaleSyncStatusBridge {
  syncStatus(): Promise<SaleSyncStatusCounts>;
}

/* v8 ignore start — production arm only reachable in Electron; tests inject `bridge` */
function readSalesSyncBridge(): SaleSyncStatusBridge {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api as
    | (PreloadBridgeAPI & { salesSync?: SaleSyncStatusBridge })
    | undefined;
  if (!api || api.salesSync === undefined) {
    throw new Error(
      'SaleSyncStatus: window.api.salesSync missing — preload bridge not initialised.',
    );
  }
  return api.salesSync;
}
/* v8 ignore stop */

type SyncState =
  | 'loading'
  | 'never-synced'
  | 'all-synced'
  | 'pending'
  | 'attention'
  | 'unavailable';

export interface SaleSyncStatusProps {
  /** Test-only bridge injection (mirrors 009/010). MUST NOT be used in production. */
  bridge?: SaleSyncStatusBridge;
}

/** Derive the machine state from the counts. Attention (dead-letter) outranks pending. */
function toState(counts: SaleSyncStatusCounts): {
  state: Exclude<SyncState, 'loading'>;
  lastSuccessAt: string | null;
} {
  const raw = counts as unknown;
  if (raw === null || typeof raw !== 'object' || !('pending' in raw)) {
    return { state: 'unavailable', lastSuccessAt: null };
  }
  if (counts.deadLetter > 0) return { state: 'attention', lastSuccessAt: counts.lastSuccessAt };
  if (counts.pending > 0) return { state: 'pending', lastSuccessAt: counts.lastSuccessAt };
  if (counts.lastSuccessAt === null) return { state: 'never-synced', lastSuccessAt: null };
  return { state: 'all-synced', lastSuccessAt: counts.lastSuccessAt };
}

/** Arabic-locale ABSOLUTE time (no relative clock — it would drift and lie). */
function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Arabic-Indic numerals (the cashier's locale) for a count. */
function arabicNumber(n: number): string {
  return new Intl.NumberFormat('ar-EG').format(n);
}

const STATE_ICON: Record<Exclude<SyncState, 'loading'>, string> = {
  'never-synced': '⃝', // hollow — nothing has synced yet
  'all-synced': '●', // solid — caught up
  pending: '↑', // upward — sales waiting to rise to the backend
  attention: '⚠', // needs a human (icon + text, never colour-only)
  unavailable: '⛔',
};

export function SaleSyncStatus({ bridge }: SaleSyncStatusProps): JSX.Element {
  const [state, setState] = useState<SyncState>('loading');
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [deadLetter, setDeadLetter] = useState(0);
  const [payloadDivergence, setPayloadDivergence] = useState(0);

  const resolveBridge = useCallback((): SaleSyncStatusBridge => {
    /* v8 ignore next — production arm only reachable in Electron; tests inject `bridge` */
    return bridge ?? readSalesSyncBridge();
  }, [bridge]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const counts = await resolveBridge().syncStatus();
      const next = toState(counts);
      setState(next.state);
      setLastSuccessAt(next.lastSuccessAt);
      setPending(counts.pending);
      setDeadLetter(counts.deadLetter);
      setPayloadDivergence(counts.payloadDivergence);
    } catch {
      setState('unavailable');
      setLastSuccessAt(null);
    }
  }, [resolveBridge]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="sale-sync-status"
      data-testid="sale-sync-status"
      data-state={state}
    >
      {state !== 'loading' && (
        <span className="sale-sync-status__icon" aria-hidden="true">
          {STATE_ICON[state]}
        </span>
      )}

      <span className="sale-sync-status__label">
        {state === 'loading' && 'جارٍ القراءة…'}
        {state === 'never-synced' && 'لم تتم المزامنة بعد'}
        {state === 'all-synced' && lastSuccessAt !== null && (
          <>
            آخر مزامنة ناجحة:{' '}
            <time dateTime={lastSuccessAt} data-testid="sale-sync-status-time">
              {formatAbsolute(lastSuccessAt)}
            </time>
          </>
        )}
        {state === 'pending' && `في انتظار المزامنة: ${arabicNumber(pending)}`}
        {state === 'attention' && `${arabicNumber(deadLetter)} عملية بحاجة إلى مراجعة`}
        {state === 'attention' &&
          payloadDivergence > 0 &&
          ` (منها ${arabicNumber(payloadDivergence)} تختلف عن المسجَّل على الخادم)`}
        {state === 'unavailable' && 'حالة المزامنة غير متاحة'}
      </span>
    </div>
  );
}
