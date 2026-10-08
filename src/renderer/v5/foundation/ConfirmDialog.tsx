import { useId, useRef, type JSX, type ReactNode } from 'react';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  /** Accessible name of the dialog. */
  label: string;
  title: string;
  body?: ReactNode;
  /** The safe option: focused on open, so Enter never confirms (F-22). */
  cancelLabel: string;
  confirmLabel: string;
  /** `danger` for destructive confirms (void, cancel after card). */
  tone?: 'default' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
  /** While the confirm runs, neither action (nor Esc) can fire again. */
  busy?: boolean;
  /** A failed confirm says so inside the dialog. */
  error?: string | null;
  restoreFocus?: boolean;
}

/**
 * RT-241 (VNext W1-A) — a two-option confirmation built on the one Dialog.
 * Stable action slots (freeze §4 A2): cancel/back at inline-start, the commit
 * at inline-end, in every state.
 */
export function ConfirmDialog({
  label,
  title,
  body,
  cancelLabel,
  confirmLabel,
  tone = 'default',
  onCancel,
  onConfirm,
  busy = false,
  error = null,
  restoreFocus = true,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const confirmClass = tone === 'danger' ? 'v5-live-btn--danger' : 'v5-live-btn--primary';

  return (
    <Dialog
      label={label}
      initialFocusRef={cancelRef}
      restoreFocus={restoreFocus}
      {...(busy ? {} : { onCancel })}
      {...(body !== undefined ? { describedBy: bodyId } : {})}
    >
      <h2 className="v5-live-dialog-title">{title}</h2>
      {body !== undefined && <p id={bodyId}>{body}</p>}
      {error !== null && (
        <p role="alert" className="v5-live-notice v5-live-notice--danger">
          {error}
        </p>
      )}
      <div>
        <button
          ref={cancelRef}
          type="button"
          className="v5-live-btn"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`v5-live-btn ${confirmClass}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
