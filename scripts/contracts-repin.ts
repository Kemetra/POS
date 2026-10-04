/**
 * RT-217 — refresh the vendored Backend-Core OpenAPI snapshot.
 *
 *   npm run contracts:repin                       # re-pin every pinned file at BC `main`
 *   npm run contracts:repin -- --ref <sha|branch|tag>
 *   npm run contracts:repin -- --add pos-cashier-admissions.openapi.yaml
 *   npm run contracts:repin -- --remove pos-payments/vouchers.yaml
 *
 * Paths are relative to Backend-Core `packages/contracts/openapi/`. The ref is
 * resolved to a full commit SHA first and every file is fetched AT THAT SHA, so a
 * snapshot always comes from exactly one commit. Each downloaded file's git blob
 * SHA must equal the one GitHub reports for it, or nothing is written.
 *
 * Developer tooling only: it uses the local, already-authenticated `gh` CLI and
 * never runs in CI. CI reads only the committed snapshot (no network, no secret).
 * After a re-pin, run `npx vitest run tests/contract/backend-core` and commit
 * `contracts/backend-core/` together with any registry change.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_CORE_OPENAPI_ROOT,
  BACKEND_CORE_REPO,
  assertSafeRelativePath,
  formatPin,
  gitBlobSha,
  parsePin,
  type PinnedFile,
} from './contracts-pin.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'contracts', 'backend-core');
const OPENAPI_DIR = path.join(SNAPSHOT_DIR, 'openapi');
const PIN_PATH = path.join(SNAPSHOT_DIR, 'PIN');

interface Args {
  ref: string;
  add: string[];
  remove: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { ref: 'main', add: [], remove: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--ref' && flag !== '--add' && flag !== '--remove') {
      throw new Error(`unknown argument "${String(flag)}"`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--ref') args.ref = value;
    else if (flag === '--add') args.add.push(value);
    else args.remove.push(value);
    i += 1;
  }
  return args;
}

function gh(args: readonly string[], raw = false): Buffer {
  return execFileSync(
    'gh',
    ['api', ...(raw ? ['-H', 'Accept: application/vnd.github.raw'] : []), ...args],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

function resolveCommit(ref: string): string {
  const sha = gh([`repos/${BACKEND_CORE_REPO}/commits/${encodeURIComponent(ref)}`, '--jq', '.sha'])
    .toString('utf-8')
    .trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ref "${ref}" (got "${sha}")`);
  return sha;
}

function fetchPinned(commit: string, rel: string): { file: PinnedFile; bytes: Buffer } {
  const apiPath = `repos/${BACKEND_CORE_REPO}/contents/${BACKEND_CORE_OPENAPI_ROOT}/${rel}?ref=${commit}`;
  const meta = JSON.parse(gh([apiPath]).toString('utf-8')) as { type?: string; sha?: string };
  if (meta.type !== 'file' || typeof meta.sha !== 'string') {
    throw new Error(`${rel} is not a file at ${commit}`);
  }
  const bytes = gh([apiPath], true);
  const blobSha = gitBlobSha(bytes);
  if (blobSha !== meta.sha) {
    throw new Error(`${rel}: downloaded blob ${blobSha} != GitHub blob ${meta.sha}; aborting`);
  }
  return { file: { path: rel, blobSha }, bytes };
}

function listVendored(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listVendored(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const current = existsSync(PIN_PATH)
    ? parsePin(readFileSync(PIN_PATH, 'utf-8')).files.map((f) => f.path)
    : [];
  const wanted = [...new Set([...current, ...args.add])].filter((p) => !args.remove.includes(p));
  wanted.forEach(assertSafeRelativePath);
  if (wanted.length === 0) throw new Error('nothing to pin: pass --add <path>');

  const commit = resolveCommit(args.ref);
  // Download everything before touching the snapshot, so a failure leaves it intact.
  const fetched = wanted.map((rel) => fetchPinned(commit, rel));

  const stale = listVendored(OPENAPI_DIR).filter((p) => !wanted.includes(p));
  rmSync(OPENAPI_DIR, { recursive: true, force: true });
  for (const { file, bytes } of fetched) {
    const target = path.join(OPENAPI_DIR, ...file.path.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(
    PIN_PATH,
    formatPin({
      repo: BACKEND_CORE_REPO,
      commit,
      source: BACKEND_CORE_OPENAPI_ROOT,
      files: fetched.map((f) => f.file),
    }),
  );
  process.stdout.write(
    `Pinned ${String(fetched.length)} Backend-Core contract(s) at ${commit}:\n` +
      fetched.map((f) => `  ${f.file.path} ${f.file.blobSha}\n`).join('') +
      stale.map((p) => `  removed ${p}\n`).join(''),
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `contracts:repin failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
