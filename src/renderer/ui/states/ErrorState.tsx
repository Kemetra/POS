import type { JSX } from 'react';

interface ErrorStateProps {
  heading: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function ErrorState({
  heading,
  description,
  action,
}: Readonly<ErrorStateProps>): JSX.Element {
  return (
    <div className="error-state">
      <div className="error-state__icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM7.25 5a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5Zm.75 7a.875.875 0 1 1 0-1.75A.875.875 0 0 1 8 12Z"
            fill="currentColor"
          />
        </svg>
      </div>
      <h2 className="error-state__heading">{heading}</h2>
      <p className="error-state__description">{description}</p>
      {action && (
        <button type="button" className="btn btn--secondary btn--md" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
