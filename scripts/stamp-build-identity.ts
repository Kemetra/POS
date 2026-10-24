/**
 * RT-719 — writes `dist/build-identity.json`, the build's own identity, so the
 * running POS can report it to Backend-Core (`X-POS-Build-Commit`,
 * `X-POS-Contract-Pin`; `src/main/observability/build-identity.ts`).
 *
 *   tsx scripts/stamp-build-identity.ts
 *
 * Run at the end of `npm run build:main` and by `npm run dev` (the unpackaged
 * lab build), so the packaged exe (`dist/**` is in the asar) and `electron .`
 * carry the same file. `dist/` is git-ignored: the stamp is never committed.
 *
 * Honesty rule: the stamp is written only when it is true. A tracked file that
 * differs from HEAD, or no readable git HEAD, writes no file and removes a stale
 * one, so the POS reports "unknown" instead of a commit it is not built from.
 * The pin comes from `contracts/backend-core/PIN` (its `commit:` line); without a
 * valid one the stamp carries the commit alone. Nothing is defaulted or guessed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_COMMIT = /^[0-9a-f]{40}$/;
const PIN_COMMIT_LINE = /^commit:[ \t]+([0-9a-f]{40})[ \t]*$/m;

export interface BuildIdentityStamp {
  readonly commit: string;
  readonly contractPin?: string;
}

export interface StampInputs {
  /** `git rev-parse HEAD`, or null when git could not say. */
  readonly head: string | null;
  /** Whether a tracked file differs from HEAD. */
  readonly dirty: boolean;
  /** The text of `contracts/backend-core/PIN`, or null when unreadable. */
  readonly pinText: string | null;
}

/** The stamp these facts support, or null when none is honest. */
export function buildIdentityStamp(inputs: StampInputs): BuildIdentityStamp | null {
  if (inputs.dirty || inputs.head === null || !GIT_COMMIT.test(inputs.head)) return null;
  const pin = inputs.pinText === null ? null : PIN_COMMIT_LINE.exec(inputs.pinText)?.[1];
  return pin === undefined || pin === null
    ? { commit: inputs.head }
    : { commit: inputs.head, contractPin: pin };
}

/** Writes the stamp, or removes a stale one when there is none (null). */
export function writeBuildIdentityStamp(file: string, stamp: BuildIdentityStamp | null): void {
  if (stamp === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stamp)}\n`);
}

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readPin(root: string): string | null {
  try {
    return readFileSync(path.join(root, 'contracts', 'backend-core', 'PIN'), 'utf8');
  } catch {
    return null;
  }
}

function main(): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const head = git(root, ['rev-parse', 'HEAD'])?.trim() ?? null;
  // `--untracked-files=no`: dist/ and other ignored output never make a build "dirty";
  // an unreadable status is treated as dirty (no stamp).
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const stamp = buildIdentityStamp({
    head,
    dirty: status === null || status.trim() !== '',
    pinText: readPin(root),
  });
  writeBuildIdentityStamp(path.join(root, 'dist', 'build-identity.json'), stamp);
  console.log(
    stamp === null
      ? '[stamp-build-identity] no honest build identity (dirty tree or no git): no stamp written'
      : `[stamp-build-identity] stamped ${stamp.commit.slice(0, 12)} (contract pin ${
          stamp.contractPin === undefined ? 'unknown' : stamp.contractPin.slice(0, 12)
        })`,
  );
  return 0;
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) process.exit(main());
