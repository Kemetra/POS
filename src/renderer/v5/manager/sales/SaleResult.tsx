import { useState, type JSX } from 'react';

import type { ReceiptsBridgeAPI, SaleSummary } from '../../../../shared/bridge-api';
import { ReceiptPreview } from './ReceiptPreview';
import { ReprintAffordance } from './ReprintAffordance';
import { SALES_COPY } from './sales-copy';

/**
 * RT-500 — one found sale: its number, who sold it and where, «معاينة
 * الإيصال» and, only when the latest print succeeded (AD-10), the reprint
 * control. The preview opens under the buttons and reads `receipts.preview`
 * itself (read-only, no side effects); this component issues no bridge call.
 *
 * The operator and terminal names are free text, so each sits in its own
 * `<bdi>`; the sale number is an LTR code.
 */

interface SaleResultProps {
  sale: SaleSummary;
  /** Forwarded to the preview and the reprint; production falls back to window.api.receipts. */
  receipts?: ReceiptsBridgeAPI;
}

export function SaleResult({ sale, receipts }: Readonly<SaleResultProps>): JSX.Element {
  const [previewing, setPreviewing] = useState(false);
  // Conditional spreads: exactOptionalPropertyTypes rejects an explicit `undefined`.
  const reprintBridge = receipts !== undefined ? { _testReceiptsBridge: receipts } : {};
  const previewBridge = receipts !== undefined ? { _testBridge: receipts } : {};

  return (
    <div className="v5-sales-result" data-testid="sale-result">
      <p className="v5-sales-ref">
        <bdi dir="ltr">{sale.sale_number}</bdi>
      </p>
      <p className="v5-sales-meta">
        <bdi>{sale.selling_operator_display_name}</bdi> · <bdi dir="ltr">{sale.terminal_label}</bdi>
      </p>
      <div className="v5-sales-buttons">
        <button
          type="button"
          className="v5-sales-btn"
          onClick={() => {
            setPreviewing(true);
          }}
        >
          {SALES_COPY.preview}
        </button>
        <ReprintAffordance
          sale={{
            sale_id: sale.sale_id,
            has_successful_print: sale.latest_print_event?.outcome === 'success',
          }}
          {...reprintBridge}
        />
      </div>
      {previewing && (
        <ReceiptPreview
          saleId={sale.sale_id}
          saleNumber={sale.sale_number}
          onClose={() => {
            setPreviewing(false);
          }}
          {...previewBridge}
        />
      )}
    </div>
  );
}
