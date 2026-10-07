/**
 * 004-operator-session T012 — Role enum (closed set; FR-002).
 *
 * Three roles only — `cashier`, `manager`, `admin`. Any other value is a
 * spec violation and a constitutional failure (Principle VIII: Clerk is
 * the sole identity provider; the role-set comes from Clerk's user
 * metadata mapped through the platform).
 *
 * The `displayName` map is the canonical machine→business-name binding
 * (FR-002 / AD-2). The renderer renders `displayName[role]`, never the
 * raw machine value.
 */

export const ROLES = ['cashier', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_SET = new Set<string>(ROLES);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLE_SET.has(value);
}

export const ROLE_DISPLAY_NAME: Readonly<Record<Role, string>> = Object.freeze({
  cashier: 'Cashier',
  manager: 'Manager',
  admin: 'Admin',
});

export function roleDisplayName(role: Role): string {
  return ROLE_DISPLAY_NAME[role];
}

/** The role as the cashier screens say it (RT-240: Arabic only). */
export const ROLE_DISPLAY_NAME_AR: Readonly<Record<Role, string>> = Object.freeze({
  cashier: 'كاشير',
  manager: 'مدير',
  admin: 'مسؤول النظام',
});

export function roleDisplayNameAr(role: Role): string {
  return ROLE_DISPLAY_NAME_AR[role];
}
