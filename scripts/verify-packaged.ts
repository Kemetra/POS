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
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^electronFuses:\s*(#.*)?$/.test(l));
  if (start < 0) throw new Error('electron-builder.yml has no top-level electronFuses block');
  const fuses: Record<string, boolean> = {};
  for (const raw of lines.slice(start + 1)) {
    if (/^\S/.test(raw)) break;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(true|false)$/.exec(line);
    const key = m?.[1];
    if (!m || key === undefined) throw new Error(`unparseable electronFuses line: ${raw.trim()}`);
    if (key in fuses) throw new Error(`duplicate electronFuses key: ${key}`);
    fuses[key] = m[2] === 'true';
  }
  if (Object.keys(fuses).length === 0) throw new Error('electronFuses block declares no fuses');
  return fuses;
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

/** Compares the packaged wire with the declared config and, for undeclared fuses, the stock wire. */
export function compareFuses(
  declared: Record<string, boolean>,
  packaged: Wire,
  stock: Wire,
): { rows: FuseRow[]; problems: string[] } {
  const problems: string[] = [];
  const indexes = [...new Set([...Object.keys(packaged), ...Object.keys(stock)])]
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
  const known = new Set<string>();
  const rows = indexes.map((index): FuseRow => {
    const fuseName = (FuseV1Options as unknown as Record<number, string | undefined>)[index];
    const name = fuseName ? configKey(fuseName) : `fuse#${String(index)}`;
    known.add(name);
    const isDeclared = name in declared;
    const expected = isDeclared
      ? declared[name]
        ? ENABLE
        : DISABLE
      : (stock[index] as number | undefined);
    const actual = packaged[index] as number | undefined;
    const ok = expected !== undefined && actual === expected;
    if (actual === undefined) problems.push(`${name}: missing from the packaged fuse wire`);
    else if (expected === undefined)
      problems.push(`${name}: not in the stock Electron wire and not declared`);
    else if (!ok) {
      problems.push(
        `${name}: packaged ${stateName(actual)}, expected ${stateName(expected)} (${isDeclared ? 'declared in electron-builder.yml' : 'stock Electron default'})`,
      );
    }
    return { index, name, source: isDeclared ? 'declared' : 'stock default', expected, actual, ok };
  });
  for (const key of Object.keys(declared)) {
    if (!known.has(key))
      problems.push(`${key}: declared in electron-builder.yml but not in the packaged fuse wire`);
  }
  return { rows, problems };
}

function stateName(v: number | undefined): string {
  if (v === ENABLE) return 'enabled';
  if (v === DISABLE) return 'disabled';
  if (v === undefined) return 'absent';
  return `state ${String(v)}`;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Files that differ between the packaged runtime and the node_modules Electron distribution. */
export function runtimeMismatches(
  appDir: string,
  electronDistDir: string,
  files = ELECTRON_RUNTIME_FILES,
): string[] {
  return files.filter((f) => {
    const a = path.join(appDir, f);
    const b = path.join(electronDistDir, f);
    return !existsSync(a) || !existsSync(b) || sha256(a) !== sha256(b);
  });
}

/** Node-mode script run by the stock Electron: loads each module out of the packaged app.asar. */
export const NATIVE_SMOKE_SCRIPT = String.raw`
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
  const { rows, problems } = compareFuses(declared, packaged, stock);
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
    return !existsSync(dir) || !readdirNode(dir);
  });
  if (missing.length > 0) {
    console.error(
      `::error title=Native smoke::not unpacked from app.asar (build/Release/*.node): ${missing.join(', ')}`,
    );
    return 1;
  }
  const drift = runtimeMismatches(APP_DIR, path.dirname(STOCK_EXE));
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
    console.error(
      `::error title=Native smoke::loading the packaged native modules failed (exit ${String(res.status ?? res.signal)})`,
    );
    return 1;
  }
  console.log(
    'native smoke: better-sqlite3 and argon2 load from the packaged app under the shipped Electron',
  );
  return 0;
}

function readdirNode(dir: string): boolean {
  return readdirSync(dir).some((f) => f.endsWith('.node'));
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
