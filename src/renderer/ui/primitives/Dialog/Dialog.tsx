import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';

type DialogVariant = 'default' | 'confirm' | 'destructive';

interface DialogAction {
  label: string;
  onClick: () => void;
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: DialogVariant;
  title: string;
  description?: string;
  children: ReactNode;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
}

export function Dialog({
  open,
  onOpenChange,
  variant = 'default',
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
}: DialogProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `dialog-title-${useId()}`;

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  const primaryIntent = variant === 'destructive' ? 'destructive' : 'primary';

  return (
    <>
      <div className="dialog-overlay" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? `${titleId}-desc` : undefined}
        tabIndex={-1}
        data-variant={variant}
        className="dialog-panel"
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p id={`${titleId}-desc`}>{description}</p>}
        <div className="dialog-panel__body">{children}</div>
        <div className="dialog-panel__actions">
          {secondaryAction && (
            <button
              type="button"
              className="btn btn--ghost btn--md"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
          {primaryAction && (
            <button
              type="button"
              className={`btn btn--${primaryIntent} btn--md`}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
