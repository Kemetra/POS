import type { JSX } from 'react';

import { roleDisplayNameAr, type Role } from '../../../shared/operator/role.js';

/**
 * 004-operator-session T031 — OperatorBadge.
 *
 * Slots into 003's role-indicator region (FR-020). Renders the
 * operator's display name + the business-name role string (FR-002),
 * in Arabic (RT-240): the badge sits on Checkout and the shell top bar.
 * The component is presentational; the `display_name` and `role`
 * fields come from the renderer-side store (operator-session-store)
 * and are derived from the bridge `OperatorSessionBridgeView`.
 *
 * No tokens, no JWT, no operator id — those values never enter the
 * DOM. The rendered string set is `{display_name, business-name role}`
 * only.
 */

export interface OperatorBadgeProps {
  display_name: string;
  role: Role;
}

export function OperatorBadge(props: OperatorBadgeProps): JSX.Element {
  const initials = props.display_name.slice(0, 2).toUpperCase();
  return (
    <div data-testid="operator-badge" className="operator-badge">
      <span className="operator-badge__avatar" aria-hidden="true">
        {initials}
      </span>
      <span className="operator-badge__name">{props.display_name}</span>
      <span className="operator-badge__role" data-role={props.role}>
        {roleDisplayNameAr(props.role)}
      </span>
    </div>
  );
}
