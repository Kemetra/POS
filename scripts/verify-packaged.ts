/**
 * RT-830 (RT-748 slice I-7) — post-package checks for the Windows `--dir` build.
 *
 *   tsx scripts/verify-packaged.ts fuses    fuse wire of the packaged exe vs electron-builder.yml
 *   tsx scripts/verify-packaged.ts native   the shipped native modules load under the shipped Electron
 *
 * fuses — every `electronFuses` key in electron-builder.yml must be flipped to its declared value
 * in `POS Pulse.exe`; every fuse the config does not declare must keep the value of the stock
 * Electron binary in node_modules/electron (electron-builder only flips what is declared). A fuse
 * index unknown to @electron/fuses (a newer Electron) is compared against the stock binary too.
 *
 * native — decision NV-6a (owner, 2026-10-23): the hardened exe has `runAsNode` off and refuses
 * debug switches (src/main/app/launch-switch-guard.ts), so no smoke switch is added to it. Instead
 * the unpackaged Electron from node_modules/electron runs in node mode (ELECTRON_RUN_AS_NODE=1) and
 * requires better-sqlite3 and argon2 out of the packaged `resources/app.asar`, which Electron
 * resolves to `app.asar.unpacked`. That proves the binaries that ship load under the Electron ABI
 * that ships, as long as the packaged Electron is the node_modules one — checked by comparing the
 * runtime files electron-builder copies verbatim.
 *
 * Read-only: nothing here writes to the build output.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const APP_DIR = path.join(REPO_ROOT, 'dist-electron', 'win-unpacked');
const PACKAGED_EXE = path.join(APP_DIR, 'POS Pulse.exe');
const STOCK_EXE = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const BUILDER_CONFIG = path.join(REPO_ROOT, 'electron-builder.yml');

/** Runtime files electron-builder copies unchanged from the Electron distribution. */
export const ELECTRON_RUNTIME_FILES = [
  'icudtl.dat',
  'v8_context_snapshot.bin',
  'snapshot_blob.bin',
  'ffmpeg.dll',
];

/** The native modules the main process loads; each must ship at least one `.node` file unpacked. */
export const NATIVE_MODULES = ['better-sqlite3', 'argon2'];

const ENABLE = 49;
const DISABLE = 48;

/** `RunAsNode` -> `runAsNode`: electron-builder's config key for a FuseV1Options name. */
export function configKey(fuseName: string): string {
  return fuseName.charAt(0).toLowerCase() + fuseName.slice(1);
}

/**
 * Reads the `electronFuses:` block of electron-builder.yml: `key: true|false` lines indented under
 * it, comments ignored, ending at the next top-level key. Anything else inside the block is an
 * error, so a config change this parser does not understand fails closed instead of being skipped.
 */
export function parseElectronFuses(yamlText: string): Record<string, boolean> {
  const fuses: Record<string, boolean> = {};
  for (const raw of fuseBlockLines(yamlText.split(/\r?\n/))) {
    const entry = parseFuseLine(raw);
    if (entry === null) continue;
    const [key, value] = entry;
    if (key in fuses) throw new Error(`duplicate electronFuses key: ${key}`);
    fuses[key] = value;
  }
  if (Object.keys(fuses).length === 0) throw new Error('electronFuses block declares no fuses');
  return fuses;
}

