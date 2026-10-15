import type { JSX } from 'react';
import type { ConnectionState } from '../../tokens/connection-state';

interface StatusBannerProps {
  state: ConnectionState;
  message?: string;
}

export function StatusBanner({ state, message }: Readonly<StatusBannerProps>): JSX.Element {
  if (state === 'online') {
    return <div aria-live="polite" aria-hidden="true" aria-label="Connection status" />;
  }

  return (
    <div role="status" aria-live="polite" className="status-banner" data-state={state}>
      {message}
    </div>
  );
}
