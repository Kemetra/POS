import type { JSX } from 'react';

type LoadingVariant = 'skeleton' | 'centerStage';

interface LoadingStateProps {
  message?: string;
  variant?: LoadingVariant;
}

function SkeletonRows(): JSX.Element {
  const widths = ['75%', '60%', '80%', '50%', '70%'];
  return (
    <div
      data-variant="skeleton"
      aria-hidden="true"
      className="loading-state loading-state--skeleton"
    >
      {widths.map((w, i) => (
        <div key={i} className="loading-state__skeleton-row" style={{ width: w }} />
      ))}
    </div>
  );
}

function CenterStage({ message }: Readonly<{ message: string }>): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-variant="centerStage"
      className="loading-state loading-state--center-stage"
    >
      <div className="loading-state__dot" aria-hidden="true" />
      <h1 className="loading-state__title">{message}</h1>
      <p className="loading-state__helper">Establishing secure connection</p>
      <ol className="loading-state__steps">
        <li>Verifying terminal credentials</li>
        <li>Connecting to SmartDataPulse</li>
        <li>Loading operator roster</li>
      </ol>
    </div>
  );
}

export function LoadingState({
  message = 'Loading…',
  variant,
}: Readonly<LoadingStateProps>): JSX.Element {
  if (variant === 'skeleton') {
    return <SkeletonRows />;
  }

  if (variant === 'centerStage') {
    return <CenterStage message={message} />;
  }

  return (
    <div role="status" aria-live="polite">
      <span>{message}</span>
    </div>
  );
}
