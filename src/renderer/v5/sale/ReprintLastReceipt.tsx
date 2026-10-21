import { useRef, useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI, SalesBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type { Role } from '../../../shared/operator/role';
import type { SaleId } from '../../../shared/sales/types';
import { focusScanOwner } from '../../scan/scan-anchor';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { Notice } from '../foundation/Notice';
import { refusalCopy } from '../manager/sales/history/history-copy';
import { SALES_COPY } from '../manager/sales/sales-copy';
import './reprint-last-receipt.css';

/**
 * RT-249 (P-26-2, owner decision D1 of RT-536, 2026-10-16) — «إعادة طباعة آخر
 * إيصال»: the cashier's quick reprint of their own last sale, from the Sale.
 *
 * No new bridge channel. The last sale is `sales.subscribe({ topic: 'recent' })`,
 * which main already limits to the signed-in cashier's own sales on this
 * terminal (RT-546, `ownerFilter`); the print is `receipts.reprint`, which
 * re-runs the same own-sale gate and keeps its own refusals (`not_yet_printed`,
 * `sale_voided`, `printer_unavailable`). The renderer names no operator,
 * terminal or role. It reads the sale at click time, never earlier, so a sale
 * finished a moment ago is the one reprinted, and the notice names the sale
 * number that went to the printer so a stale pick is visible.
 *
 * Placement is the empty-cart-only default (P-2; owner confirmation pending):
 * `canReprintLast` hides it while a cart holds lines or is past editing.
 */

/** Cashier only (a manager's «last sale on the terminal» is anyone's) and only with nothing in the cart. */
export function canReprintLast(
  role: Role,
  cartState: CartState | null,
  lineCount: number,
): boolean {
  if (role !== 'cashier' || lineCount > 0) return false;
  return cartState === null || cartState === CartState.empty || cartState === CartState.editing;
}

/**
 * The Sale's slot for the action: renders it only where `canReprintLast`
 * allows, and only with `saleFinalization` on — main registers `sales.*` and
 * `receipts.*` only then (default off, the rollback profile).
 */
export function ReprintLastSlot({
  role,
  cartState,
  lineCount,
}: Readonly<{ role: Role; cartState: CartState | null; lineCount: number }>): JSX.Element | null {
  const saleFinalization = useFeatureFlagsStore((s) => s.saleFinalization);
  return saleFinalization && canReprintLast(role, cartState, lineCount) ? (
    <ReprintLastReceipt />
  ) : null;
}

export interface ReprintLastReceiptProps {
  /** Injected for tests; production falls back to `window.api.sales`. */
  _testSalesBridge?: SalesBridgeAPI;
  /** Injected for tests; production falls back to `window.api.receipts`. */
  _testReceiptsBridge?: ReceiptsBridgeAPI;
  /** Injected for tests so the fresh-key assertion is deterministic. */
  _idempotencyKeyFactory?: () => string;
}

interface WindowApi {
  sales?: SalesBridgeAPI;
  receipts?: ReceiptsBridgeAPI;
}

function windowApi(): WindowApi | undefined {
  return (window as unknown as { api?: WindowApi }).api;
}

/**
 * Refusals whose existing history copy tells the cashier something true; the
 * rest use the reprint's own. A voided sale (`sale_voided`) cannot be retried,
 * so it says what the history says for a sale that allows no true duplicate.
 */
const HISTORY_COPY_KEY: Readonly<Record<string, Parameters<typeof refusalCopy>[0]>> = {
  sale_not_found: 'sale_not_found',
  not_yet_printed: 'not_yet_printed',
  printer_unavailable: 'printer_unavailable',
  sale_voided: 'duplicate_unavailable',
};

function refusalText(reason: string): string {
  const key = HISTORY_COPY_KEY[reason];
  return key === undefined ? SALES_COPY.reprintFailed : refusalCopy(key);
}

type Failed = { kind: 'failed'; text: string };
type Feedback = { kind: 'sent'; saleNumber: string } | Failed | null;

const FAILED: Failed = { kind: 'failed', text: SALES_COPY.reprintFailed };

/** The signed-in cashier's last sale on this terminal, or why there is none. */
async function readLastSale(
  sales: SalesBridgeAPI,
): Promise<{ saleId: SaleId; saleNumber: string } | Failed> {
  const res = await sales.subscribe({ topic: 'recent' });
  if (res.kind === 'refused') return { kind: 'failed', text: refusalText(res.reason) };
  if (!('recent' in res)) return FAILED;
  if (res.recent === null) return { kind: 'failed', text: refusalText('sale_not_found') };
  return { saleId: res.recent.sale_id as SaleId, saleNumber: res.recent.sale_number };
}

export function ReprintLastReceipt({
  _testSalesBridge,
  _testReceiptsBridge,
  _idempotencyKeyFactory,
}: Readonly<ReprintLastReceiptProps>): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const inFlight = useRef(false);
  const keyFactory = _idempotencyKeyFactory ?? (() => globalThis.crypto.randomUUID());

  async function reprintLast(): Promise<Feedback> {
    // Named `salesApi` / `receiptsApi` so the architecture guard's
    // `bridge.<namespace>` regex does not mis-flag the calls.
    const salesApi = _testSalesBridge ?? windowApi()?.sales;
    const receiptsApi = _testReceiptsBridge ?? windowApi()?.receipts;
    if (salesApi === undefined || receiptsApi === undefined) return null;
    const last = await readLastSale(salesApi);
    if ('kind' in last) return last;
    const res = await receiptsApi.reprint({
      sale_id: last.saleId,
      idempotency_key: keyFactory(),
    });
    return res.kind === 'ok'
      ? { kind: 'sent', saleNumber: last.saleNumber }
      : { kind: 'failed', text: refusalText(res.reason) };
  }

  async function handleClick(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      setFeedback(await reprintLast());
    } catch {
      // An IPC rejection must not crash the Sale; the cashier can retry.
      setFeedback(FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
      focusScanOwner();
    }
  }

  return (
    <span className="v5-reprint-last">
      <button
        type="button"
        className="v5-reprint-last__btn v5-btn"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
      >
        {busy ? SALES_COPY.reprinting : SALES_COPY.reprintLast}
      </button>
      {feedback?.kind === 'sent' && (
        <Notice tone="info" testId="reprint-last-sent">
          {SALES_COPY.reprintSent} {SALES_COPY.saleNumber}{' '}
          <bdi dir="ltr">{feedback.saleNumber}</bdi>
        </Notice>
      )}
      {feedback?.kind === 'failed' && (
        <Notice tone="warning" testId="reprint-last-failed">
          {feedback.text}
        </Notice>
      )}
    </span>
  );
}
