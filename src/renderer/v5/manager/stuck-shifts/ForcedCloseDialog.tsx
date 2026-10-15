import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type RefObject,
  type SyntheticEvent,
} from 'react';

import {
  FORCED_CLOSE_REASONS,
  type ForcedCloseReason,
} from '../../../../shared/audit/payload-schemas';
import { Dialog } from '../../foundation/Dialog';
import { Notice } from '../../foundation/Notice';
import { STUCK_SHIFTS_COPY as COPY } from './stuck-shifts-copy';
import './stuck-shifts.css';

/**
 * RT-502 (VN-S10 S10-5, G-6 StuckOpen / StuckConfirm / StuckChanged /
 * StuckFailed) — the forced-close dialog on the one v5 Dialog.
 *
 * - The five FORCED_CLOSE_REASONS as Arabic radios; none is preselected, and
 *   «إغلاق الوردية» stays disabled (sunken) until one is chosen.
 * - Focus opens on the first reason (the safe control, never the commit); Esc
 *   and «إلغاء» cancel; focus returns to the row's button (the Dialog).
 * - While a call is in flight both buttons are disabled, as before.
 * - A refusal shows in the always-mounted slot, and focus moves to «إلغاء»
 *   (the commit was disabled mid-flight, so focus would otherwise be lost).
 * - The note is captured in `annotation` only, never in the reason, and only
 *   when it is not empty. No amount anywhere (FR-024 blind close).
 */

/** What the dialog hands back on submit (the T084 contract, unchanged). */
export interface ForcedCloseFormSubmitPayload {
  forced_close_reason: ForcedCloseReason;
  annotation?: string;
}

/** `changed`: `state_invalid` (the list was read again). `failed`: any other refusal. */
export type ForcedCloseRefusal = 'changed' | 'failed';

export interface ForcedCloseFormProps {
  onSubmit: (payload: ForcedCloseFormSubmitPayload) => void;
  onCancel: () => void;
  submitting?: boolean;
  refusal?: ForcedCloseRefusal | null;
  /** The first reason radio: the dialog's initial focus. */
  firstReasonRef?: RefObject<HTMLInputElement | null>;
  cancelRef?: RefObject<HTMLButtonElement | null>;
}

/** The reason picker, note, refusal slot and actions (the T084 form, in Arabic). */
export function ForcedCloseForm({
  onSubmit,
  onCancel,
  submitting = false,
  refusal = null,
  firstReasonRef,
  cancelRef,
}: Readonly<ForcedCloseFormProps>): JSX.Element {
  const noteId = useId();
  const [reason, setReason] = useState<ForcedCloseReason | null>(null);
  const [annotation, setAnnotation] = useState('');

  function handleSubmit(e: SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (reason == null) return;
    onSubmit(
      annotation ? { forced_close_reason: reason, annotation } : { forced_close_reason: reason },
    );
  }

  return (
    <form
      className="v5-stuck-form"
      data-testid="forced-close-form"
      onSubmit={handleSubmit}
      noValidate
    >
      <fieldset className="v5-stuck-choices">
        <legend>{COPY.reasonLegend}</legend>
        {FORCED_CLOSE_REASONS.map((r, index) => (
          <label key={r} className="v5-stuck-choice">
            <input
              ref={index === 0 ? firstReasonRef : undefined}
              type="radio"
              name="forced_close_reason"
              value={r}
              checked={reason === r}
              onChange={() => {
                setReason(r);
              }}
            />
            {COPY.reasons[r]}
          </label>
        ))}
      </fieldset>
      <div className="v5-stuck-field">
        <label htmlFor={noteId}>{COPY.note}</label>
        <textarea
          id={noteId}
          className="v5-stuck-textarea"
          dir="auto"
          value={annotation}
          maxLength={500}
          onChange={(e) => {
            setAnnotation(e.target.value);
          }}
        />
      </div>
      <div className="v5-stuck-slot" role="status" aria-live="polite">
        {refusal !== null && (
          <Notice tone="warning" announce={false} testId="stuck-shift-submit-error">
            {refusal === 'changed' ? COPY.changed : COPY.failed}
          </Notice>
        )}
      </div>
      <div className="v5-stuck-dialog-actions">
        <button
          ref={cancelRef}
          type="button"
          className="v5-stuck-btn"
          onClick={onCancel}
          disabled={submitting}
        >
          {COPY.cancel}
        </button>
        <button
          type="submit"
          className="v5-stuck-btn v5-stuck-btn--danger"
          disabled={reason == null || submitting}
        >
          {COPY.close}
        </button>
      </div>
    </form>
  );
}

export interface ForcedCloseDialogProps {
  /** The cashier name as shown (already resolved to the fallback when empty). */
  name: string;
  submitting: boolean;
  refusal: ForcedCloseRefusal | null;
  onSubmit: (payload: ForcedCloseFormSubmitPayload) => void;
  onCancel: () => void;
}

export function ForcedCloseDialog({
  name,
  submitting,
  refusal,
  onSubmit,
  onCancel,
}: Readonly<ForcedCloseDialogProps>): JSX.Element {
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // After an answer that keeps the dialog open, focus «إلغاء» (G-6 Changed / Failed).
  useEffect(() => {
    if (!submitting && refusal !== null) cancelRef.current?.focus();
  }, [submitting, refusal]);

  return (
    <Dialog
      label={`${COPY.dialogTitle} ${name}`}
      onCancel={onCancel}
      initialFocusRef={firstReasonRef}
    >
      <h2 className="v5-stuck-dialog-title">
        {COPY.dialogTitle} <bdi>{name}</bdi>
      </h2>
      <ForcedCloseForm
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        refusal={refusal}
        firstReasonRef={firstReasonRef}
        cancelRef={cancelRef}
      />
    </Dialog>
  );
}
