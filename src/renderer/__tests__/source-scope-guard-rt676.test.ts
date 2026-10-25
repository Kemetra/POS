import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_676_REPIN_BRANCH,
  RT_676_REPIN_EXEMPT_FILES,
  isRt676ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-676 / RT-591 — the source-scope guard exemption for the contracts-repin
 * bot branch is NARROW (owner decision, option A, 2026-10-18):
 *
 *   - exactly two files: `src/main/pairing/__tests__/failure-mapping.test.ts`
 *     and, since RT-869, the generated `src/shared/api-types.ts`;
 *   - exactly one branch: `bot/backend-core-repin` (exact name, not a prefix).
 *
 * It does not shrink the forbidden prefix list, so every other path stays
 * blocked on that branch and no other branch gains anything.
 */

const EXEMPT_FILE = 'src/main/pairing/__tests__/failure-mapping.test.ts';
const API_TYPES = 'src/shared/api-types.ts';

describe('source-scope guard — RT-676 exemption is narrow', () => {
  it('exempts exactly two files on exactly one branch', () => {
    expect([...RT_676_REPIN_EXEMPT_FILES]).toEqual([EXEMPT_FILE, API_TYPES]);
    expect(RT_676_REPIN_BRANCH).toBe('bot/backend-core-repin');
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

  it.each([EXEMPT_FILE, API_TYPES])('allows %s on the bot branch', (file) => {
    expect(isRt676ExemptFile('bot/backend-core-repin', file)).toBe(true);
  });

  it.each([
    'src/main/pairing/failure-mapping.ts',
    'src/main/pairing/store.ts',
    'src/main/pairing/__tests__/service.test.ts',
    'src/main/pairing/__tests__/failure-mapping.test.ts.bak',
    'src/main/pairing/__tests__/sub/failure-mapping.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts.orig',
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the bot branch', (file) => {
    expect(isRt676ExemptFile('bot/backend-core-repin', file)).toBe(false);
  });

  it.each([
    'main',
    'ci/contracts',
    'bot/backend-core-repin-x',
    'bot/backend-core-repin/extra',
    'bot/backend-core',
    'claude/bot/backend-core-repin',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    expect(isRt676ExemptFile(branch, EXEMPT_FILE)).toBe(false);
    expect(isRt676ExemptFile(branch, API_TYPES)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt676ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /effectiveForbidden\.some\(\(prefix\) => file === prefix \|\| file\.startsWith\(prefix\)\) &&\s*!isRt676ExemptFile\(currentBranch, file\)/,
    );
  });
});
