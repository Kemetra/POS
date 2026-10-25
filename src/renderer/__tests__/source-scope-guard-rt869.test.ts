import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_869_MONOREPO_READINESS_BRANCH,
  RT_869_MONOREPO_READINESS_EXEMPT_FILES,
  isRt869ExemptFile,
} from './source-scope-guard.const';
import { gitChangedFiles } from './source-scope-guard.git';

/**
 * RT-869 — the source-scope guard works when POS sits in a subdirectory of a
 * parent repo (the monorepo's `apps/pos/`), and the RT-869 exemption is narrow.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'chore/rt-869-monorepo-readiness';
const EXEMPT_FILES = [
  'scripts/codegen-api.ts',
  'scripts/openapi-snapshot.json',
  'src/main/pairing/network.ts',
  'src/shared/api-types.ts',
];

const isForbidden = (file: string): boolean =>
  FORBIDDEN_PATH_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix));

describe('source-scope guard — POS inside a parent repo (RT-869)', () => {
  let parent: string;
  let pos: string;

  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: parent, stdio: 'pipe' });
  };
  const write = (rel: string, text: string): void => {
    const file = path.join(parent, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  beforeAll(() => {
    parent = mkdtempSync(path.join(os.tmpdir(), 'pos-scope-guard-'));
    pos = path.join(parent, 'apps', 'pos');
    git('init -q -b main');
    git('config user.email guard@test.invalid');
    git('config user.name guard');
    git('config commit.gpgsign false');
    write('.github/workflows/ci.yml', 'on: push\n');
    write('apps/pos/src/main/pairing/network.ts', 'export {};\n');
    write('apps/pos/src/renderer/app.ts', 'export {};\n');
    git('add .');
    git('commit -q -m base');
    git('checkout -q -b feature');
    write('.github/workflows/ci.yml', 'on: pull_request\n');
    write('apps/pos/src/main/pairing/network.ts', 'export const changed = 1;\n');
    write('apps/pos/src/renderer/app.ts', 'export const changed = 1;\n');
    git('commit -q -am change');
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('lists the changed files relative to the POS directory, not the parent root', () => {
    expect(gitChangedFiles('main...HEAD', pos)).toEqual([
      'src/main/pairing/network.ts',
      'src/renderer/app.ts',
    ]);
  });

  it('detects a forbidden POS path when the repo sits in a subdirectory', () => {
    expect(gitChangedFiles('main...HEAD', pos).filter(isForbidden)).toEqual([
      'src/main/pairing/network.ts',
    ]);
  });

  it('ignores a parent .github/workflows/ change', () => {
    const changed = gitChangedFiles('main...HEAD', pos);
    expect(changed.some((file) => file.includes('.github/'))).toBe(false);
    // The repo-root view does contain it: that is the bug --relative fixes.
    expect(gitChangedFiles('main...HEAD', parent)).toContain('.github/workflows/ci.yml');
  });

  it('the guard lists its changed files through the repo-relative helper', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard).toMatch(/gitChangedFiles\(tripleDoc \? 'origin\/main\.\.\.HEAD'/);
    expect(guard).not.toMatch(/git diff --name-only origin/);
  });
});

describe('source-scope guard — RT-869 exemption is narrow', () => {
  it('exempts exactly four files on exactly one branch', () => {
    expect([...RT_869_MONOREPO_READINESS_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_869_MONOREPO_READINESS_BRANCH).toBe(BRANCH);
  });

  it.each(EXEMPT_FILES)('allows %s on the RT-869 branch', (file) => {
    expect(isRt869ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/service.ts',
    'src/main/pairing/network.ts.bak',
    'src/shared/api-types.ts.orig',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-869 branch', (file) => {
    expect(isRt869ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'chore/rt-869-monorepo-readiness-x',
    'chore/rt-869-monorepo-readiness/extra',
    'chore/rt-869',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt869ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt869ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt307ExemptFile\(currentBranch, file\) &&\s*!isRt869ExemptFile\(currentBranch, file\)/,
    );
  });
});
