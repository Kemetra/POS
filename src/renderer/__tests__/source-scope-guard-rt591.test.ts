import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_591_REPLACEMENT_BLOCKED_BRANCH,
  RT_591_REPLACEMENT_BLOCKED_EXEMPT_FILES,
  isRt591ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-591 — the source-scope guard exemption for the REPLACEMENT_BLOCKED branch
 * is NARROW (owner approval, 2026-10-18):
 *
 *   - exactly four files under `src/main/pairing/` (the failure mapping, the
 *     service outcome switch, and their two tests);
 *   - exactly one branch: `claude/rt-591-replacement-blocked-af1e3e` (exact
 *     name, not a prefix).
 *
 * It does not shrink the forbidden prefix list, so every other path stays
 * blocked on that branch and no other branch gains anything.
 */

const BRANCH = 'claude/rt-591-replacement-blocked-af1e3e';
const EXEMPT_FILES = [
  'src/main/pairing/failure-mapping.ts',
  'src/main/pairing/service.ts',
  'src/main/pairing/__tests__/failure-mapping.test.ts',
  'src/main/pairing/__tests__/service.test.ts',
];

describe('source-scope guard — RT-591 exemption is narrow', () => {
  it('exempts exactly four files on exactly one branch', () => {
    expect([...RT_591_REPLACEMENT_BLOCKED_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_591_REPLACEMENT_BLOCKED_BRANCH).toBe(BRANCH);
  });

  it('does not touch the forbidden prefix list', () => {
    expect([...FORBIDDEN_PATH_PREFIXES]).toEqual([
      'src/main/pairing/',
      'src/main/secrets/',
      'src/shared/api-types.ts',
      'scripts/codegen-api.ts',
      'scripts/openapi-snapshot.json',
      '.github/workflows/',
    ]);
  });

  it.each(EXEMPT_FILES)('allows %s on the RT-591 branch', (file) => {
    expect(isRt591ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/network.ts',
    'src/main/pairing/store.ts',
    'src/main/pairing/log.ts',
    'src/main/pairing/token-binding.ts',
    'src/main/pairing/__tests__/store.test.ts',
    'src/main/pairing/__tests__/failure-mapping.test.ts.bak',
    'src/main/pairing/__tests__/sub/service.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts',
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-591 branch', (file) => {
    expect(isRt591ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'bot/backend-core-repin',
    'claude/rt-591-',
    'claude/rt-591-replacement-blocked-af1e3e-x',
    'claude/rt-591-replacement-blocked-af1e3e/extra',
    'claude/rt-591-other',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt591ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt591ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /effectiveForbidden\.some\(\(prefix\) => file === prefix \|\| file\.startsWith\(prefix\)\) &&\s*!isRt676ExemptFile\(currentBranch, file\) &&\s*!isRt591ExemptFile\(currentBranch, file\)/,
    );
  });
});
