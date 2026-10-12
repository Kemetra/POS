import type { JSX } from 'react';

import { useOperatorSessionStore } from '../stores/operator-session-store.js';
import { useViewportTier } from './viewport/useViewportTier.js';

interface Props {
  /** Placeholder count = 0 in S4; live count wired by S5. */
  count: number;
}

/**
 * T080 — Stuck-shift count badge for the navigation area.
 *
 * Visibility rules (role-visibility-matrix.md §Section 3 / T079):
 *   - cashier → never visible
 *   - manager / admin → visible at expanded viewport only
 *   - icon-only viewport (1024–1279 px) → hidden (label context absent)
 *   - count = 0 → hidden (no "0" badge clutter)
 *
 * S4 ships count=0 (placeholder); S5 wires the live count feed.
 */
export function StuckShiftBadge({ count }: Props): JSX.Element | null {
  const state = useOperatorSessionStore((s) => s.state);
  const { tier } = useViewportTier();

  if (state.kind !== 'signedIn') return null;
  if (state.session.role === 'cashier') return null;
  if (tier !== 'expanded') return null;
  if (count === 0) return null;

  const label = `${String(count)} stuck shift${count !== 1 ? 's' : ''}`;

  return (
    <span data-testid="stuck-shift-badge" aria-label={label} className="stuck-shift-badge">
      {count}
    </span>
  );
}
