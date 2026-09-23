import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from 'react';

interface Props {
  label: string;
  onDismiss: () => void;
  initialFocusRef: RefObject<HTMLElement | null>;
  /** Return focus to the opener on close. Off when the caller routes focus itself. */
  restoreFocus?: boolean;
  children: ReactNode;
}

/** v5 modal: focuses a chosen control on open, dismisses on Escape, returns focus to its opener. */
export function SaleDialog({
  label,
  onDismiss,
  initialFocusRef,
  restoreFocus = true,
  children,
}: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef.current ?? panelRef.current)?.focus();
    return () => {
      if (restoreFocus && opener?.isConnected) opener.focus();
    };
  }, [initialFocusRef, restoreFocus]);

  return (
    <div className="v5-live-dialog-backdrop">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="v5-live-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDismiss();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
