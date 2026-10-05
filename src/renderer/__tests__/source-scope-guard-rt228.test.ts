import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX,
  RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES,
} from './source-scope-guard.const';

/**
 * RT-228 — the source-scope guard exemption for the pairing error-envelope fix is
 * NARROW (owner approval: Jira RT-228 2026-10-05):
 *
 *   - only branches named `claude/rt-228-*`;
 *   - only `src/main/pairing/`.
 *
 * Every other forbidden prefix stays blocked on those branches, and no other
 * branch gains anything.
 */

/** Same predicate the guard applies: the branch starts with the prefix. */
function exempted(branch: string): boolean {
  return branch.startsWith(RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX);
}

describe('source-scope guard — RT-228 exemption is narrow', () => {
  it('exempts exactly src/main/pairing/ and nothing else', () => {
    expect([...RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES]).toEqual(['src/main/pairing/']);
  });

  it('leaves every other forbidden prefix blocked on a claude/rt-228- branch', () => {
    const stillForbidden = FORBIDDEN_PATH_PREFIXES.filter(
      (p) => !(RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES as readonly string[]).includes(p),
    );
    expect(stillForbidden).toEqual([
      'src/main/secrets/',
      'src/shared/api-types.ts',
      'scripts/codegen-api.ts',
      'scripts/openapi-snapshot.json',
      '.github/workflows/',
    ]);
  });

  it('is keyed to the claude/rt-228- prefix only', () => {
    expect(RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX).toBe('claude/rt-228-');
  });

  it.each(['claude/rt-228-pairing-error-envelope', 'claude/rt-228-fix-review'])(
    'applies to %s',
    (branch) => {
      expect(exempted(branch)).toBe(true);
    },
  );

  it.each([
    'main',
    'claude/rt-113-p12-offline-grants',
    'claude/rt-2280-other',
    'claude/rt-21-other',
    'claude/rt-228',
    'feature/claude/rt-228-pairing-error-envelope',
    'fix/rt-228-pairing-error-envelope',
    '',
  ])('does not apply to %j', (branch) => {
    expect(exempted(branch)).toBe(false);
  });

  it('the guard selects the RT-228 list only behind the claude/rt-228- prefix check', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    // The exempt list is referenced exactly once, as the branch of a ternary
    // whose condition is EXACTLY `currentBranch.startsWith(<the RT-228 prefix>)`
    // (nothing OR-ed or negated in front of it).
    expect(guard.match(/RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES/g)).toHaveLength(2); // import + use
    expect(guard.match(/RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /:\s*currentBranch\.startsWith\(RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX\)\s*\?\s*FORBIDDEN_PATH_PREFIXES\.filter\(\s*\(p\)\s*=>\s*!\(\s*RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES as readonly string\[\]\s*\)\.includes\(p\),?\s*\)/,
    );
  });
});
