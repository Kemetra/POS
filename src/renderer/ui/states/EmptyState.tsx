import type { JSX } from 'react';

interface EmptyStateProps {
  heading: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  heading,
  description,
  action,
}: Readonly<EmptyStateProps>): JSX.Element {
  return (
    <div className="empty-state">
      <h2 className="empty-state__heading">{heading}</h2>
      <p className="empty-state__description">{description}</p>
      {action && (
        <button type="button" className="btn btn--primary btn--md" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
