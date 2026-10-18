import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ShellNavEntryId } from '../../../../specs/003-pos-ui-shell/contracts/shell-routes';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { Icon } from '../../icons/Icon';
import { PharmacyCross } from '../brand/PharmacyCross';
import { isNavEntryCurrent, roleLabelAr, visibleNavEntries } from './nav-model';
import { StatusIndicator } from './StatusIndicator';
import { V5SignOut } from './V5SignOut';

/**
 * RT-242: the slim rail's glyph per entry (decorative; the label beside it
 * names the entry). RT-695: the current entry takes the Filled glyph
 * (D-263-8); the labelled panel shows no glyph at all (frame.css).
 */
const NAV_ICON = {
  dashboard: 'dashboard',
  cart: 'cart',
  sales: 'sale',
  returns: 'return',
  audit: 'audit',
  inventory: 'inventory',
  settings: 'settings',
} as const satisfies Readonly<Record<ShellNavEntryId, string>>;

/**
 * Primary v5 navigation. Owns the only brand mark and the operator identity,
 * so no screen repeats either. Labels stay visible at every supported width:
 * operators are workflow experts, not icon readers. On an active-sale route
 * the frame narrows this to the slim rail (RT-242); the icon then sits above
 * the label, which is still the link's text and accessible name.
 *
 * RT-604 (VN-S6 S6-3): the footer holds the status indicator (connection,
 * sale sync, printer on failure) above the operator block.
 */
export function V5Navigation(): JSX.Element {
  const session = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session : undefined,
  );
  const entries = visibleNavEntries(session?.role);
  const { pathname } = useLocation();

  return (
    <nav className="v5-frame__nav" aria-label="التنقل الرئيسي">
      <div className="v5-frame__brand">
        <span className="v5-frame__brand-mark" aria-hidden="true">
          <PharmacyCross size={18} />
        </span>
        <span className="v5-frame__brand-name v5-ltr">POS Pulse</span>
      </div>

      <ul className="v5-frame__links">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Link
              to={entry.path}
              aria-current={isNavEntryCurrent(entry, pathname) ? 'page' : undefined}
              className={`v5-frame__link${isNavEntryCurrent(entry, pathname) ? ' v5-frame__link--active' : ''}`}
            >
              <span className="v5-frame__link-icon">
                <Icon name={NAV_ICON[entry.id]} selected={isNavEntryCurrent(entry, pathname)} />
              </span>
              <span className="v5-frame__link-label">{entry.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <StatusIndicator />

      {session !== undefined && (
        <div className="v5-frame__operator" data-testid="v5-frame-operator">
          <span className="v5-frame__operator-name">{session.display_name}</span>
          <span className="v5-frame__operator-role">{roleLabelAr(session.role)}</span>
          <V5SignOut />
        </div>
      )}
    </nav>
  );
}
