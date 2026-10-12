import {
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from 'react';

import { Dialog, DialogHost } from '../foundation/Dialog.js';
import { ToneIcon } from '../foundation/ToneIcon.js';
import '../foundation/messages.css';
import { CASHIER_PIN_RE, CASHIERS_COPY, DIALOG_TITLE } from './cashiers-copy.js';
import './cashiers.css';

/**
 * RT-424 (D-M1, doc 19 §4) — M5: set a first PIN or change a PIN.
 *
 * - Two fields, «الرقم السري الجديد» and «تأكيد الرقم السري»: digits only,
 *   LTR, `type=password`, 4–6 digits (the cashier rule, `PIN_RE` in main).
 * - «حفظ» stays disabled until both fields hold 4–6 digits. On submit (the
 *   button, or Enter in a field) the renderer checks the length (M-K4) and the
 *   match (M-K3) before any call; either clears both fields and returns focus
 *   to the first. Main still validates.
 * - The one v5 Dialog: modal, Tab stays inside, focus starts on the first
 *   field. Esc and «إلغاء» close it only while nothing is pending.
 * - Secrets: the PIN lives only in this component's state and is handed to
 *   `onSave` once. It is never logged, echoed or put in a text node.
 * - `inlineMessage` is a refusal the caller keeps inside the dialog (M-K10).
 */

export interface PinDialogProps {
  mode: 'first' | 'change';
  cashierName: string;
  pending: boolean;
  inlineMessage?: string;
  onSave: (pin: string) => void;
  onCancel: () => void;
}

type FieldError = 'none' | 'mismatch' | 'wrong_length';

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function PinDialog({
  mode,
  cashierName,
  pending,
  inlineMessage,
  onSave,
  onCancel,
}: PinDialogProps): JSX.Element {
  const titleId = useId();
  const hintId = useId();
  const msgId = useId();
  const firstId = useId();
  const secondId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<FieldError>('none');

  const canSave = !pending && first.length >= 4 && second.length >= 4;
  const title = DIALOG_TITLE[mode];

  const reject = (why: Exclude<FieldError, 'none'>): void => {
    setFirst('');
    setSecond('');
    setError(why);
    firstRef.current?.focus();
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    if (!CASHIER_PIN_RE.test(first) || !CASHIER_PIN_RE.test(second)) {
      reject('wrong_length');
      return;
    }
    if (first !== second) {
      reject('mismatch');
      return;
    }
    setError('none');
    onSave(first);
  };

  // A disabled submit button blocks the browser's implicit Enter submission,
  // so Enter on a short PIN is handled here: M-K4 rather than nothing.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Enter' || pending || canSave) return;
    event.preventDefault();
    if (first.length > 0 || second.length > 0) reject('wrong_length');
  };

  const message =
    error === 'mismatch'
      ? CASHIERS_COPY.mismatch
      : error === 'wrong_length'
        ? CASHIERS_COPY.wrongLength
        : inlineMessage;
  const invalid = error !== 'none';
  const describedBy = invalid ? `${hintId} ${msgId}` : hintId;

  return (
    <DialogHost>
      <Dialog
        label={`${title.before}${cashierName}${title.after}`}
        {...(pending ? {} : { onCancel })}
        initialFocusRef={firstRef}
      >
        <h2 id={titleId} className="v5-cashiers-dialog__title">
          {title.before}
          <bdi>{cashierName}</bdi>
          {title.after}
        </h2>
        <form
          className="v5-cashiers-dialog"
          data-testid="pin-dialog"
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          noValidate
        >
          <p className="v5-cashiers-dialog__hint" id={hintId}>
            {CASHIERS_COPY.pinHint}
          </p>
          <div className="v5-cashiers-dialog__fields">
            <div className="v5-cashiers-dialog__field">
              <label htmlFor={firstId}>{CASHIERS_COPY.newPinLabel}</label>
              <input
                id={firstId}
                ref={firstRef}
                className="v5-cashiers-dialog__pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                dir="ltr"
                disabled={pending}
                value={first}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setFirst(digitsOnly(e.target.value));
                }}
              />
            </div>
            <div className="v5-cashiers-dialog__field">
              <label htmlFor={secondId}>{CASHIERS_COPY.confirmPinLabel}</label>
              <input
                id={secondId}
                className="v5-cashiers-dialog__pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                dir="ltr"
                disabled={pending}
                value={second}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setSecond(digitsOnly(e.target.value));
                }}
              />
            </div>
          </div>
          <div className="v5-cashiers-dialog__slot" id={msgId} role="status" aria-live="polite">
            {message !== undefined && (
              <span className="v5-notice" data-tone="warning" data-testid="pin-dialog-message">
                <ToneIcon tone="warning" />
                <span className="v5-notice__text">{message}</span>
              </span>
            )}
          </div>
          <div className="v5-cashiers-dialog__actions">
            <button type="button" className="v5-cashiers-btn" disabled={pending} onClick={onCancel}>
              {CASHIERS_COPY.cancel}
            </button>
            <button
              type="submit"
              className="v5-cashiers-btn v5-cashiers-btn--primary"
              disabled={!canSave}
            >
              {CASHIERS_COPY.save}
            </button>
          </div>
        </form>
      </Dialog>
    </DialogHost>
  );
}
