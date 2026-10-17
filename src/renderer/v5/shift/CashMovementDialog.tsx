import { useId, useRef, useState, type JSX } from 'react';

import {
  SHIFT_MOVEMENT_REASON_CODES,
  SHIFT_NOTE_MAX_LENGTH,
  type ShiftCashupBridgeAPI,
  type ShiftMovementReasonCode,
  type ShiftMovementRequest,
} from '../../../shared/shift-cashup/types';
import { Dialog } from '../foundation/Dialog';
import { callShift, dismissUnlessBusy, useSingleFlight } from './shift-bridge';
import { MOVEMENT_REASON_LABELS, SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import {
  invalidEntry,
  refusedCall,
  ShiftAmountField,
  ShiftRefusal,
  type FieldError,
} from './ShiftParts';
import '../sale/live-sale.css';

export type MovementKind = 'payIn' | 'payOut';

interface Props {
  readonly bridge: ShiftCashupBridgeAPI;
  readonly kind: MovementKind;
  readonly onDismiss: () => void;
  readonly onRecorded: () => void;
}

/** The request for what was typed: the amount ≥ 1 minor unit, a trimmed note or none. */
function movementOf(input: {
  amount: string;
  reasonCode: ShiftMovementReasonCode;
  note: string;
}): ShiftMovementRequest | null {
  const amountMinor = parseShiftAmount(input.amount);
  if (amountMinor === null || amountMinor < 1) return null;
  const note = input.note.trim();
  return { amountMinor, reasonCode: input.reasonCode, ...(note === '' ? {} : { note }) };
}

/**
 * RT-17 slice 4 part 3 — a pay-in or pay-out: amount, contract reason and an
 * optional note. A refused pay-out shows only the generic
 * `pay_out_not_accepted` line (main never says why, so no amount or bound of
 * the hidden expected cash can be read from it).
 */
export function CashMovementDialog(props: Props): JSX.Element {
  const ids = { reason: useId(), note: useId() };
  const amountRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
  const [reasonCode, setReasonCode] = useState<ShiftMovementReasonCode>('bank_drop');
  const [note, setNote] = useState('');
  const [error, setError] = useState<FieldError | null>(null);
  const { busy, run } = useSingleFlight();
  const title = SHIFT_COPY[props.kind];
  const dismiss = dismissUnlessBusy(busy, props.onDismiss);

  const submit = (): void => {
    const request = movementOf({ amount, reasonCode, note });
    if (request === null) {
      setError(invalidEntry(SHIFT_COPY.invalidAmount));
      return;
    }
    setError(null);
    run(async () => {
      const { bridge, kind } = props;
      const answer = await callShift(() =>
        kind === 'payIn' ? bridge.payIn(request) : bridge.payOut(request),
      );
      if (answer.kind === 'recorded') props.onRecorded();
      else setError(refusedCall(shiftRefusalMessage(answer.reason)));
    });
  };

  return (
    <Dialog label={title} onCancel={dismiss} initialFocusRef={amountRef}>
      <h2 className="v5-shift-dialog-title">{title}</h2>
      <div className="v5-shift-form">
        <ShiftAmountField
          label={SHIFT_COPY.amountLabel}
          value={amount}
          onChange={setAmount}
          error={error?.invalid === true ? error : null}
          inputRef={amountRef}
        />
        <div className="v5-shift-field">
          <label htmlFor={ids.reason}>{SHIFT_COPY.reasonLabel}</label>
          <select
            id={ids.reason}
            className="v5-shift-select"
            value={reasonCode}
            onChange={(event) => {
              setReasonCode(event.target.value as ShiftMovementReasonCode);
            }}
          >
            {SHIFT_MOVEMENT_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {MOVEMENT_REASON_LABELS[code]}
              </option>
            ))}
          </select>
        </div>
        <div className="v5-shift-field">
          <label htmlFor={ids.note}>{SHIFT_COPY.noteLabel}</label>
          <textarea
            id={ids.note}
            className="v5-shift-textarea"
            maxLength={SHIFT_NOTE_MAX_LENGTH}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
      </div>
      <div className="v5-shift-slot">
        <ShiftRefusal message={error?.invalid === false ? error.message : null} />
      </div>
      <div className="v5-shift-dialog-actions">
        <button type="button" className="v5-live-btn" disabled={busy} onClick={dismiss}>
          {SHIFT_COPY.cancel}
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={busy}
          onClick={submit}
        >
          {SHIFT_COPY.record}
        </button>
      </div>
    </Dialog>
  );
}
