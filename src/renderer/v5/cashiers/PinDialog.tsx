import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';

import { Dialog } from '../foundation/Dialog';
import { Notice } from '../foundation/Notice';
import { CASHIERS_COPY } from './cashiers-copy';
import { canSavePin, checkPinEntry } from './cashiers-model';

/**
 * RT-424 (doc 19 §4, M5) — set a first PIN or change a PIN.
 *
 * - Two masked, LTR, numeric fields; 4–6 digits (Arabic-Indic digits count).
 * - «حفظ» is enabled once both fields hold 4–6 digits. Save (or Enter in a
 *   field) checks first: a wrong length gives M-K4, two different PINs M-K3.
 *   Either clears both fields and returns focus to the first.
 * - A refusal the caller hands back (M-K10 not ready, M-K9 failure) shows in
 *   the same always-mounted slot, with the same clear-and-refocus.
 * - Escape and «إلغاء» close it only while nothing is pending (RT-235 guard).
 * - The PIN lives in this component's state only; it is never placed in a text
 *   node, logged or echoed (PR-1).
 */

export type PinDialogMode = 'first_pin' | 'change_pin';

/**
 * The caller's answer to a Save: `closed` ends the dialog; `ignored` means
 * another call held the shared guard and nothing was sent; the refusals show
 * in the dialog's slot.
 */
export type PinSaveResult = 'closed' | 'ignored' | 'not_ready' | 'failure';

type Feedback = 'mismatch' | 'wrong_length' | 'not_ready' | 'failure' | null;

const FEEDBACK_TEXT: Record<Exclude<Feedback, null>, string> = {
  mismatch: CASHIERS_COPY.mismatch,
  wrong_length: CASHIERS_COPY.wrongLength,
  not_ready: CASHIERS_COPY.notReady,
  failure: CASHIERS_COPY.failure,
};

export interface PinDialogProps {
  mode: PinDialogMode;
  name: string;
  /** A call is in flight (the screen's shared guard). */
  pending: boolean;
  onSave: (pin: string) => Promise<PinSaveResult>;
  onCancel: () => void;
}

export function PinDialog({ mode, name, pending, onSave, onCancel }: PinDialogProps): JSX.Element {
  const ids = { title: useId(), hint: useId(), msg: useId(), first: useId(), second: useId() };
  const firstRef = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Bumped on every rejection; the first field takes focus once it is enabled
  // again (a refusal from main lands while the fields are still disabled).
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0 && !pending) firstRef.current?.focus();
  }, [refocus, pending]);

  const reject = (reason: Exclude<Feedback, null>): void => {
    setFeedback(reason);
    setFirst('');
    setSecond('');
    setRefocus((n) => n + 1);
  };

  const submit = async (): Promise<void> => {
    if (pending) return;
    const check = checkPinEntry(first, second);
    if (check.kind !== 'ok') {
      reject(check.kind);
      return;
    }
    setFeedback(null);
    const result = await onSave(check.pin);
    if (!mounted.current) return;
    if (isRefusal(result)) reject(result);
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };

  // Enter in a field runs the same check even while «حفظ» is disabled, so a
  // short entry gets M-K4 instead of nothing.
  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit();
  };

  const title = CASHIERS_COPY.dialogTitle[mode];
  const invalid = feedback === 'mismatch' || feedback === 'wrong_length';
  const describedBy = `${ids.hint} ${ids.msg}`;
  const field = {
    className: 'v5-cashiers-input v5-cashiers-input--pin',
    type: 'password',
    inputMode: 'numeric' as const,
    autoComplete: 'off',
    dir: 'ltr',
    maxLength: 6,
    disabled: pending,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': describedBy,
    onKeyDown: onFieldKeyDown,
  };

  return (
    <Dialog
      label={`${title} ${name}`}
      {...(pending ? {} : { onCancel })}
      initialFocusRef={firstRef}
    >
      <h2 id={ids.title} className="v5-cashiers-dialog-title">
        {title} <bdi>{name}</bdi>
      </h2>
      <form className="v5-cashiers-form" onSubmit={onSubmit} noValidate>
        <p className="v5-cashiers-hint" id={ids.hint}>
          {CASHIERS_COPY.hint}
        </p>
        <div className="v5-cashiers-field">
          <label htmlFor={ids.first}>{CASHIERS_COPY.newPin}</label>
          <input
            {...field}
            id={ids.first}
            ref={firstRef}
            value={first}
            data-testid="pin-new"
            onChange={(e) => {
              setFirst(e.target.value);
            }}
          />
        </div>
        <div className="v5-cashiers-field">
          <label htmlFor={ids.second}>{CASHIERS_COPY.confirmPin}</label>
          <input
            {...field}
            id={ids.second}
            value={second}
            data-testid="pin-confirm"
            onChange={(e) => {
              setSecond(e.target.value);
            }}
          />
        </div>
        <div className="v5-cashiers-slot-msg" id={ids.msg} role="status" aria-live="polite">
          {feedback !== null && (
            <Notice tone="warning" announce={false} testId="pin-dialog-message">
              {FEEDBACK_TEXT[feedback]}
            </Notice>
          )}
        </div>
        <div className="v5-cashiers-dialog-actions">
          <button type="button" className="v5-cashiers-btn" disabled={pending} onClick={onCancel}>
            {CASHIERS_COPY.cancel}
          </button>
          <button
            type="submit"
            className="v5-cashiers-btn v5-cashiers-btn--primary"
            disabled={pending || !canSavePin(first, second)}
          >
            {CASHIERS_COPY.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A Save answer the dialog shows in its slot (the others end it or change nothing). */
function isRefusal(result: PinSaveResult): result is 'not_ready' | 'failure' {
  return result === 'not_ready' || result === 'failure';
}

/** False once the dialog unmounts, so a late answer never touches its state. */
function useMounted(): { readonly current: boolean } {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}
