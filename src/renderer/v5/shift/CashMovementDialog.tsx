import { useId, useRef, useState, type JSX } from 'react';

import {
  SHIFT_MOVEMENT_REASON_CODES,
  SHIFT_NOTE_MAX_LENGTH,
  type ShiftCashupBridgeAPI,
  type ShiftMovementReasonCode,
  type ShiftMovementRequest,
} from '../../../shared/shift-cashup/types';
import { SaleDialog } from '../sale/SaleDialog';
import { callShift, useSingleFlight } from './shift-bridge';
import { MOVEMENT_REASON_LABELS, SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import { ShiftAlert } from './ShiftScreen';
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
  const ids = { amount: useId(), reason: useId(), note: useId() };
  const amountRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
  const [reasonCode, setReasonCode] = useState<ShiftMovementReasonCode>('bank_drop');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();
  const title = SHIFT_COPY[props.kind];

  const submit = (): void => {
    const request = movementOf({ amount, reasonCode, note });
    if (request === null) {
      setError(SHIFT_COPY.invalidAmount);
      return;
    }
    setError(null);
    run(async () => {
      const { bridge, kind } = props;
      const answer = await callShift(() =>
        kind === 'payIn' ? bridge.payIn(request) : bridge.payOut(request),
      );
      if (answer.kind === 'recorded') props.onRecorded();
      else setError(shiftRefusalMessage(answer.reason));
    });
  };

  return (
    <SaleDialog label={title} onDismiss={props.onDismiss} initialFocusRef={amountRef}>
      <h2 className="v5-live-dialog-title">{title}</h2>
      <div className="v5-shift-fields">
        <label htmlFor={ids.amount}>{SHIFT_COPY.amountLabel}</label>
        <input
          id={ids.amount}
          ref={amountRef}
          className="v5-shift-input v5-ltr"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
        <label htmlFor={ids.reason}>{SHIFT_COPY.reasonLabel}</label>
        <select
          id={ids.reason}
          className="v5-shift-input"
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
        <label htmlFor={ids.note}>{SHIFT_COPY.noteLabel}</label>
        <textarea
          id={ids.note}
          maxLength={SHIFT_NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </div>
      <ShiftAlert message={error} />
      <div>
        <button type="button" className="v5-live-btn" onClick={props.onDismiss}>
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
    </SaleDialog>
  );
}
