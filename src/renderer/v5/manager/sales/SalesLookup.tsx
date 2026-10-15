import { useId, useRef, useState, type JSX, type SyntheticEvent } from 'react';

import type { ReceiptsBridgeAPI, SalesBridgeAPI, SaleSummary } from '../../../../shared/bridge-api';
import type { SaleNumber } from '../../../../shared/sales/types';
import { Notice } from '../../foundation/Notice';
import { SaleResult } from './SaleResult';
import { SALES_COPY } from './sales-copy';
import './sales.css';

/**
 * T451 / RT-500 (VN-S10 S10-3) — Sales → find a sale by its number, on the
 * G-6 references. Same behaviour as the screen it replaces:
 *
 * - `sales.findByNumber` (read-only, tenant-scoped server-side); the query is
 *   trimmed, an empty one sends nothing, no bridge is a no-op.
 * - One search at a time: a ref blocks re-entry synchronously, and the button
 *   reads «جارٍ البحث…» and is disabled while one runs.
 * - A refusal and a rejected call both read «لم يُعثر على بيع بهذا الرقم.».
 * - A new search closes any open preview and clears the previous result.
 *
 * Out of scope (RT-249 / D-N1): the recent-sales list and the short number.
 */

export interface SalesLookupProps {
  /** Injected for tests; production falls back to `window.api.sales`. */
  _testSalesBridge?: SalesBridgeAPI;
  /** Forwarded to the result; production falls back to `window.api.receipts`. */
  _testReceiptsBridge?: ReceiptsBridgeAPI;
}

function resolveSalesBridge(injected?: SalesBridgeAPI): SalesBridgeAPI | null {
  if (injected !== undefined) return injected;
  const api = (window as unknown as { api?: { sales?: SalesBridgeAPI } }).api;
  return api?.sales ?? null;
}

type LookupState =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | { phase: 'found'; sale: SaleSummary }
  | { phase: 'not_found' };

export function SalesLookup({
  _testSalesBridge,
  _testReceiptsBridge,
}: SalesLookupProps): JSX.Element {
  const headingId = useId();
  const inputId = useId();
  const inFlight = useRef(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<LookupState>({ phase: 'idle' });

  async function handleFind(): Promise<void> {
    if (inFlight.current) return;
    const trimmed = query.trim();
    if (trimmed === '') return; // no empty lookups
    const salesApi = resolveSalesBridge(_testSalesBridge);
    if (salesApi === null) return;
    inFlight.current = true;
    setState({ phase: 'searching' });
    try {
      const res = await salesApi.findByNumber({ sale_number: trimmed as SaleNumber });
      setState(res.kind === 'ok' ? { phase: 'found', sale: res.sale } : { phase: 'not_found' });
    } catch {
      setState({ phase: 'not_found' });
    } finally {
      inFlight.current = false;
    }
  }

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleFind();
  };

  const searching = state.phase === 'searching';

  return (
    <section className="v5-sales-panel" aria-labelledby={headingId}>
      <div className="v5-sales-panel-head">
        <h2 id={headingId}>{SALES_COPY.findHeading}</h2>
      </div>
      <div className="v5-sales-panel-body">
        <form className="v5-sales-lookup" onSubmit={onSubmit} noValidate>
          <div className="v5-sales-field">
            <label htmlFor={inputId}>{SALES_COPY.saleNumber}</label>
            <input
              id={inputId}
              className="v5-sales-input v5-sales-input--code"
              type="text"
              autoComplete="off"
              dir="ltr"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>
          <button type="submit" className="v5-sales-btn v5-sales-btn--primary" disabled={searching}>
            {searching ? SALES_COPY.searching : SALES_COPY.search}
          </button>
        </form>
        {state.phase === 'not_found' && (
          <Notice tone="info" testId="sale-not-found">
            {SALES_COPY.notFound}
          </Notice>
        )}
        {state.phase === 'found' && (
          <SaleResult
            sale={state.sale}
            {...(_testReceiptsBridge !== undefined ? { receipts: _testReceiptsBridge } : {})}
          />
        )}
      </div>
    </section>
  );
}
