import type { Role } from '../../../shared/operator/role';
import {
  shellNavEntries,
  type ShellNavEntryId,
} from '../../../../specs/003-pos-ui-shell/contracts/shell-routes';

/** DEV-only preview path of the v5 frame + Sale composition. */
export const V5_SALE_PATH = '/v5/sale';

export interface V5NavEntry {
  readonly id: ShellNavEntryId;
  /** Arabic label: both the visible text and the accessible name. */
  readonly label: string;
  readonly path: string;
  readonly allow?: ReadonlyArray<Role>;
}

/**
 * The v5 navigation is derived from the one existing seven-entry contract, so
 * labels, order and role gates cannot drift from the legacy rail. Only the
 * Sale entry points at the v5 preview; every other entry keeps its existing
 * route (those screens are not migrated in this slice).
 */
export const v5NavEntries: ReadonlyArray<V5NavEntry> = shellNavEntries.map((entry) => ({
  id: entry.id,
  label: entry.label,
  path: entry.id === 'cart' ? V5_SALE_PATH : entry.path,
  ...(entry.allow !== undefined ? { allow: entry.allow } : {}),
}));

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
