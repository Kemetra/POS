/**
 * T043 — InventoryPlaceholder with US3 state-variant support.
 *
 * In dev builds, reads `?state=` from the URL and renders the matching state
 * primitive. Production builds tree-shake the dev branch via the
 * `import.meta.env.DEV` guard.
 *
 * NOTE: Default state carries the mandatory "navigation only" message
 * (FR-13) — inventory management is not available at this terminal.
 */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { LoadingState, EmptyState, ErrorState } from '../../ui/states';
import { ScreenSection } from '../../v5/foundation/ScreenSection';

function resolveDevState(): string {
  const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (metaEnv?.DEV && typeof window !== 'undefined') {
    return new URLSearchParams(window.location.search).get('state') ?? '';
  }
  return '';
}

export function InventoryPlaceholder(): JSX.Element {
  const devState = resolveDevState();

  if (devState === 'loading') {
    return <LoadingState message="Loading Inventory…" />;
  }
  if (devState === 'empty') {
    return (
      <EmptyState
        heading="No inventory items"
        description="There are no inventory items to display."
      />
    );
  }
  if (devState === 'error') {
    return (
      <ErrorState
        heading="Inventory unavailable"
        description="Could not load inventory data. Please try again."
      />
    );
  }

  return (
    <ScreenSection title="Inventory">
      <section className="placeholder-pane">
        <p>Navigation only — inventory management is not available at this terminal.</p>
        <p>
          <Link to="/app/inventory/diagnostics" data-testid="inventory-diagnostics-link">
            Catalogue Diagnostics
          </Link>
        </p>
      </section>
    </ScreenSection>
  );
}
