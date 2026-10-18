import { useId, useState, type JSX } from 'react';

import {
  MANAGER_PIN_PATTERN,
  type ShiftCashupBridgeAPI,
  type ShiftManagerPinEnrollRequest,
} from '../../../shared/shift-cashup/types';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { callShift, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { normalizeDigits } from './shift-format';
import { ShiftRefusal } from './ShiftParts';

interface PinFields {
  pin: string;
  confirm: string;
  current: string;
}

const EMPTY: PinFields = { pin: '', confirm: '', current: '' };

/** The request for the typed PINs, or the client-side reason it cannot be sent. */
function enrolmentOf(fields: PinFields): ShiftManagerPinEnrollRequest | { invalid: string } {
  const managerPin = normalizeDigits(fields.pin);
  const current = normalizeDigits(fields.current);
  if (!MANAGER_PIN_PATTERN.test(managerPin)) return { invalid: SHIFT_COPY.pinShape };
  if (normalizeDigits(fields.confirm) !== managerPin) return { invalid: SHIFT_COPY.pinMismatch };
  if (current === '') return { managerPin };
  if (!MANAGER_PIN_PATTERN.test(current)) return { invalid: SHIFT_COPY.pinShape };
  return { managerPin, currentPin: current };
}

type Result = { kind: 'enrolled' } | { kind: 'error'; message: string } | null;

/**
 * RT-17 slice 4 part 3 — a signed-in manager sets (or, with the current PIN,
 * replaces) their own local PIN for approving count variances. Main owns the
 * identity, the scope, the step-up window (2 minutes after an online
 * sign-in), the weak-PIN list and the lockout; this screen only sends the
 * typed PINs and shows the closed-set answer. Every PIN field is masked and
 * cleared on the press; no PIN is kept, shown or logged.
 */
export function ManagerPinEnrollment({
  bridge,
}: Readonly<{ bridge: ShiftCashupBridgeAPI }>): JSX.Element {
  const headingId = useId();
  const ids = { pin: useId(), confirm: useId(), current: useId() };
  const [fields, setFields] = useState<PinFields>(EMPTY);
  const [result, setResult] = useState<Result>(null);
  const { busy, run } = useSingleFlight();

  const field = (key: keyof PinFields, label: string): JSX.Element => (
    <div className="v5-shift-field">
      <label htmlFor={ids[key]}>{label}</label>
      <input
        id={ids[key]}
        className="v5-shift-pin"
        dir="ltr"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={fields[key]}
        onChange={(event) => {
          setFields({ ...fields, [key]: event.target.value });
        }}
      />
    </div>
  );

  const submit = (): void => {
    const request = enrolmentOf(fields);
    setFields(EMPTY);
    if ('invalid' in request) {
      setResult({ kind: 'error', message: request.invalid });
      return;
    }
    setResult(null);
    run(async () => {
      const answer = await callShift(() => bridge.enrollManagerPin(request));
      setResult(
        answer.kind === 'enrolled'
          ? answer
          : { kind: 'error', message: shiftRefusalMessage(answer.reason) },
      );
    });
  };

  return (
    <section
      className="v5-shift-card"
      aria-labelledby={headingId}
      data-testid="manager-pin-enrollment"
    >
      <div className="v5-shift-lead">
        <span className="v5-shift-glyph" aria-hidden="true">
          <Icon name="lock" />
        </span>
        <div>
          <h2 id={headingId}>{SHIFT_COPY.enrollHeading}</h2>
          <p className="v5-shift-hint">{SHIFT_COPY.enrollHint}</p>
        </div>
      </div>
      <div className="v5-shift-card__body">
        {field('pin', SHIFT_COPY.newPinLabel)}
        {field('confirm', SHIFT_COPY.confirmPinLabel)}
        {field('current', SHIFT_COPY.currentPinLabel)}
        {result?.kind === 'enrolled' && <Notice tone="success">{SHIFT_COPY.enrolled}</Notice>}
        <ShiftRefusal message={result?.kind === 'error' ? result.message : null} />
        <div className="v5-shift-commit">
          <button
            type="button"
            className="v5-shift-btn v5-shift-btn--primary"
            disabled={busy}
            onClick={submit}
          >
            {SHIFT_COPY.enrollCommit}
          </button>
        </div>
      </div>
    </section>
  );
}
