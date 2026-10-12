import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { shellNavEntries } from '../../../../specs/003-pos-ui-shell/contracts/shell-routes';
import { useViewportTier } from '../viewport/useViewportTier';
import { useOperatorSessionStore } from '../../stores/operator-session-store';

/**
 * NavRail — responsive primary navigation (POS v3.5 `POS_NAV`, 7 entries).
 *
 * ≥ 1280 px (expanded): icons + Arabic labels.
 * 1024–1279 px (icon-only): icons only (Arabic label clipped via CSS).
 * < 1024 px (too-small): not rendered (AppShell shows ScreenTooSmall instead).
 *
 * Arabic-first: the operator sees the Arabic `label` as the visible text. The
 * English `labelEn` is always the link's accessible name (aria-label) and the
 * icon-only tooltip, so the accessible name is language-stable for screen
 * readers and tests in both rail modes. The Arabic visible label is marked
 * aria-hidden so the link's accessible name is exactly the English name (not a
 * duplicated bilingual string).
 *
 * Hard exclusion: NO mobile hamburger drawer at any width.
 * (contracts/shell-regions.md §"NavRail" + Spec Clarifications §2)
 *
 * PR #434 FIX 2 — role-filtered. Each entry may carry an optional `allow`
 * role list; the rail renders an entry only when it is unrestricted
 * (`allow === undefined`) or the current operator's role is in `allow`.
 * This keeps a cashier from seeing links to manager/admin-only surfaces
 * (Returns, Audit) that the router guard (FIX 1) would redirect away anyway.
 */
export function NavRail(): JSX.Element | null {
  const { tier } = useViewportTier();
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : undefined,
  );

  if (tier === 'too-small') return null;

  const iconOnly = tier === 'icon-only';

  const visibleEntries = shellNavEntries.filter(
    (entry) => entry.allow === undefined || (role !== undefined && entry.allow.includes(role)),
  );

  return (
    <nav aria-label="Primary" className="nav-rail">
      {visibleEntries.map((entry) => (
        <NavLink
          key={entry.id}
          to={entry.path}
          aria-label={entry.labelEn}
          title={iconOnly ? entry.labelEn : undefined}
          className={({ isActive }) =>
            `nav-rail__entry${isActive ? ' nav-rail__entry--active' : ''}`
          }
        >
          <span aria-hidden="true" data-icon={entry.iconKey} />
          {!iconOnly && (
            <span aria-hidden="true" className="nav-rail__label">
              {entry.label}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