/** The indented lines under the top-level `electronFuses:` key, up to the next top-level key. */
function fuseBlockLines(lines: readonly string[]): string[] {
  const start = lines.findIndex((l) => (l.split('#', 1)[0] ?? '').trimEnd() === 'electronFuses:');
  if (start < 0) throw new Error('electron-builder.yml has no top-level electronFuses block');
  const rest = lines.slice(start + 1);
  // A comment at column 0 does not end a YAML mapping; only a non-comment top-level line does.
  const end = rest.findIndex((l) => /^[^\s#]/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** `key: true|false` -> [key, value]; a blank or comment-only line -> null; anything else throws. */
function parseFuseLine(raw: string): [string, boolean] | null {
  const line = (raw.split('#', 1)[0] ?? '').trim();
  if (line === '') return null;
  const m = /^([A-Za-z]\w*):\s*(true|false)$/.exec(line);
  const key = m?.[1];
  if (!m || key === undefined) throw new Error(`unparseable electronFuses line: ${raw.trim()}`);
  return [key, m[2] === 'true'];
}

export interface FuseRow {
  index: number;
  name: string;
  source: 'declared' | 'stock default';
  expected: number | undefined;
  actual: number | undefined;
  ok: boolean;
}

type Wire = Record<string, unknown>;

/** The three inputs of a fuse comparison. */
export interface FuseInputs {
  declared: Record<string, boolean>;
  packaged: Wire;
  stock: Wire;
}

/** Compares the packaged wire with the declared config and, for undeclared fuses, the stock wire. */
export function compareFuses(inputs: FuseInputs): { rows: FuseRow[]; problems: string[] } {
  const rows = wireIndexes(inputs).map((index) => fuseRow(index, inputs));
  const problems = rows.map(rowProblem).filter((p): p is string => p !== null);
  const known = new Set(rows.map((r) => r.name));
  for (const key of Object.keys(inputs.declared).filter((k) => !known.has(k))) {
    problems.push(`${key}: declared in electron-builder.yml but not in the packaged fuse wire`);
  }
  return { rows, problems };
}

/** Numeric fuse indexes present in either wire, ascending (the `version` key is skipped). */
function wireIndexes({ packaged, stock }: FuseInputs): number[] {
  return [...new Set([...Object.keys(packaged), ...Object.keys(stock)])]
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
}

/** electron-builder key for a wire index; indexes @electron/fuses does not name become `fuse#N`. */
function fuseKeyAt(index: number): string {
  const fuseName = (FuseV1Options as unknown as Record<number, string | undefined>)[index];
  return fuseName ? configKey(fuseName) : `fuse#${String(index)}`;
}

function fuseRow(index: number, { declared, packaged, stock }: FuseInputs): FuseRow {
  const name = fuseKeyAt(index);
  const declaredValue = declared[name];
  const source = declaredValue === undefined ? 'stock default' : 'declared';
  const expected =
    declaredValue === undefined
      ? (stock[index] as number | undefined)
      : STATE[String(declaredValue)];
  const actual = packaged[index] as number | undefined;
  return {
    index,
    name,
    source,
    expected,
    actual,
    ok: expected !== undefined && actual === expected,
  };
}

const STATE: Record<string, number> = { true: ENABLE, false: DISABLE };

function rowProblem(r: FuseRow): string | null {
  if (r.actual === undefined) return `${r.name}: missing from the packaged fuse wire`;
  if (r.expected === undefined) return `${r.name}: not in the stock Electron wire and not declared`;
  if (r.ok) return null;
  const why =
    r.source === 'declared' ? 'declared in electron-builder.yml' : 'stock Electron default';
  return `${r.name}: packaged ${stateName(r.actual)}, expected ${stateName(r.expected)} (${why})`;
}

function stateName(v: number | undefined): string {
  if (v === ENABLE) return 'enabled';
  if (v === DISABLE) return 'disabled';
  if (v === undefined) return 'absent';
  return `state ${String(v)}`;
}

/** Files that differ between the packaged runtime and the node_modules Electron distribution. */
export function runtimeMismatches({
  appDir,
  electronDistDir,
  files = ELECTRON_RUNTIME_FILES,
}: {
  appDir: string;
  electronDistDir: string;
  files?: string[];
}): string[] {
  return files.filter((f) => {
    const [a, b] = [path.join(appDir, f), path.join(electronDistDir, f)];
    if (!existsSync(a) || !existsSync(b)) return true;
    const [ha, hb] = [a, b].map((p) => createHash('sha256').update(readFileSync(p)).digest('hex'));
    return ha !== hb;
  });
}

/** Node-mode script run by the stock Electron: loads each module out of the packaged app.asar. */
export const NATIVE_SMOKE_SCRIPT = `
const path = require('node:path');
const asar = process.argv[process.argv.length - 1];
(async () => {
  const Database = require(path.join(asar, 'node_modules', 'better-sqlite3'));
  const db = new Database(':memory:');
  const one = db.prepare('select 1 as x').get().x;
  db.close();
  const argon2 = require(path.join(asar, 'node_modules', 'argon2'));
  const hash = await argon2.hash('rt-830-native-smoke');
  const verified = await argon2.verify(hash, 'rt-830-native-smoke');
  const loaded = Object.keys(require.cache).filter((k) => k.endsWith('.node'));
  console.log(JSON.stringify({ sqlite: one, argon2: verified, electron: process.versions.electron, abi: process.versions.modules, loaded }));
  if (one !== 1 || verified !== true) process.exit(1);
})().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
`;

async function checkFuses(): Promise<number> {
  const declared = parseElectronFuses(readFileSync(BUILDER_CONFIG, 'utf8'));
  const packaged = (await getCurrentFuseWire(PACKAGED_EXE)) as unknown as Wire;
  const stock = (await getCurrentFuseWire(STOCK_EXE)) as unknown as Wire;
  const { rows, problems } = compareFuses({ declared, packaged, stock });
  for (const r of rows) {
    console.log(
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(40)} ${stateName(r.actual).padEnd(9)} (${r.source})`,
    );
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error title=Fuse readback::${p}`);
    return 1;
  }
  console.log(
    `fuse readback: ${String(rows.length)} fuses match electron-builder.yml and the stock defaults`,
  );
  return 0;
}

function checkNative(): number {
  const unpacked = path.join(APP_DIR, 'resources', 'app.asar.unpacked', 'node_modules');
  const missing = NATIVE_MODULES.filter((m) => {
    const dir = path.join(unpacked, m, 'build', 'Release');
    return !existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('.node'));
  });
  if (missing.length > 0) {
    console.error(
      `::error title=Native smoke::not unpacked from app.asar (build/Release/*.node): ${missing.join(', ')}`,
    );
    return 1;
  }
  const drift = runtimeMismatches({ appDir: APP_DIR, electronDistDir: path.dirname(STOCK_EXE) });
  if (drift.length > 0) {
    console.error(
      `::error title=Native smoke::packaged Electron differs from node_modules/electron: ${drift.join(', ')}`,
    );
    return 1;
  }
  const asar = path.join(APP_DIR, 'resources', 'app.asar');
  const res = spawnSync(STOCK_EXE, ['-e', NATIVE_SMOKE_SCRIPT, asar], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    // spawnSync sets res.error (status and signal null) when the process cannot start at all.
    const reason = res.error ? res.error.message : `exit ${String(res.status ?? res.signal)}`;
    console.error(
      `::error title=Native smoke::loading the packaged native modules failed (${reason})`,
    );
    return 1;
  }
  console.log(
    'native smoke: better-sqlite3 and argon2 load from the packaged app under the shipped Electron',
  );
  return 0;
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode === 'fuses') return checkFuses();
  if (mode === 'native') return checkNative();
  console.error('usage: tsx scripts/verify-packaged.ts fuses|native');
  return 2;
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  try {
    process.exit(await main());
  } catch (err: unknown) {
    console.error('[verify-packaged] failed:', err);
    process.exit(1);
  }
}
