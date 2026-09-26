import type { Role } from '../../../shared/operator/role';
import {
  shellNavEntries,
  type ShellNavEntryId,
} from '../../../../specs/003-pos-ui-shell/contracts/shell-routes';

/** The v5 Sale route (023 Slice G: the production `/app/cart`). */
export const V5_SALE_PATH = '/app/cart';

/** Routes that belong to the Sale entry: the sale and its checkout. */
const SALE_LOOP_PATHS: ReadonlyArray<string> = ['/app/cart', '/app/checkout'];

export interface V5NavEntry {
  readonly id: ShellNavEntryId;
  /** Arabic label: both the visible text and the accessible name. */
  readonly label: string;
  readonly path: string;
  readonly allow?: ReadonlyArray<Role>;
}

/**
 * The v5 navigation is derived from the one existing seven-entry contract, so
 * labels, order, paths and role gates cannot drift from the legacy rail.
 */
export const v5NavEntries: ReadonlyArray<V5NavEntry> = shellNavEntries.map((entry) => ({
  id: entry.id,
  label: entry.label,
  path: entry.path,
  ...(entry.allow !== undefined ? { allow: entry.allow } : {}),
}));

/**
 * Is this entry the current one? Prefix match like NavLink, plus the Sale
 * entry stays current through checkout: one sale, one place in the nav.
 */
export function isNavEntryCurrent(entry: V5NavEntry, pathname: string): boolean {
  const paths = entry.id === 'cart' ? SALE_LOOP_PATHS : [entry.path];
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Same rule as the legacy rail: unrestricted entries, or the role is allowed. */
export function visibleNavEntries(role: Role | undefined): ReadonlyArray<V5NavEntry> {
  return v5NavEntries.filter(
    (entry) => entry.allow === undefined || (role !== undefined && entry.allow.includes(role)),
  );
}

const ROLE_LABEL_AR: Readonly<Record<Role, string>> = {
  cashier: 'كاشير',
  manager: 'مدير',
  admin: 'مسؤول النظام',
};

export function roleLabelAr(role: Role): string {
  return ROLE_LABEL_AR[role];
}
