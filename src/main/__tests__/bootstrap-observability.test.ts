import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-634 (OBS-5) — composition-root guard for observability wiring.
 *
 * A static check, like `bootstrap-shipped-app.test.ts`: `src/main/index.ts`
 * calls `app.whenReady()` at module load, so it cannot be imported under
 * vitest. The pieces are unit-tested in `observability/__tests__`; this guard
 * pins the WIRING.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('main/index.ts observability wiring (RT-634)', () => {
  it('every raw fetch except Clerk is wrapped with X-Request-Id', () => {
    const lines = code.split('\n').filter((line) => line.includes('globalThis.fetch'));
    const unwrapped = lines.filter((line) => !line.includes('withRequestId(globalThis.fetch'));
    // The single unwrapped fetch is the Clerk exchanger (not Backend-Core).
    expect(unwrapped).toHaveLength(1);
    const clerkBlock = code.slice(code.indexOf('function resolveClerkExchanger'));
    expect(clerkBlock.slice(0, clerkBlock.indexOf('\n}\n'))).toContain(unwrapped[0]?.trim());
  });

  it('the Backend-Core base fetch feeds pairing and the observed backend fetch', () => {
    expect(code).toMatch(/createNetwork\(\{\s*fetch: backendBaseFetch,/);
    expect(code).toContain('terminalStatus.observeFetch(backendBaseFetch)');
  });

  it('inits Sentry with the reviewed integrations and never hands the renderer a DSN', () => {
    expect(code).toMatch(/integrations: \(\) => mainIntegrations\(Sentry\)/);
    expect(code).not.toMatch(/sentryDsn/);
    expect(code).not.toMatch(/process\.env\['SENTRY_DSN'\]/);
  });

  it('registers the renderer error channel on the guarded ipcMain', () => {
    expect(code).toMatch(/registerReportErrorHandler\(\s*guardedIpcMain,/);
    expect(code).toMatch(/isEnabled: \(\) => sentryMain\.kind === 'initialized'/);
  });
});
