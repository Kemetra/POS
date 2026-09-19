import type { JSX } from 'react';

import { roleDisplayName, type Role } from '../../../shared/operator/role.js';
import { EmptyState } from '../states/EmptyState.js';

/**
 * 004-operator-session T030 / T075 — RosterList.
 *
 * Renders a list of cashiers with display name + role badge ONLY
 * (FR-006 / FR-031 — no email, no phone, no audit history).
 *
 * S1 rendered this inert. S4 (T075) activates selection:
 *   - Pass `onSelect` + `selectedId` to enable interactive mode.
 *   - Each cashier becomes a `<button type="button">` inside its `<li>`.
 *   - `data-cashier-id` is intentionally NOT emitted (minimum-disclosure,
 *     PR #129). Tests target rows by positional data-testid (roster-item-0,
 *     roster-item-1, …). `data-role` is retained as a non-identifying label.
 */

export interface RosterEntry {
  id: string;
  display_name: string;
  role: Extract<Role, 'cashier'>;
}

export interface RosterListProps {
  /** Empty in S1; populated from `operator.listBranchRoster` in S4. */
  cashiers: ReadonlyArray<RosterEntry>;
  /**
   * S1: when true, the surface renders the inert empty-state message.
   * S4 passes false (or omits) when cashiers are available.
   */
  inert?: boolean;
  /** S4: called when a cashier item is selected. */
  onSelect?: (cashier: RosterEntry) => void;
  /** S4: id of the currently selected cashier (highlights the row). */
  selectedId?: string | undefined;
}

export function RosterList(props: RosterListProps): JSX.Element {
  const { cashiers, inert, onSelect, selectedId } = props;

  if (inert === true || cashiers.length === 0) {
    return (
      <section
        aria-label="قائمة الكاشير"
        data-testid="roster-list"
        data-state="inert"
        className="roster-list roster-list--inert"
      >
        <EmptyState
          heading="No cashiers available"
          description="Cashier sign-in is not yet available on this terminal. Sign in as a manager or admin to continue."
        />
      </section>
    );
  }

  const interactive = onSelect !== undefined;

  return (
    <section
      aria-label="قائمة الكاشير"
      data-testid="roster-list"
      data-state="active"
      className="roster-list"
    >
      <ul
        className="roster-list__items"
        role={interactive ? undefined : 'listbox'}
        aria-label={interactive ? undefined : 'Select cashier'}
      >
        {cashiers.map((c, idx) => (
          <li
            key={c.id}
            className={`roster-list__item${c.id === selectedId ? ' roster-list__item--selected' : ''}`}
            role={interactive ? undefined : 'option'}
            aria-selected={interactive ? undefined : c.id === selectedId}
          >
            {interactive ? (
              <button
                type="button"
                className="roster-list__item-btn"
                data-testid={`roster-item-${String(idx)}`}
                aria-pressed={c.id === selectedId}
                onClick={() => {
                  onSelect(c);
                }}
              >
                <span className="roster-list__avatar" aria-hidden="true">
                  {c.display_name.slice(0, 2).toUpperCase()}
                </span>
                <span className="roster-list__name">{c.display_name}</span>
                <span className="roster-list__role" data-role={c.role}>
                  {roleDisplayName(c.role)}
                </span>
              </button>
            ) : (
              <>
                <span className="roster-list__avatar" aria-hidden="true">
                  {c.display_name.slice(0, 2).toUpperCase()}
                </span>
                <span className="roster-list__name">{c.display_name}</span>
                <span className="roster-list__role" data-role={c.role}>
                  {roleDisplayName(c.role)}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
