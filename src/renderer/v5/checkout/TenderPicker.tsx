import type { JSX } from 'react';

import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { V5Icon, type V5IconName } from '../foundation/V5Icon';

/**
 * RT-243 W1-C (freeze 15 §4 `TenderPicker`, 06) — the payment method tiles.
 *
 * Replaces the v3.5 `TenderSelection` and its `.method-card` blocks; selection
 * state stays with `PaymentSurface`. Three tiles, in this order and no others
 * (08 I-11): cash, the external card terminal, and the internal voucher. The
 * voucher is pilot-excluded (RT-10 D2): unless `voucherEnabled`, its tile keeps
 * its slot, disabled, with the reason «غير متاحة حاليًا» as text, sunken rather
 * than faded (RT-103). A disabled tile is not in the tab order.
 *
 * A radiogroup of buttons, as before: the method is chosen by activating a tile
 * (Enter / Space / click); arrow keys are not bound (freeze 15 §3.5 keeps wave 1
 * keyless). The selected tile carries a check glyph and `aria-checked`, so the
 * state is never colour alone (forced colours included).
 *
 * SECURITY: no card data, voucher code or balance crosses this component.
 */

export type TenderKind = 'cash' | 'external_card_terminal' | 'internal_voucher';

export interface TenderPickerProps {
  envelope: Readonly<PaymentIntentEnvelope> | null;
  onTenderSelect: (tender: TenderKind) => void;
  /** The selected tender, or null while none is chosen. */
  selectedTender?: TenderKind | null;
  /** RT-103: whether the voucher may be chosen. Fail-closed default (pilot rule). */
  voucherEnabled?: boolean;
}

interface Tile {
  readonly kind: TenderKind;
  readonly testId: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: V5IconName;
}

const CASH: Tile = {
  kind: 'cash',
  testId: 'tender-cash',
  label: 'نقدي',
  detail: 'العملات الورقية والمعدنية',
  icon: 'tender-cash',
};

const CARD: Tile = {
  kind: 'external_card_terminal',
  testId: 'tender-external-card',
  label: 'بطاقة',
  detail: 'جهاز الشبكة الخارجي',
  icon: 'tender-card',
};

function voucherTile(enabled: boolean): Tile {
  return {
    kind: 'internal_voucher',
    testId: 'tender-voucher',
    label: 'قسيمة',
    detail: enabled ? 'قسيمة داخلية' : 'غير متاحة حاليًا',
    icon: 'tender-voucher',
  };
}

export function TenderPicker({
  envelope,
  onTenderSelect,
  selectedTender = null,
  voucherEnabled = false,
}: TenderPickerProps): JSX.Element | null {
  // Route guard: no envelope, nothing to pay.
  if (envelope === null) return null;

  const tiles: readonly Tile[] = [CASH, CARD, voucherTile(voucherEnabled)];

  return (
    <section
      className="v5-tender-picker"
      data-testid="tender-selection"
      aria-labelledby="v5-tender-picker-title"
    >
      <h2 className="v5-checkout-heading" id="v5-tender-picker-title">
        طريقة الدفع
      </h2>
      <div className="v5-tender-picker__tiles" role="radiogroup" aria-label="طريقة الدفع">
        {tiles.map((tile) => {
          const selected = selectedTender === tile.kind;
          const unavailable = tile.kind === 'internal_voucher' && !voucherEnabled;
          return (
            <button
              key={tile.kind}
              type="button"
              role="radio"
              className="v5-tender-tile"
              data-testid={tile.testId}
              aria-checked={selected ? 'true' : 'false'}
              aria-label={unavailable ? `${tile.label} — ${tile.detail}` : tile.label}
              disabled={unavailable}
              aria-disabled={unavailable ? 'true' : undefined}
              onClick={() => {
                if (!unavailable) onTenderSelect(tile.kind);
              }}
            >
              <span className="v5-tender-tile__head">
                <span className="v5-tender-tile__icon" aria-hidden="true">
                  <V5Icon name={tile.icon} size={20} />
                </span>
                {selected && (
                  <span className="v5-tender-tile__check" aria-hidden="true">
                    <V5Icon name="check" size={16} />
                  </span>
                )}
              </span>
              <span className="v5-tender-tile__label">{tile.label}</span>
              <small className="v5-tender-tile__detail">{tile.detail}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
