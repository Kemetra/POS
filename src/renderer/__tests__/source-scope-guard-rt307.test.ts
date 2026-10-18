import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_307_SNAPSHOT_REGEN_BRANCH,
  RT_307_SNAPSHOT_REGEN_EXEMPT_FILES,
  isRt307ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-307 — the source-scope guard exemption for the pairing snapshot regen
 * branch is NARROW (owner approval, 2026-10-18):
 *
 *   - exactly two files: the OpenAPI snapshot and the generated api-types;
 *   - exactly one branch: `claude/rt307-pairing-snapshot-regen` (exact name,
 *     not a prefix).
 *
 * It does not shrink the forbidden prefix list, so every other path stays
 * blocked on that branch and no other branch gains anything.
 */

const BRANCH = 'claude/rt307-pairing-snapshot-regen';
const EXEMPT_FILES = ['scripts/openapi-snapshot.json', 'src/shared/api-types.ts'];

describe('source-scope guard — RT-307 exemption is narrow', () => {
  it('exempts exactly two files on exactly one branch', () => {
    expect([...RT_307_SNAPSHOT_REGEN_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_307_SNAPSHOT_REGEN_BRANCH).toBe(BRANCH);
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

  it.each(EXEMPT_FILES)('allows %s on the RT-307 branch', (file) => {
    expect(isRt307ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json.bak',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/failure-mapping.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-307 branch', (file) => {
    expect(isRt307ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'bot/backend-core-repin',
    'claude/rt307-',
    'claude/rt307-pairing-snapshot-regen-x',
    'claude/rt307-pairing-snapshot-regen/extra',
    'claude/rt-307-pairing-snapshot-regen',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt307ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt307ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt591ExemptFile\(currentBranch, file\) &&\s*!isRt307ExemptFile\(currentBranch, file\),/,
    );
  });
});
