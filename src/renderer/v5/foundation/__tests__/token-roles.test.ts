import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-241 (VNext W1-A, VN-S2) — token parity for the role aliases.
 *
 * W1-A adds role ALIASES only (freeze 15 §4 "Token roles"): every alias is a
 * `var()` reference to a shipped token, and resolves to the value DESIGN.md's
 * frontmatter / Motion section already names. No shipped value changes; later
 * bounded slices own target values (UX-02/03/04).
 *
 * The expected values below are hand-copied from docs/DESIGN.md (typography
 * frontmatter; §Motion "80ms press, 150ms row flash and notice in, 220ms dialog
 * in, ease-out cubic-bezier(0.2, 0.7, 0.25, 1)").
 */

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tailwind = stripComments(
  readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf-8'),
);
const foundation = stripComments(readFileSync(resolve(__dirname, '../foundation.css'), 'utf-8'));

/** Declarations of the first top-level rule whose selector list is exactly `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.[\]()'":]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  const decls = new Map<string, string>();
  for (const part of (match[1] ?? '').split(';')) {
    const [name, ...value] = part.split(':');
    if (name !== undefined && value.length > 0) decls.set(name.trim(), value.join(':').trim());
  }
  return decls;
}

const root = block(tailwind, ':root');
const frame = block(foundation, '.v5-frame');

/** Follows `var(--x)` through the frame aliases, then the shipped :root tokens. */
function resolveToken(name: string): string {
  const value = frame.get(name) ?? root.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return ref === null ? value : resolveToken(ref[1] ?? '');
}

const TYPE_ROLES: ReadonlyArray<[string, string]> = [
  ['--type-amount-hero', '2.75rem'],
  ['--type-amount-total', '1.875rem'],
  ['--type-screen-title', '1.25rem'],
  ['--type-section', '1rem'],
  ['--type-control-lg', '1rem'],
  ['--type-body', '0.875rem'],
  ['--type-money-row', '0.875rem'],
  ['--type-meta', '0.75rem'],
  ['--type-kbd', '0.6875rem'],
];

const MOTION_ROLES: ReadonlyArray<[string, string]> = [
  ['--motion-press', '80ms'],
  ['--motion-flash', '150ms'],
  ['--motion-notice-in', '150ms'],
  ['--motion-dialog-in', '220ms'],
  ['--motion-ease', 'cubic-bezier(0.2, 0.7, 0.25, 1)'],
];

describe('VN-S2 role aliases', () => {
  it.each(TYPE_ROLES)('%s resolves to the DESIGN.md value %s', (role, value) => {
    expect(resolveToken(role)).toBe(value);
  });

  it.each(MOTION_ROLES)('%s resolves to the DESIGN.md value %s', (role, value) => {
    expect(resolveToken(role)).toBe(value);
  });

  it('every role is an alias (a var() to a shipped token), never a new literal value', () => {
    for (const [role] of [...TYPE_ROLES, ...MOTION_ROLES]) {
      const value = frame.get(role);
      expect(value, role).toMatch(/^var\(--(font-size|duration|ease)-[a-z0-9-]+\)$/);
      expect(root.has(role), `${role} must not redefine a :root token`).toBe(false);
    }
  });

  it('reduced motion zeroes every motion duration role (DESIGN.md §Motion)', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.v5-frame\s*\{([^}]*)\}/.exec(foundation);
    expect(reduced, 'a reduced-motion block for .v5-frame').not.toBeNull();
    const body = reduced?.[1] ?? '';
    for (const [role, value] of MOTION_ROLES) {
      if (!value.endsWith('ms')) continue;
      expect(body, role).toMatch(new RegExp(`${role}:\\s*0ms`));
    }
  });
});
