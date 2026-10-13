import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-444 (RT-116 S3) — composition-root guard for the sign-in admission guard.
 *
 * A static check, like `bootstrap-cashier-profile.test.ts`: `src/main/index.ts`
 * cannot be imported under vitest. The guard is an optional dependency of each
 * handler (tests that do not exercise admission omit it), so this pins that
 * production passes the ONE guard to every sign-in path, and the live-tender
 * read to sign-out.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

/** The constructor call `new <Name>({ … })`, up to its closing `});`. */
function construction(name: string): string {
  const start = source.indexOf(`new ${name}({`);
  if (start < 0) throw new Error(`index.ts: new ${name} not found`);
  return source.slice(start, source.indexOf('\n    });', start));
}

describe('main/index.ts wires the RT-444 admission guard', () => {
  it('builds one guard from the session manager', () => {
    expect(source.match(/createSessionAdmission\(\{/g)).toHaveLength(1);
    expect(source.indexOf('createSessionAdmission({')).toBeGreaterThan(
      source.indexOf('const operatorSessionManager = new SessionManager()'),
    );
  });

  it.each(['SignInHandler', 'CashierSignInHandler', 'TakeoverHandler'])(
    'passes it to %s',
    (name) => {
      expect(construction(name)).toMatch(/^\s*sessionAdmission,$/m);
    },
  );

  it('refuses sign-out while the session holds live tender', () => {
    expect(construction('SignOutHandler')).toContain(
      'sessionHasLiveTender: bindSessionHasLiveTender(db)',
    );
  });

  it('signs a superseded manager session out of the backend', () => {
    expect(source).toMatch(/registerSupersededSessionSignOut\(\{/);
  });

  it('RT-441: wraps every handler in the recovery-mode guard and registers recovery', () => {
    expect(source).toMatch(/createRecoveryModeGuardedIpcMain\(/);
    expect(source).toMatch(/recoveryModeProbe\.active = \(\) =>/);
    expect(source).toMatch(/registerRecoveryHandlers\(guardedIpcMain/);
    expect(source).toContain('attemptHasLiveTender: bindAttemptHasLiveTender(db),');
  });
});
