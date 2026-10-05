import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PATH_PREFIXES,
  CI_MAINTENANCE_BRANCH_PREFIX,
  CI_MAINTENANCE_EXEMPT_PREFIXES,
  PAIRING_DEV_FIXTURE_BRANCH_PREFIX,
  PAIRING_DEV_FIXTURE_EXEMPT_PREFIXES,
  FEAT_006_PAYMENTS_BRANCH_PREFIX,
  FEAT_006_PAYMENTS_EXEMPT_PREFIXES,
  FEAT_008_T094A_BRANCH_PREFIX,
  FEAT_008_T094A_EXEMPT_PREFIXES,
  FIX_POS_PAIRING_PATH_BRANCH_PREFIX,
  FIX_POS_PAIRING_PATH_EXEMPT_PREFIXES,
  FIX_380_F007_BRANCH_PREFIX,
  FIX_380_F007_EXEMPT_PREFIXES,
  FEAT_349_REPIN_BRANCH_PREFIX,
  FEAT_349_REPIN_EXEMPT_PREFIXES,
  RT_215_DEVICE_REVOKED_BRANCH_PREFIX,
  RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES,
} from './source-scope-guard.const';

/**
 * T006 — Static no-touch source-scope guard.
 *
 * Shells out to `git diff --name-only origin/main...HEAD` (triple-dot,
 * squash-merge-safe) and asserts the diff does not touch any path in the
 * forbidden allowlist (T005).  Covers additions, modifications, AND
 * deletions (git diff lists all three).
 *
 * Fallback: if `origin/main` is unreachable, the test skips with an
 * explicit warning AND records a CI failure signal so the PR-review
 * checklist in quickstart.md §6 becomes the manual gate.
 *
 * Originally 003-pos-ui-shell scope. The forbidden list has been
 * scoped down for 004-operator-session (see source-scope-guard.const.ts
 * — preload / IPC / bridge-api.ts are now allowed seam extensions).
 */
describe('source-scope guard (T006)', () => {
  it('diff must not touch forbidden paths', () => {
    let diffOutput: string;

    const runDiff = (tripleDoc: boolean): string =>
      execSync(
        tripleDoc
          ? 'git diff --name-only origin/main...HEAD'
          : 'git diff --name-only origin/main HEAD',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

    try {
      // Triple-dot: diff from the merge-base of origin/main and HEAD,
      // squash-merge-safe (works even when main has been squash-merged).
      diffOutput = runDiff(true);
    } catch {
      // CI shallow clones (fetch-depth=1) don't include origin/main.
      // Fetch just the tip so rev-parse and diff both work.
      let fetchErr = '';
      try {
        // Explicitly map to the remote-tracking ref so origin/main resolves.
        execSync('git fetch --depth=1 origin main:refs/remotes/origin/main', {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch (e) {
        fetchErr = e instanceof Error ? e.message : String(e);
      }

      try {
        // Triple-dot needs a merge-base, which may not exist after a
        // shallow fetch. Fall back to double-dot (tip-to-tip) which works
        // with any depth and is equivalent for a linear PR branch.
        diffOutput = runDiff(true);
      } catch {
        try {
          diffOutput = runDiff(false);
        } catch {
          const reachable = (() => {
            try {
              execSync('git rev-parse origin/main', { stdio: 'pipe' });
              return true;
            } catch {
              return false;
            }
          })();

          if (!reachable) {
            console.warn(
              '[source-scope-guard] SKIP: origin/main unreachable. ' +
                (fetchErr ? `fetch error: ${fetchErr}. ` : '') +
                'Manual gate required: run `git diff --name-only origin/main...HEAD` ' +
                'and verify zero intersection with the forbidden allowlist (T005).',
            );
            throw new Error(
              'source-scope guard: origin/main unreachable; manual check required per quickstart.md §6.',
            );
          }

          throw new Error('source-scope guard: git diff command failed; see stderr above.');
        }
      }
    }

    const changedFiles = diffOutput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Branch-specific exemptions narrow the forbidden list:
    //   - ci/ branches may modify .github/workflows/ (their sole purpose).
    //   - feat/002-dev-skip-pairing-fixture may modify src/main/pairing/
    //     (approved 002 terminal-pairing dev fixture slice only).
    // All other branches use the full forbidden list unchanged.
    //
    // Branch detection: GitHub Actions checks out a detached HEAD for PRs,
    // so `git rev-parse --abbrev-ref HEAD` returns "HEAD". Read the CI env
    // vars first (GITHUB_HEAD_REF for PRs, GITHUB_REF_NAME for pushes),
    // falling back to git for local runs.
    const currentBranch =
      process.env['GITHUB_HEAD_REF'] ||
      process.env['GITHUB_REF_NAME'] ||
      (() => {
        try {
          return execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch {
          return '';
        }
      })();

    const effectiveForbidden = currentBranch.startsWith(CI_MAINTENANCE_BRANCH_PREFIX)
      ? FORBIDDEN_PATH_PREFIXES.filter(
          (p) => !(CI_MAINTENANCE_EXEMPT_PREFIXES as readonly string[]).includes(p),
        )
      : currentBranch.startsWith(PAIRING_DEV_FIXTURE_BRANCH_PREFIX)
        ? FORBIDDEN_PATH_PREFIXES.filter(
            (p) => !(PAIRING_DEV_FIXTURE_EXEMPT_PREFIXES as readonly string[]).includes(p),
          )
        : currentBranch.startsWith(FEAT_006_PAYMENTS_BRANCH_PREFIX)
          ? FORBIDDEN_PATH_PREFIXES.filter(
              (p) => !(FEAT_006_PAYMENTS_EXEMPT_PREFIXES as readonly string[]).includes(p),
            )
          : currentBranch.startsWith(FEAT_008_T094A_BRANCH_PREFIX)
            ? FORBIDDEN_PATH_PREFIXES.filter(
                (p) => !(FEAT_008_T094A_EXEMPT_PREFIXES as readonly string[]).includes(p),
              )
            : currentBranch.startsWith(FIX_POS_PAIRING_PATH_BRANCH_PREFIX)
              ? FORBIDDEN_PATH_PREFIXES.filter(
                  (p) => !(FIX_POS_PAIRING_PATH_EXEMPT_PREFIXES as readonly string[]).includes(p),
                )
              : currentBranch.startsWith(FIX_380_F007_BRANCH_PREFIX)
                ? FORBIDDEN_PATH_PREFIXES.filter(
                    (p) => !(FIX_380_F007_EXEMPT_PREFIXES as readonly string[]).includes(p),
                  )
                : currentBranch.startsWith(FEAT_349_REPIN_BRANCH_PREFIX)
                  ? FORBIDDEN_PATH_PREFIXES.filter(
                      (p) => !(FEAT_349_REPIN_EXEMPT_PREFIXES as readonly string[]).includes(p),
                    )
                  : currentBranch.startsWith(RT_215_DEVICE_REVOKED_BRANCH_PREFIX)
                    ? FORBIDDEN_PATH_PREFIXES.filter(
                        (p) =>
                          !(RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES as readonly string[]).includes(p),
                      )
                    : FORBIDDEN_PATH_PREFIXES;

    const violations = changedFiles.filter((file) =>
      effectiveForbidden.some((prefix) => file === prefix || file.startsWith(prefix)),
    );

    expect(violations, `Forbidden paths modified by this branch: ${violations.join(', ')}`).toEqual(
      [],
    );
  });
});
