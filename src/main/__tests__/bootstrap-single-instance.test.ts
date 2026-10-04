import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-203 — composition-root guard for the single-instance lock.
 *
 * A static check, like `bootstrap-cashier-profile.test.ts`: `src/main/index.ts`
 * boots at module load, so it cannot be imported under vitest. The lock
 * decision itself is unit-tested in `app/__tests__/single-instance.test.ts`;
 * this guard pins WHERE it runs.
 *
 * The load-bearing property is ORDER: a second launch must quit before it
 * opens the terminal database, runs migrations, starts a worker, registers IPC,
 * builds the printer/drawer ports or creates a window. So every one of those
 * must sit inside the boot chain that hangs off the lock gate.
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');
const source = readFileSync(INDEX_PATH, 'utf-8');

/** `source` without comments, so prose cannot satisfy or trip a check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function indexOfOrFail(needle: RegExp): number {
  const idx = code.search(needle);
  if (idx < 0) throw new Error(`index.ts: ${String(needle)} not found`);
  return idx;
}

/** Offset of EVERY match, so a second (e.g. module-level) call cannot hide behind the first. */
function allIndexesOf(needle: RegExp): number[] {
  const global = new RegExp(
    needle.source,
    needle.flags.includes('g') ? needle.flags : `${needle.flags}g`,
  );
  const found = [...code.matchAll(global)].map((m) => m.index);
  if (found.length === 0) throw new Error(`index.ts: ${String(needle)} not found`);
  return found;
}

const LOCK_REQUEST = /acquireSingleInstance\(app,/;
const BOOT_GATE = /^singleInstanceReady\s*\?\.then\(async \(\) => \{/m;

describe('main/index.ts takes the single-instance lock first (RT-203)', () => {
  it('imports the lock module', () => {
    expect(code).toMatch(
      /import\s+\{[^}]*\bacquireSingleInstance\b[^}]*\}\s+from\s+'\.\/app\/single-instance\.js'/,
    );
  });

  it('runs nothing at module scope before the lock but the focus-target slot', () => {
    const prelude = code
      .slice(0, indexOfOrFail(LOCK_REQUEST))
      .replace(/^import\b[\s\S]*?from\s+'[^']+';$/gm, '')
      .trim();
    expect(prelude).toBe('let mainWindow: BrowserWindow | undefined;\nconst singleInstanceReady =');
  });

  it.each([/createWindowFactory\(/, /createDatabaseHolder\(/, /createWorkerRegistry\(/])(
    'builds %s only after the lock',
    (needle) => {
      const lock = indexOfOrFail(LOCK_REQUEST);
      for (const at of allIndexesOf(needle)) expect(at).toBeGreaterThan(lock);
    },
  );

  it('hangs the whole boot off the lock gate, with no other ready entry point', () => {
    expect(indexOfOrFail(BOOT_GATE)).toBeGreaterThan(indexOfOrFail(LOCK_REQUEST));
    expect(code).toMatch(/const singleInstanceReady = acquireSingleInstance\(app,/);
    expect(code).not.toMatch(/\.whenReady\(/);
    // A `ready` listener would boot a second launch too, bypassing the gate.
    expect(code).not.toMatch(/\.(on|once|prependListener|prependOnceListener)\(\s*['"`]ready['"`]/);
  });

  it.each([
    ['the logger', /createLogger\(/],
    ['the DB open', /\bopenDatabase\(/],
    ['the migrations read', /\breadMigrationsFromDisk\(/],
    ['migrations', /\brunMigrations\(/],
    ['the SecretStore', /\bcreateSecretStore\(/],
    ['IPC registration', /register\w+Handlers?\(/],
    ['the paired workers', /createPairedWorkers\(/],
    ['the printer pipeline', /createPrintPipeline\(/],
    ['the drawer dispatcher', /createDrawerKickDispatcher\(/],
    ['the window', /\bcreateWindow\(\)/],
  ])('runs %s only inside the lock-gated boot (every call)', (_what, needle) => {
    const gate = indexOfOrFail(BOOT_GATE);
    for (const at of allIndexesOf(needle)) expect(at).toBeGreaterThan(gate);
  });

  it('a second launch focuses the tracked cashier window, never "any window"', () => {
    const start = indexOfOrFail(LOCK_REQUEST);
    const handler = code.slice(start, code.indexOf('});', start));
    expect(handler).toMatch(/restoreAndFocus\(mainWindow\)/);
    expect(handler).not.toMatch(/getAllWindows/);
  });

  it('every createWindow() records the window it built as the focus target', () => {
    expect(code).toMatch(/const buildMainWindow = createWindowFactory\(\{/);
    const start = indexOfOrFail(/const createWindow = \(\): void => \{/);
    const body = code.slice(start, code.indexOf('};', start));
    expect(body).toMatch(/mainWindow = buildMainWindow\(\);/);
  });
});
