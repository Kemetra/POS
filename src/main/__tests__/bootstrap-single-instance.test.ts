import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-203 — composition-root guard for the single-instance lock.
 *
 * A static check, like `bootstrap-cashier-profile.test.ts`, that pins WHERE the
 * lock runs. The lock decision is unit-tested in
 * `app/__tests__/single-instance.test.ts`; the effect on the real boot is
 * covered by the behavioural `boot-single-instance.test.ts`.
 *
 * The load-bearing property is ORDER: a second launch must quit before it
 * opens the terminal database, runs migrations, starts a worker, registers IPC,
 * builds the printer/drawer ports or creates a window. So every one of those
 * must sit inside the boot chain that hangs off the lock gate.
 *
 * Line endings: Windows CI checks the source out with CRLF. Every check runs
 * against the source as checked out AND against a forced-CRLF copy, the source
 * is normalised to LF before analysis, and the checks are token/regex based so
 * no whitespace layout is load-bearing.
 */

const raw = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

const SOURCES: [string, string][] = [
  ['as checked out', raw],
  ['with CRLF line endings', raw.replace(/\r?\n/g, '\r\n')],
];

/** Analyse `text` as LF, without comments (prose cannot satisfy or trip a check). */
function analyse(text: string) {
  const code = text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const indexOfOrFail = (needle: RegExp): number => {
    const idx = code.search(needle);
    if (idx < 0) throw new Error(`index.ts: ${String(needle)} not found`);
    return idx;
  };
  /** Offset of EVERY match, so a second (e.g. module-level) call cannot hide behind the first. */
  const allIndexesOf = (needle: RegExp): number[] => {
    const flags = needle.flags.includes('g') ? needle.flags : `${needle.flags}g`;
    const found = [...code.matchAll(new RegExp(needle.source, flags))].map((m) => m.index);
    if (found.length === 0) throw new Error(`index.ts: ${String(needle)} not found`);
    return found;
  };
  return { code, indexOfOrFail, allIndexesOf };
}

/** Collapse all whitespace, so a token comparison ignores layout and line endings. */
const tokens = (text: string): string => text.trim().split(/\s+/).join(' ');

const LOCK_REQUEST = /acquireSingleInstance\(app,/;
const BOOT_GATE = /^singleInstanceReady\s*\?\.then\(async \(\) => \{/m;

describe.each(SOURCES)('RT-203 index.ts takes the lock first (%s)', (_eol, text) => {
  const { code, indexOfOrFail, allIndexesOf } = analyse(text);

  it('imports the lock module', () => {
    expect(code).toMatch(
      /import\s+\{[^}]*\bacquireSingleInstance\b[^}]*\}\s+from\s+'\.\/app\/single-instance\.js'/,
    );
  });

  it('runs nothing at module scope before the lock but the focus-target slot', () => {
    const prelude = code
      .slice(0, indexOfOrFail(LOCK_REQUEST))
      .replace(/^import\b[\s\S]*?from\s+'[^']+';$/gm, '');
    expect(tokens(prelude)).toBe(
      'let mainWindow: BrowserWindow | undefined; const singleInstanceReady =',
    );
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
});

describe.each(SOURCES)('RT-203 index.ts boots only behind the lock (%s)', (_eol, text) => {
  const { indexOfOrFail, allIndexesOf } = analyse(text);

  it.each([
    ['the logger', /createLogger\(/],
    ['the DB open', /\bopenDatabase\(/],
    ['the migrations read', /\breadMigrationsFromDisk\(/],
    // RT-320: migrations run through the runStartupMigrations seam.
    ['migrations', /\brunStartupMigrations\(/],
    ['the SecretStore', /\bcreateSecretStore\(/],
    ['IPC registration', /register\w+Handlers?\(/],
    ['the paired workers', /createPairedWorkers\(/],
    ['the printer pipeline', /createPrintPipeline\(/],
    ['the drawer dispatcher', /createDrawerKickDispatcher\(/],
    // RT-15 S4: the returns domain (payout + its drawer kick) and its resolver.
    ['the drawer kick transport', /const drawerKickTransport: DrawerKickTransport =/],
    ['the returns domain (payout)', /\bcomposeReturns\(/],
    ['the returns resolver', /\bscheduleReturnsResolver\(/],
    ['the window', /\bcreateWindow\(\)/],
  ])('runs %s only inside the lock-gated boot (every call)', (_what, needle) => {
    const gate = indexOfOrFail(BOOT_GATE);
    for (const at of allIndexesOf(needle)) expect(at).toBeGreaterThan(gate);
  });
});

describe.each(SOURCES)('RT-203 index.ts focuses the cashier window (%s)', (_eol, text) => {
  const { code, indexOfOrFail } = analyse(text);

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
