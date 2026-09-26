import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { V5Icon } from '../foundation/V5Icon';
import { roleLabelAr, visibleNavEntries } from './nav-model';
import { V5SignOut } from './V5SignOut';

/**
 * Primary v5 navigation. Owns the only brand mark and the operator identity,
 * so no screen repeats either. Labels stay visible at every supported width:
 * operators are workflow experts, not icon readers.
 */
export function V5Navigation({ salePath }: { salePath?: string | undefined }): JSX.Element {
  const session = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session : undefined,
  );
  const entries = visibleNavEntries(session?.role, salePath);

  return (
    <nav className="v5-frame__nav" aria-label="التنقل الرئيسي">
      <div className="v5-frame__brand">
        <span className="v5-frame__brand-mark" aria-hidden="true">
          <V5Icon name="cross" size={18} />
        </span>
        <span className="v5-frame__brand-name v5-ltr">POS Pulse</span>
      </div>

      <ul className="v5-frame__links">
        {entries.map((entry) => (
          <li key={entry.id}>
            <NavLink
              to={entry.path}
              className={({ isActive }) =>
                `v5-frame__link${isActive ? ' v5-frame__link--active' : ''}`
              }
            >
              {entry.label}
            </NavLink>
          </li>
        ))}
      </ul>

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
