import type { JSX } from 'react';

import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope.js';
import { touchTarget } from '../tokens/touch.js';

/**
 * 006-payments-tender S1 + Wave 5c T291 — TenderSelection.
 *
 * Renders the three tender options:
 *   - cash: enabled and selectable.
 *   - external_card_terminal: enabled and selectable.
 *   - internal_voucher: ENABLED as of Wave 5c (§A4-B cleared 2026-05-25).
 *     The voucher entry surface (`<VoucherEntry>`) calls
 *     `tender.apply` with `tender_type: 'internal_voucher'`; the Slice 4
 *     bridge handler routes to the V-A client (Contract V-A).
 *
 * Returns null when no envelope is provided (route guard — caller must
 * not mount this component without a valid handoff envelope).
 *
 * SECURITY: no card data, no PAN, no CVV. No sensitive IDs in the DOM.
 * No voucher tokens or balance crosses TenderSelection — that's
 * VoucherEntry's surface and the bridge contract enforces minimisation
 * (FR-017).
 */

export type TenderKind = 'cash' | 'external_card_terminal' | 'internal_voucher';

export interface TenderSelectionProps {
  envelope: Readonly<PaymentIntentEnvelope> | null;
  onTenderSelect: (tender: TenderKind) => void;
  /**
   * The currently selected tender, or null while none is chosen.
   *
   * 022 US3 T071: the mockup's selected tile carries a 2px primary border, a
   * tinted fill and a check badge at the tile's inline-start top corner. That
   * emphasis is heavier than the 1.5px used for selected rows elsewhere and is
   * intentional — the tender choice is the decision the surface exists to make.
   * Presentation only; the parent still owns selection state.
   */
  selectedTender?: TenderKind | null;
}

export function TenderSelection({
  envelope,
  onTenderSelect,
  selectedTender = null,
}: TenderSelectionProps): JSX.Element | null {
  if (envelope === null) {
    return null;
  }

  return (
    <section
      className="tender-selection"
      data-testid="tender-selection"
      aria-label="اختر طريقة الدفع"
    >
      <h2 className="tender-selection__heading">طريقة الدفع (Payment method)</h2>

      {/*
        POS v3.5 Slice 4 — 3-method grid (cash · card · voucher).
        Arabic-first labels (D-009: NOT --four; credit/insurance are Phase 6 PARKED).
        The prototype's `method-grid--four` (5-column with insurance/credit) is
        intentionally not used here.
      */}
      <div
        className="tender-selection__options tender-method-grid"
        role="radiogroup"
        aria-label="طريقة الدفع"
      >
        <button
          type="button"
          role="radio"
          aria-checked={selectedTender === 'cash' ? 'true' : 'false'}
          className={`tender-selection__option method-card${
            selectedTender === 'cash' ? ' method-card--selected' : ''
          }`}
          data-testid="tender-cash"
          aria-label="نقدي — Cash"
          style={{ minHeight: touchTarget.min }}
          onClick={() => {
            onTenderSelect('cash');
          }}
        >
          {selectedTender === 'cash' && (
            <span className="method-card__check" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="tender-selection__option-label">نقدي</span>
          <small>العملات الورقية والمعدنية</small>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={selectedTender === 'external_card_terminal' ? 'true' : 'false'}
          className={`tender-selection__option method-card${
            selectedTender === 'external_card_terminal' ? ' method-card--selected' : ''
          }`}
          data-testid="tender-external-card"
          aria-label="بطاقة — Card terminal"
          style={{ minHeight: touchTarget.min }}
          onClick={() => {
            onTenderSelect('external_card_terminal');
          }}
        >
          {selectedTender === 'external_card_terminal' && (
            <span className="method-card__check" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="tender-selection__option-label">بطاقة</span>
          <small>جهاز الشبكة الخارجي</small>
        </button>

        {/* Wave 5c T291 — voucher slot ENABLED (§A4-B cleared 2026-05-25). */}
        <button
          type="button"
          role="radio"
          aria-checked={selectedTender === 'internal_voucher' ? 'true' : 'false'}
          className={`tender-selection__option method-card${
            selectedTender === 'internal_voucher' ? ' method-card--selected' : ''
          }`}
          data-testid="tender-voucher"
          aria-label="قسيمة — Voucher"
          style={{ minHeight: touchTarget.min }}
          onClick={() => {
            onTenderSelect('internal_voucher');
          }}
        >
          {selectedTender === 'internal_voucher' && (
            <span className="method-card__check" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="tender-selection__option-label">قسيمة</span>
          <small>قسيمة داخلية</small>
        </button>
      </div>
    </section>
  );
}
