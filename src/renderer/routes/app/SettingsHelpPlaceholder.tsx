/**
 * T043 — SettingsHelpPlaceholder with US3 state-variant support.
 *
 * In dev builds, reads `?state=` from the URL and renders the matching state
 * primitive. Production builds tree-shake the dev branch via the
 * `import.meta.env.DEV` guard.
 *
 * NOTE: No density toggle is exposed in this pane (Clarifications §1 —
 * density toggle is guarded out of this feature).
 */
import type { JSX } from 'react';
import { LoadingState, EmptyState, ErrorState } from '../../ui/states';
import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { SettingsSkeleton } from './SettingsSkeleton';

function resolveDevState(): string {
  const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (metaEnv?.DEV && typeof window !== 'undefined') {
    return new URLSearchParams(window.location.search).get('state') ?? '';
  }
  return '';
}

export function SettingsHelpPlaceholder(): JSX.Element {
  const devState = resolveDevState();

  if (devState === 'loading') {
    return <LoadingState message="Loading Settings / Help…" />;
  }
  if (devState === 'empty') {
    return (
      <EmptyState
        heading="No settings available"
        description="No configurable settings are available at this time."
      />
    );
  }
  if (devState === 'error') {
    return (
      <ErrorState
        heading="Settings unavailable"
        description="Could not load settings. Please try again."
      />
    );
  }

  return (
    <ScreenSection title="Settings / Help">
      <SettingsSkeleton />
    </ScreenSection>
  );
}
