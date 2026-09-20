/**
 * 005-sales-cart T049 — LineItemRow component.
 * POS v3.5 Slice 3 — recomposed to the prototype `.cart-pane__line-list-item`.
 *
 * Renders a single cart line per the S0 contact sheet §Surface 3 / the v3.5
 * prototype line row:
 *   - display_name (text), with an optional Rx/controlled awareness badge.
 *   - [×] remove button (≥ 44 × 44 px touch target).
 *   - optional per-unit/pack label (LTR-isolated, display only).
 *   - QuantityStepper ([−] qty [+]).
 *   - unit price (mono, ¤ prefix, 2 decimal places).
 *   - line subtotal (mono, ¤ prefix, 2 decimal places).
 *   - note chip (if non-null, muted, truncated at 40 chars).
 *
 * Currency format: integer minor units / 100, rendered with ¤ prefix.
 * No floats are produced — formatting only divides by 100 for display.
 *
 * The Rx/controlled badge and the pack label are DISPLAY-ONLY enrichment:
 * they are sourced from product flags the caller already holds, they gate
 * nothing (mirroring the catalogue `ControlledFlags` posture), and they
 * default OFF so every existing call site renders unchanged. These are
 * renderer-local props — no contract/api-types surface is touched.
 *
 * SECURITY: Note chip displays raw note text — this is display-only and does
 * not feed back into any IPC call. No note content is logged (NFR-006).
 */

import type { JSX } from 'react';
import { QuantityStepper } from './QuantityStepper.js';
import { touchTarget } from '../tokens/touch.js';

export interface LineItemRowProps {
  lineId: string;
  displayName: string;
  quantity: number;
  unitPriceMinor: number;
  lineSubtotalMinor: number;
  note: string | null;
  hasNote: boolean;
  /**
   * Display-only awareness flag (prescription-required). Renders a non-blocking
   * Rx badge; gates nothing. Defaults to false. Sourced from product flags the
   * caller already holds — not part of the cart contract.
   */
  prescriptionRequired?: boolean;
  /**
   * Display-only awareness flag (controlled substance). Renders a non-blocking
   * controlled badge; gates nothing. Defaults to false.
   */
  controlledSubstance?: boolean;
  /**
   * Display-only per-unit/pack label (e.g. "×20 أقراص"). LTR-isolated so the
   * leading numeral/× never bidi-reorders under the RTL shell. Omitted → no row.
   */
  packLabel?: string;
  onQuantityIncrement: () => void;
  onQuantityDecrement: () => void;
  onRemove: () => void;
  onNoteOpen: () => void;
}

const NOTE_TRUNCATE_LENGTH = 40;
const MIN_TOUCH = touchTarget.min;

function formatMinorUnits(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = Math.abs(minor % 100)
    .toString()
    .padStart(2, '0');
  return `¤${String(whole)}.${frac}`;
}

function truncateNote(note: string): string {
  if (note.length <= NOTE_TRUNCATE_LENGTH) return note;
  return `${note.slice(0, NOTE_TRUNCATE_LENGTH)}...`;
}

export function LineItemRow({
  lineId,
  displayName,
  quantity,
  unitPriceMinor,
  lineSubtotalMinor,
  note,
  hasNote,
  prescriptionRequired = false,
  controlledSubstance = false,
  packLabel,
  onQuantityIncrement,
  onQuantityDecrement,
  onRemove,
  onNoteOpen,
}: LineItemRowProps): JSX.Element {
  return (
    <div className="line-item-row" data-testid="line-item-row" data-line-id={lineId}>
      <div className="line-item-row__main">
        <span className="line-item-row__name">
          {displayName}
          {(prescriptionRequired || controlledSubstance) && (
            <span className="line-item-row__flags">
              {controlledSubstance && (
                <span
                  className="line-item-row__flag line-item-row__flag--controlled"
                  data-testid="line-flag-controlled"
                >
                  مادة خاضعة للرقابة (controlled)
                </span>
              )}
              {prescriptionRequired && (
                <span
                  className="line-item-row__flag line-item-row__flag--rx"
                  data-testid="line-flag-rx"
                >
                  بوصفة طبية (Rx)
                </span>
              )}
            </span>
          )}
        </span>
        <button
          type="button"
          className="line-item-row__remove"
          data-testid="line-remove-btn"
          aria-label={`Remove ${displayName} from cart`}
          style={{ minWidth: MIN_TOUCH, minHeight: MIN_TOUCH }}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {packLabel !== undefined && (
        <span className="line-item-row__meta-line" data-testid="line-pack-label" dir="ltr">
          {packLabel}
        </span>
      )}
      <div className="line-item-row__qty-price">
        <QuantityStepper
          quantity={quantity}
          hasNote={hasNote}
          onIncrement={onQuantityIncrement}
          onDecrement={onQuantityDecrement}
          onRemoveRequest={onRemove}
        />
        <span className="line-item-row__unit-price mono" data-testid="line-unit-price" dir="ltr">
          {formatMinorUnits(unitPriceMinor)}
        </span>
        <span className="line-item-row__subtotal mono" data-testid="line-subtotal" dir="ltr">
          {formatMinorUnits(lineSubtotalMinor)}
        </span>
      </div>
      {note !== null ? (
        <button
          type="button"
          className="line-item-row__note-chip"
          data-testid="line-note-chip"
          aria-label="Edit note"
          onClick={onNoteOpen}
        >
          {truncateNote(note)}
        </button>
      ) : (
        <button
          type="button"
          className="line-item-row__note-add"
          data-testid="line-note-add-btn"
          onClick={onNoteOpen}
        >
          {/* 022 U2 / T063 — FR-19 Arabic-first visible copy, and the visible
              text is what NAMES the button. An earlier pass kept
              `aria-label="Add note"` here on the grounds that accessible-name
              language is U6's convergence pass — but aria-label REPLACES
              descendant text in the accessibility tree, so an English name on
              Arabic copy meant voice-control users could not say what they saw
              and AT announced copy absent from the screen (WCAG 2.5.3). U6's
              deferral covers labels whose visible text is unchanged; this one
              changed here, so the mismatch is U2's to close. No Arabic
              aria-label either — it would duplicate the text and can drift. */}
          إضافة ملاحظة
        </button>
      )}
    </div>
  );
}
