import { useId, type JSX } from 'react';
import { Link } from 'react-router-dom';

import { V5Icon, type V5IconName } from '../../foundation/V5Icon';
import './manager-home.css';

interface ManagerTileProps {
  to: string;
  icon: V5IconName;
  title: string;
  description: string;
  testId: string;
}

/**
 * RT-499 (G-6) — one link card on the manager home: a glyph, the screen's name
 * and one line saying what it is for. The whole card is the link. Its
 * accessible name is the title alone and the line is its description, so a
 * screen reader hears «إدارة الكاشير» and then why. Navigation only.
 */
export function ManagerTile({
  to,
  icon,
  title,
  description,
  testId,
}: Readonly<ManagerTileProps>): JSX.Element {
  const id = useId();
  return (
    <li>
      <Link
        className="v5-manager-tile"
        to={to}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-line`}
        data-testid={testId}
      >
        <span className="v5-manager-tile__glyph">
          <V5Icon name={icon} />
        </span>
        <span id={`${id}-title`} className="v5-manager-tile__title">
          {title}
        </span>
        <span id={`${id}-line`} className="v5-manager-tile__line">
          {description}
        </span>
      </Link>
    </li>
  );
}
