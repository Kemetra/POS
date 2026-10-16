import { useEffect, useState, type JSX } from 'react';

import type {
  ReceiptsBridgeAPI,
  SalesBridgeAPI,
  SaleSummary,
} from '../../../../../shared/bridge-api';
import type { SaleId } from '../../../../../shared/sales/types';
import { Notice } from '../../../foundation/Notice';
import { SaleResult } from '../SaleResult';
import { HISTORY_COPY as C } from './history-copy';

/**
 * RT-542 — a sale only this terminal knows (unsent, or the offline view): its
 * own record through `sales.read`, with the existing receipt preview and the
 * local reprint (`receipts.reprint`: the original-print precondition, local
 * copy numbering and, since RT-542, no unmarked duplicate of a voided sale).
 */
export function LocalSaleDetail({
  saleId,
  sales,
  receipts,
  onClose,
}: Readonly<{
  saleId: SaleId;
  sales: SalesBridgeAPI;
  receipts?: ReceiptsBridgeAPI;
  onClose: () => void;
}>): JSX.Element {
  const [sale, setSale] = useState<SaleSummary | null | 'missing'>(null);

  useEffect(() => {
    let live = true;
    sales.read({ sale_id: saleId }).then(
      (res) => {
        if (live) setSale(res.kind === 'ok' ? res.sale : 'missing');
      },
      () => {
        if (live) setSale('missing');
      },
    );
    return () => {
      live = false;
    };
  }, [sales, saleId]);

  return (
    <section className="v5-history-detail" data-testid="history-local-detail">
      <div className="v5-sales-panel-head">
        <h3>{C.detailHeading}</h3>
        <button type="button" className="v5-sales-btn" onClick={onClose}>
          {C.close}
        </button>
      </div>
      {sale === null && <output>{C.loading}</output>}
      {sale === 'missing' && <Notice tone="warning">{C.notRecorded}</Notice>}
      {sale !== null && sale !== 'missing' && (
        <SaleResult sale={sale} {...(receipts === undefined ? {} : { receipts })} />
      )}
    </section>
  );
}
