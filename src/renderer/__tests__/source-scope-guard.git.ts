import { execSync } from 'node:child_process';

/**
 * RT-869 — the files a git range changed, as paths relative to `cwd`.
 *
 * `--relative` makes git print paths relative to the working directory and
 * drop changes outside it. When POS sits in a subdirectory of a parent repo
 * (the monorepo puts it at `apps/pos/`), a plain `git diff --name-only` prints
 * repo-root paths: the forbidden prefixes would never match POS files, and a
 * parent `.github/workflows/` change would. Run from the POS root, both cases
 * print the same POS-relative paths.
 */
export function gitChangedFiles(range: string, cwd?: string): string[] {
  return execSync(`git diff --name-only --relative ${range}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
