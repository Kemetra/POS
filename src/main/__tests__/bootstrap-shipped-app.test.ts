import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-165 — composition-root guard for the shipped-app identity.
 *
 * A static check, like `bootstrap-cashier-profile.test.ts`: `src/main/index.ts`
 * calls `app.whenReady()` at module load, so it cannot be imported under
 * vitest. The predicate is unit-tested in `app/__tests__/shipped-app.test.ts`
 * and each gate in its own module; this guard pins the WIRING.
 *
 * The load-bearing property: no production/dev decision in main is keyed on
 * `app.isPackaged` alone, because a renamed copy of the shipped exe reports
 * `false` there. `app.isPackaged` may appear only as an INPUT to the shipped
 * predicate (here and in the RT-164 launch-switch guard, which applies the
 * same predicate internally).
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');
const source = readFileSync(INDEX_PATH, 'utf-8');

/** `source` with line and block comments removed, so prose cannot satisfy or trip a check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('main/index.ts keys security decisions on the shipped app (RT-165)', () => {
  it('imports the shared predicate', () => {
    expect(code).toMatch(
      /import\s+\{[^}]*\bisShippedApp\b[^}]*\}\s+from\s+'\.\/app\/shipped-app\.js'/,
    );
  });

  it('computes the shipped identity from isPackaged AND the app path', () => {
    expect(code).toMatch(
      /const shippedApp = isShippedApp\(\{\s*isPackaged: app\.isPackaged,\s*appPath: app\.getAppPath\(\),?\s*\}\)/,
    );
  });

  it('uses app.isPackaged only as an input to the shipped predicate', () => {
    // Exactly two reads: the shippedApp computation and the RT-164
    // launch-switch input (which runs the same predicate internally). Every
    // gate below takes its `isPackaged` dep from `shippedApp`, never from here.
    const reads = code.match(/app\.isPackaged/g) ?? [];
    expect(reads).toHaveLength(2);
    expect(code).toMatch(/assessLaunchSwitches\(\{\s*isPackaged: app\.isPackaged,/);
  });

  it.each([
    'applyDevSeedCatalogueIfRequested',
    'createSecretStore',
    'applyDevSkipPairingIfRequested',
    'applyDevSkipOperatorSignInIfRequested',
    'createCartBridgeHandlers',
  ])('%s receives the shipped identity as its isPackaged dep', (fn) => {
    const start = code.search(new RegExp(`\\b${fn}\\(\\{`));
    expect(start).toBeGreaterThan(-1);
    const call = code.slice(start, code.indexOf('});', start));
    expect(call).toMatch(/\bisPackaged: shippedApp\b/);
  });

  it('resolves the migrations directory from the shipped identity', () => {
    const start = code.search(/function resolveMigrationsDir\(\)/);
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf('}', start));
    expect(body).toMatch(/return shippedApp\b/);
  });
});
