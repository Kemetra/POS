import { describe, expect, it } from 'vitest';

import { resolveObservabilityConfig } from '../config.js';

/**
 * RT-634 (OBS-5) — how the DSN, `env` and `release` reach main. All three are
 * runtime environment variables of the launched exe (the same route as
 * `VITE_API_BASE_URL` and `CLERK_PUBLISHABLE_KEY`); nothing is baked into the
 * asar or the renderer bundle.
 */

const DSN = 'https://abc123@o1.ingest.de.sentry.io/4500000000000001';

describe('resolveObservabilityConfig — DSN gate (contract §5)', () => {
  it.each([undefined, '', '   '])('is disabled/unset for %j', (value) => {
    expect(resolveObservabilityConfig({ SENTRY_DSN: value })).toEqual({
      kind: 'disabled',
      reason: 'unset',
    });
  });

  it.each([
    'not-a-dsn',
    'https://o1.ingest.de.sentry.io/45', // no public key
    'https://abc@o1.ingest.de.sentry.io/not-numeric',
    'ftp://abc@o1.ingest.de.sentry.io/45',
    'http://abc@o1.ingest.de.sentry.io/45', // plain http
  ])('is disabled/malformed for %s', (value) => {
    expect(resolveObservabilityConfig({ SENTRY_DSN: value })).toEqual({
      kind: 'disabled',
      reason: 'malformed',
    });
  });

  it.each([
    'https://abc@o1.ingest.sentry.io/45', // US region
    'https://abc@evil.example/45',
    'https://abc@ingest.de.sentry.io.evil.example/45',
    'https://abc@xingest.de.sentry.io/45',
  ])('refuses a host outside the allowed egress: %s', (value) => {
    expect(resolveObservabilityConfig({ SENTRY_DSN: value })).toEqual({
      kind: 'disabled',
      reason: 'egress_not_allowed',
    });
  });

  it('accepts an EU ingest DSN (trimmed)', () => {
    const out = resolveObservabilityConfig({ SENTRY_DSN: `  ${DSN} ` });
    expect(out.kind).toBe('enabled');
    expect(out.kind === 'enabled' && out.dsn).toBe(DSN);
  });
});

describe('resolveObservabilityConfig — env + release stamp (contract §1)', () => {
  it('reads DEPLOYMENT_ENVIRONMENT and POS_PULSE_RELEASE (SHA12, lowercased)', () => {
    const out = resolveObservabilityConfig({
      SENTRY_DSN: DSN,
      DEPLOYMENT_ENVIRONMENT: 'staging',
      POS_PULSE_RELEASE: '0123456789ABCDEF0123456789abcdef01234567',
    });
    expect(out).toEqual({
      kind: 'enabled',
      dsn: DSN,
      stamp: { environment: 'staging', release: '0123456789ab' },
      warnings: [],
    });
  });

  it('defaults both to unknown with a warning each when unset', () => {
    const out = resolveObservabilityConfig({ SENTRY_DSN: DSN });
    expect(out).toEqual({
      kind: 'enabled',
      dsn: DSN,
      stamp: { environment: 'unknown', release: 'unknown' },
      warnings: ['environment_missing', 'release_missing'],
    });
  });

  it.each(['Staging', 'prod uction', `a${'b'.repeat(40)}`, '-lab', 'staging\n'])(
    'rejects a malformed environment %j',
    (value) => {
      const out = resolveObservabilityConfig({ SENTRY_DSN: DSN, DEPLOYMENT_ENVIRONMENT: value });
      expect(out.kind === 'enabled' && out.stamp.environment).toBe('unknown');
      expect(out.kind === 'enabled' && out.warnings).toContain('environment_invalid');
    },
  );

  it.each(['0123456789a', 'g123456789ab', '0.1.0', '0123456789ab-dirty'])(
    'rejects a malformed release %j',
    (value) => {
      const out = resolveObservabilityConfig({ SENTRY_DSN: DSN, POS_PULSE_RELEASE: value });
      expect(out.kind === 'enabled' && out.stamp.release).toBe('unknown');
      expect(out.kind === 'enabled' && out.warnings).toContain('release_invalid');
    },
  );
});
