import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_215_DEVICE_REVOKED_BRANCH_PREFIX,
  RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES,
} from './source-scope-guard.const';

/**
 * RT-215 — the source-scope guard exemption for the device-revoked work is
 * NARROW (owner approval: Jira RT-215 comment 10875, decision (4)):
 *
 *   - only branches named `claude/rt-215-*`;
 *   - only `src/main/pairing/`.
 *
 * Every other forbidden prefix stays blocked on those branches, and no other
 * branch gains anything.
 */

/** Same predicate the guard applies: the branch starts with the prefix. */
function exempted(branch: string): boolean {
  return branch.startsWith(RT_215_DEVICE_REVOKED_BRANCH_PREFIX);
}

describe('source-scope guard — RT-215 exemption is narrow', () => {
  it('exempts exactly src/main/pairing/ and nothing else', () => {
    expect([...RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES]).toEqual(['src/main/pairing/']);
  });

  it('leaves every other forbidden prefix blocked on a claude/rt-215- branch', () => {
    const stillForbidden = FORBIDDEN_PATH_PREFIXES.filter(
      (p) => !(RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES as readonly string[]).includes(p),
    );
    expect(stillForbidden).toEqual([
      'src/main/secrets/',
      'src/shared/api-types.ts',
      'scripts/codegen-api.ts',
      'scripts/openapi-snapshot.json',
      '.github/workflows/',
    ]);
  });

  it('is keyed to the claude/rt-215- prefix only', () => {
    expect(RT_215_DEVICE_REVOKED_BRANCH_PREFIX).toBe('claude/rt-215-');
  });

  it.each(['claude/rt-215-device-revoked', 'claude/rt-215-fix-review'])(
    'applies to %s',
    (branch) => {
      expect(exempted(branch)).toBe(true);
    },
  );

  it.each([
    'main',
    'claude/rt-113-p12-offline-grants',
    'claude/rt-2150-other',
    'claude/rt-21-other',
    'claude/rt-215',
    'feature/claude/rt-215-device-revoked',
    'fix/rt-215-device-revoked',
    '',
  ])('does not apply to %j', (branch) => {
    expect(exempted(branch)).toBe(false);
  });

  it('the guard selects the RT-215 list only behind the claude/rt-215- prefix check', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    // The exempt list is referenced exactly once, as the branch of a ternary
    // whose condition is EXACTLY `currentBranch.startsWith(<the RT-215 prefix>)`
    // (nothing OR-ed or negated in front of it).
    expect(guard.match(/RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES/g)).toHaveLength(2); // import + use
    expect(guard.match(/RT_215_DEVICE_REVOKED_BRANCH_PREFIX/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /:\s*currentBranch\.startsWith\(RT_215_DEVICE_REVOKED_BRANCH_PREFIX\)\s*\?\s*FORBIDDEN_PATH_PREFIXES\.filter\(\s*\(p\)\s*=>\s*!\(RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES as readonly string\[\]\)\.includes\(p\),?\s*\)/,
    );
  });
});
