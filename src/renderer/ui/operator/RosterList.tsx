import type { JSX } from 'react';

import type { Role } from '../../../shared/operator/role.js';
import { nameInitial } from '../../v5/entry/entry-copy.js';

/**
 * 004-operator-session T030 / T075 — RosterList.
 *
 * Renders a list of cashiers with display name ONLY
 * (FR-006 / FR-031 — no email, no phone, no audit history).
 *
 *   - Pass `onSelect` + `selectedId` to enable interactive mode.
 *   - Each cashier becomes a `<button type="button">` inside its `<li>`.
 *   - `data-cashier-id` is intentionally NOT emitted (minimum-disclosure,
 *     PR #129). Tests target rows by positional data-testid (roster-item-0,
 *     roster-item-1, …).
 *
 * RT-244 (VNext W1-D, G-1 references): a two-column grid of name tiles that
 * scrolls inside its own region. Each tile carries a one-letter badge and the
 * name, which wraps to two lines and then clamps; the full name stays the
 * button's accessible name. The English per-tile role label is gone: every
 * tile is a cashier. An empty or inert roster renders no message here — the
 * sign-in route owns the truthful roster state (offline, refused or empty).
 */

export interface RosterEntry {
  id: string;
  display_name: string;
  role: Extract<Role, 'cashier'>;
}

export interface RosterListProps {
  /** Populated from `operator.listBranchRoster`. */
  cashiers: ReadonlyArray<RosterEntry>;
  /** When true, the roster renders no tiles (the route shows why). */
  inert?: boolean;
  /** Called when a cashier tile is selected. */
  onSelect?: (cashier: RosterEntry) => void;
  /** id of the currently selected cashier (highlights the tile). */
  selectedId?: string | undefined;
  /** True while a sign-in is in flight: no tile may switch the column. */
  disabled?: boolean;
}

export function RosterList(props: Readonly<RosterListProps>): JSX.Element {
  const { cashiers, inert, onSelect, selectedId, disabled = false } = props;

  if (inert === true || cashiers.length === 0) {
    return <div data-testid="roster-list" data-state="inert" hidden />;
  }

  const interactive = onSelect !== undefined;

  return (
    <ul
      className="v5-entry__roster"
      data-testid="roster-list"
      data-state="active"
      aria-label="قائمة الكاشير"
    >
      {cashiers.map((c, idx) => {
        const selected = c.id === selectedId;
        const tile = (
          <>
            <span className="v5-entry__badge" aria-hidden="true">
              {nameInitial(c.display_name)}
            </span>
            <span className="v5-entry__name">{c.display_name}</span>
          </>
        );
        return (
          <li key={c.id} data-selected={selected || undefined}>
            {interactive ? (
              <button
                type="button"
                className="v5-entry__who"
                data-testid={`roster-item-${String(idx)}`}
                aria-pressed={selected}
                aria-label={c.display_name}
                disabled={disabled}
                onClick={() => {
                  onSelect(c);
                }}
              >
                {tile}
              </button>
            ) : (
              <div className="v5-entry__who">{tile}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
