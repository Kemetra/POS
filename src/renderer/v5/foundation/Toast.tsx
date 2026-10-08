import { useEffect, type JSX } from 'react';
import { V5Icon } from './V5Icon';
import './messages.css';

interface ToastProps {
  message: string;
  onDismiss: () => void;
  /** Time on screen before it leaves by itself. */
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 4000;

/**
 * RT-241 (VNext W1-A) — a neutral, transient acknowledgement (freeze 15 §4).
 * It has no tone on purpose: failures and consequential state are loud and
 * stay put (`Banner`, `Notice`, the owning surface), never a toast.
 */
export function Toast({
  message,
  onDismiss,
  durationMs = DEFAULT_DURATION_MS,
}: ToastProps): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => {
      clearTimeout(timer);
    };
  }, [durationMs, onDismiss]);

  return (
    <div role="status" aria-live="polite" className="v5-toast">
      <span className="v5-toast__text">{message}</span>
      <button
        type="button"
        className="v5-toast__close"
        aria-label="إغلاق الإشعار"
        onClick={onDismiss}
      >
        <V5Icon name="close" size={16} />
      </button>
    </div>
  );
}
