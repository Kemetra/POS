/**
 * T053 — drift verification for the generated API types.
 *
 * Regenerates types to a temp file and byte-compares against the
 * committed `src/shared/api-types.ts`. Three outcomes:
 *
 *   match    — committed file equals fresh codegen → exit 0.
 *   missing  — committed file does not exist → exit 1.
 *   drifted  — committed file differs from fresh codegen → exit 1.
 *
 * Used in CI (US8 will wire it into the workflow) and as a local
 * pre-commit safeguard. Pure tooling — no Electron, no DB, no network
 * (the snapshot is local; --source=live opt-in is only for codegen-api.ts
 * itself, not for verify).
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiTypes } from './codegen-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SNAPSHOT_PATH = path.join(REPO_ROOT, 'scripts', 'openapi-snapshot.json');
const DEFAULT_COMMITTED_PATH = path.join(REPO_ROOT, 'src', 'shared', 'api-types.ts');

export type VerifyStatus = 'match' | 'drifted' | 'missing';

export interface VerifyResult {
  status: VerifyStatus;
  exitCode: number;
  message: string;
}

export interface VerifyCodegenOptions {
  snapshotPath: string;
  committedPath: string;
}

const REGEN_HINT =
  '`api-types.ts` is out of date. Run `npm run codegen:api` and commit the result.';

const MISSING_HINT =
  '`api-types.ts` is not committed. Run `npm run codegen:api` to generate it, then commit.';

/**
 * Run verification. Always cleans up its temp file. Callers may exit
 * with `result.exitCode` or wrap further error handling.
 */
export async function verifyCodegen(options: VerifyCodegenOptions): Promise<VerifyResult> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pos-pulse-verify-'));
  try {
    if (!existsSync(options.committedPath)) {
      return {
        status: 'missing',
        exitCode: 1,
        message: MISSING_HINT,
      };
    }

    const tmpOut = path.join(tmpDir, 'api-types.ts');
    await generateApiTypes({
      source: 'local',
      snapshotPath: options.snapshotPath,
      outPath: tmpOut,
    });

    const fresh = readFileSync(tmpOut);
    const committed = readFileSync(options.committedPath);

    if (fresh.equals(committed)) {
      return {
        status: 'match',
        exitCode: 0,
        message: '`api-types.ts` is up to date.',
      };
    }

    // Drift: compute a small diff hint so the reviewer can see scope.
    const driftPreview = previewDrift(committed, fresh);
    return {
      status: 'drifted',
      exitCode: 1,
      message: `${REGEN_HINT}\n${driftPreview}`,
    };
  } finally {
    // On Windows a just-closed file handle (or an AV scanner) can still
    // hold the temp dir non-empty for a few ms, making `rmdir` throw
    // ENOTEMPTY/EBUSY. `force` only ignores ENOENT — it does NOT retry the
    // lock race — so add maxRetries/retryDelay, which Node backs off on
    // exactly those codes. Keeps the codegen drift check from flaking CI.
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err: unknown) {
      console.warn('[verify-codegen] temp cleanup failed:', err);
    }
  }
}

/**
 * Best-effort one-glance preview of where the drift starts. Not a full
 * unified diff — just enough for a human to know which lines moved.
 */
function previewDrift(committed: Buffer, fresh: Buffer): string {
  const committedText = committed.toString('utf8');
  const freshText = fresh.toString('utf8');

  const committedLines = committedText.split('\n');
  const freshLines = freshText.split('\n');

  const maxLen = Math.max(committedLines.length, freshLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (committedLines[i] !== freshLines[i]) {
      const committedLine = committedLines[i] ?? '<EOF>';
      const freshLine = freshLines[i] ?? '<EOF>';
      const lineNum = String(i + 1);
      return [
        `First diff at line ${lineNum}:`,
        `  committed: ${truncate(committedLine, 100)}`,
        `  fresh    : ${truncate(freshLine, 100)}`,
      ].join('\n');
    }
  }
  return '(diff is content-equal up to the last shared line — likely a length mismatch beyond preview)';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

async function main(): Promise<void> {
  const result = await verifyCodegen({
    snapshotPath: DEFAULT_SNAPSHOT_PATH,
    committedPath: DEFAULT_COMMITTED_PATH,
  });

  if (result.status === 'match') {
    console.log(`[verify-codegen] ${result.message}`);
  } else {
    console.error(`[verify-codegen] ${result.status.toUpperCase()}: ${result.message}`);
  }
  process.exit(result.exitCode);
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  try {
    await main();
  } catch (err: unknown) {
    console.error('[verify-codegen] failed:', err);
    process.exit(1);
  }
}
