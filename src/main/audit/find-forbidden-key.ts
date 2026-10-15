/**
 * Recursive scan of an audit payload for a forbidden field name (PR-1 / FR-027).
 *
 * One walker shared by every audit emitter: the canonical list from
 * `shared/audit/forbidden-keys.ts` is always refused; an emitter may add its own
 * domain-specific names through `extraForbidden`.
 */

import { FORBIDDEN_PAYLOAD_KEYS } from '../../shared/audit/forbidden-keys.js';

const SHARED_FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>(FORBIDDEN_PAYLOAD_KEYS);

/**
 * Returns the first forbidden key found anywhere in the plain-object tree
 * `node`, or `null` when the payload is clean.
 *
 * Arrays are iterated as collections of values; their numeric indices are
 * never themselves forbidden keys. Only string object keys are checked.
 */
export function findForbiddenKey(
  node: unknown,
  extraForbidden?: ReadonlySet<string>,
): string | null {
  if (Array.isArray(node)) return findInArray(node, extraForbidden);
  if (node !== null && typeof node === 'object') return findInObject(node, extraForbidden);
  return null;
}

function findInArray(
  items: readonly unknown[],
  extraForbidden?: ReadonlySet<string>,
): string | null {
  for (const item of items) {
    const hit = findForbiddenKey(item, extraForbidden);
    if (hit !== null) return hit;
  }
  return null;
}

function findInObject(obj: object, extraForbidden?: ReadonlySet<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (SHARED_FORBIDDEN_KEYS.has(key) || extraForbidden?.has(key) === true) return key;
    const hit = findForbiddenKey((obj as Record<string, unknown>)[key], extraForbidden);
    if (hit !== null) return hit;
  }
  return null;
}
