import { roleDisplayNameAr, type Role } from '../../../shared/operator/role';
import {
  shellNavEntries,
  type ShellNavEntryId,
} from '../../../../specs/003-pos-ui-shell/contracts/shell-routes';

/** The v5 Sale route (023 Slice G: the production `/app/cart`). */
export const V5_SALE_PATH = '/app/cart';

/** Routes that belong to the Sale entry: the sale and its checkout. */
const SALE_LOOP_PATHS: ReadonlyArray<string> = ['/app/cart', '/app/checkout'];

function onPath(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * RT-242 (VN-S12) — an active-sale route: the Sale, its Checkout and the
 * completion inside it. The frame shows the slim rail here and the labelled
 * panel elsewhere. Route-based by owner decision (RT-242 session, 2026-10-09):
 * the frame never reads cart state.
 */
export function isActiveSaleRoute(pathname: string): boolean {
  return SALE_LOOP_PATHS.some((path) => onPath(pathname, path));
}

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
  return entry.id === 'cart' ? isActiveSaleRoute(pathname) : onPath(pathname, entry.path);
}

/**
 * RT-241 / OD-6 — what the cashier's v5 nav may show. An allowlist, so a new
 * placeholder never reaches the cashier by default. The Dashboard refuses the
 * cashier role, and Sales, Inventory and Settings are placeholders (freeze 15
 * §1: manager/admin only). Navigation only: route guards are unchanged.
 */
const CASHIER_NAV: ReadonlySet<ShellNavEntryId> = new Set<ShellNavEntryId>(['cart']);

/** Same rule as the legacy rail (unrestricted entries, or the role is allowed), plus OD-6. */
export function visibleNavEntries(role: Role | undefined): ReadonlyArray<V5NavEntry> {
  return v5NavEntries.filter((entry) => {
    if (role === 'cashier' && !CASHIER_NAV.has(entry.id)) return false;
    return entry.allow === undefined || (role !== undefined && entry.allow.includes(role));
  });
}

export function roleLabelAr(role: Role): string {
  return roleDisplayNameAr(role);
}
