import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-162 (RT-160 FU-1 / D-1) — composition-root guard for the fail-closed
 * cashier profile.
 *
 * A static check, like `bootstrap-wires-operator.test.ts`: `src/main/index.ts`
 * calls `app.whenReady()` at module load, so it cannot be imported under
 * vitest. The decision itself is unit-tested in
 * `app/__tests__/feature-flags.test.ts`; this guard pins WHERE it runs.
 *
 * The load-bearing property: the refusal happens in trusted main-process code
 * BEFORE the DB is opened, BEFORE any payment IPC is registered and BEFORE the
 * window exists, so an invalid profile can never reach payment-taking.
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');
const source = readFileSync(INDEX_PATH, 'utf-8');

function indexOfOrFail(needle: string | RegExp): number {
  const idx = typeof needle === 'string' ? source.indexOf(needle) : source.search(needle);
  if (idx < 0) throw new Error(`index.ts: ${String(needle)} not found`);
  return idx;
}

describe('main/index.ts enforces the cashier profile (RT-162)', () => {
  it('imports the config module', () => {
    expect(source).toMatch(
      /import\s+\{[^}]*\bassessCashierProfile\b[^}]*\}\s+from\s+'\.\/app\/feature-flags\.js'/,
    );
    expect(source).toMatch(
      /import\s+\{[^}]*\bparseFeatureFlags\b[^}]*\}\s+from\s+'\.\/app\/feature-flags\.js'/,
    );
  });

  it('assesses the profile before the DB opens, payments wire and the window is created', () => {
    const check = indexOfOrFail(/assessCashierProfile\(/);
    expect(check).toBeLessThan(indexOfOrFail('openDatabase(dbPath)'));
    expect(check).toBeLessThan(indexOfOrFail(/registerPayments\w*\(/));
    expect(check).toBeLessThan(indexOfOrFail(/^\s*createWindow\(\);/m));
  });

  it('assesses the profile after the main logger exists (the refusal is logged)', () => {
    expect(indexOfOrFail(/assessCashierProfile\(/)).toBeGreaterThan(
      indexOfOrFail(/const mainLogger = await createLogger\(/),
    );
  });

  it('logs, shows a native dialog and exits non-zero on refusal', () => {
    const start = indexOfOrFail(/assessCashierProfile\(/);
    const window = source.slice(start, indexOfOrFail('openDatabase(dbPath)'));
    expect(window).toContain("'app:cashier_profile_refused'");
    expect(window).toMatch(/app\.exit\(1\)/);
    // The dialog must NOT block the event loop. Packaged evidence (RT-162):
    // with the synchronous showErrorBox, pino's async SonicBoom write of the
    // refusal line was still queued behind `app:logger-ready` and did not reach
    // disk while the dialog was open (`flush(cb)` is a no-op at minLength 0).
    expect(window).not.toMatch(/dialog\.showErrorBox\(/);
    expect(window).toMatch(/dialog\s*\.showMessageBox\(\{[^}]*type:\s*'error'/);
    expect(window.indexOf("'app:cashier_profile_refused'")).toBeLessThan(
      window.search(/dialog\s*\.showMessageBox\(/),
    );
  });

  it('getAppConfig serves flags from the config module, not an inline parser', () => {
    expect(source).toMatch(/cfg\.features\s*=\s*parseFeatureFlags\(process\.env\)/);
    expect(source).not.toMatch(/\['1',\s*'true',\s*'yes',\s*'on'\]/);
    expect(source).not.toContain("process.env['POS_PULSE_FEATURE_PAYMENTS']");
    expect(source).not.toContain("process.env['POS_PULSE_FEATURE_SALE_FINALIZATION']");
  });
});
