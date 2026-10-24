/**
 * RT-719 — writes `dist/build-identity.json`, the build's own identity, so the
 * running POS can report it to Backend-Core (`X-POS-Build-Commit`,
 * `X-POS-Contract-Pin`; `src/main/observability/build-identity.ts`).
 *
 *   tsx scripts/stamp-build-identity.ts           write the stamp (build:main)
 *   tsx scripts/stamp-build-identity.ts --check   before package:dir: drop a stale stamp, never add one
 *
 * Run at the end of `npm run build:main`, so the packaged exe (`dist/**` is in the asar)
 * and `electron .` after `npm run build` carry the same file. `dist/` is git-ignored:
 * the stamp is never committed. `npm run dev` does NOT stamp: its renderer is served by
 * Vite with live reload, so no startup stamp could stay true, and the dev POS reports
 * unknown (scripts/dev-electron.cjs removes a stale stamp).
 *
 * Honesty rule: the stamp is written only when it is true. A tracked file that
 * differs from HEAD, an untracked file under src/, migrations/ or contracts/, or no
 * readable git HEAD, writes no file and removes a stale one, so the POS reports
 * "unknown" instead of a commit it is not built from. Consequences: a lab build with
 * local edits reports unknown, and a build from a CI pull-request checkout stamps the
 * synthetic merge commit, which no branch holds; fleet baselines come from builds of a
 * real branch commit.
 * The pin comes from `contracts/backend-core/PIN` (its `commit:` line); without a
 * valid one the stamp carries the commit alone. Nothing is defaulted or guessed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_FILE = path.join(ROOT, 'dist', 'build-identity.json');
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

const isCommit = (value: string | null): value is string =>
  value !== null && GIT_COMMIT.test(value);

/** The `commit:` line of the PIN file, or null when the file is missing or has none. */
function pinCommit(pinText: string | null): string | null {
  return pinText === null ? null : (PIN_COMMIT_LINE.exec(pinText)?.[1] ?? null);
}

/** The stamp these facts support, or null when none is honest. */
export function buildIdentityStamp(inputs: StampInputs): BuildIdentityStamp | null {
  const head = inputs.head;
  if (inputs.dirty || !isCommit(head)) return null;
  const pin = pinCommit(inputs.pinText);
  return pin === null ? { commit: head } : { commit: head, contractPin: pin };
}

/**
 * Whether an existing stamp (written by the build that produced `dist/`) still names
 * the tree being packaged: same commit, clean tree. `package:dir` packages the
 * existing `dist/`, so it never makes a new claim; it only drops a stamp that has
 * gone stale (HEAD moved, or the tree changed since the build).
 */
export function stampStillTrue(
  existing: BuildIdentityStamp | null,
  facts: { readonly head: string | null; readonly dirty: boolean },
): boolean {
  return existing !== null && !facts.dirty && facts.head === existing.commit;
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

function run(cmd: string, args: readonly string[]): string | null {
  try {
    return execFileSync(cmd, [...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const git = (args: readonly string[]): string | null => run('git', args);

/** Git output that lists any change; unreadable output (null) counts as a change, so no stamp. */
const hasChanges = (output: string | null): boolean => output === null || output.trim() !== '';

function readPin(): string | null {
  try {
    return readFileSync(path.join(ROOT, 'contracts', 'backend-core', 'PIN'), 'utf8');
  } catch {
    return null;
  }
}

interface TreeFacts {
  readonly head: string | null;
  readonly dirty: boolean;
}

function treeFacts(): TreeFacts {
  const head = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  // `--untracked-files=no`: dist/ and other ignored output never make a build "dirty";
  // an unreadable status is treated as dirty (no stamp).
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  // A new source file compiled into dist/ is untracked, so look for those in the built trees.
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'src',
    'migrations',
    'contracts',
  ]);
  return { head, dirty: hasChanges(status) || hasChanges(untracked) };
}

function readStamp(): BuildIdentityStamp | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(STAMP_FILE, 'utf8'));
    const commit = (raw as { commit?: unknown } | null)?.commit;
    return typeof commit === 'string' ? { commit } : null;
  } catch {
    return null;
  }
}

/** `--check`: before packaging, keep the build's stamp only if it still names this tree. */
function check(): number {
  const kept = stampStillTrue(readStamp(), treeFacts());
  if (!kept) writeBuildIdentityStamp(STAMP_FILE, null);
  console.log(
    kept
      ? '[stamp-build-identity] stamp matches this tree: kept'
      : '[stamp-build-identity] no stamp, or it no longer names this tree: none will be packaged',
  );
  return 0;
}

function main(): number {
  if (process.argv.includes('--check')) return check();
  const stamp = buildIdentityStamp({ ...treeFacts(), pinText: readPin() });
  writeBuildIdentityStamp(STAMP_FILE, stamp);
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
