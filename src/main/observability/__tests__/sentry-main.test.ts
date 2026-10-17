import { describe, it, expect, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import { initSentryMain, mainIntegrations, scrubEvent, type Integration } from '../sentry-main.js';

/**
 * Phase 9 / US7, reworked by RT-634 (OBS-5) — main-process Sentry init.
 *
 * The real `Sentry.init` is NEVER called from these tests. A `vi.fn()` is
 * injected as `sentryInit` so we can assert WHEN it is called and WITH WHAT
 * options (R9 DI seam).
 */

const DSN = 'https://abc123@o1.ingest.de.sentry.io/4500000000000001';
const FAKE_INTEGRATIONS = [{ name: 'Fake' } as Integration];

type WarnFn = (fields: Record<string, unknown>, msg: string) => void;

function makeLogger(): { warn: ReturnType<typeof vi.fn<WarnFn>> } {
  return { warn: vi.fn<WarnFn>() };
}

type InitFn = (options: ElectronMainOptions) => void;

function init(env: Record<string, string | undefined>, sentryInit = vi.fn<InitFn>()) {
  const logger = makeLogger();
  const result = initSentryMain({
    sentryInit,
    integrations: () => FAKE_INTEGRATIONS,
    logger,
    env,
  });
  return { result, logger, sentryInit };
}

function optionsOf(sentryInit: ReturnType<typeof vi.fn<InitFn>>): ElectronMainOptions {
  expect(sentryInit).toHaveBeenCalledTimes(1);
  const opts = sentryInit.mock.calls[0]?.[0];
  if (opts === undefined) throw new Error('sentryInit not called');
  return opts;
}

describe('initSentryMain — default-inert (AC1, contract §5)', () => {
  it.each([{}, { SENTRY_DSN: '' }, { SENTRY_DSN: '   ' }])(
    'never calls sentryInit and stays silent for %j',
    (env) => {
      const { result, logger, sentryInit } = init(env);
      expect(sentryInit).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'disabled' });
    },
  );

  it('a malformed DSN logs one warning that never echoes the DSN', () => {
    const { result, logger, sentryInit } = init({ SENTRY_DSN: 'malformed-secret-token' });
    expect(sentryInit).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'disabled' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ reason: 'malformed' }, 'sentry:disabled');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('malformed-secret-token');
  });

  it('a DSN outside the allowed egress is refused with one warning', () => {
    const { result, logger, sentryInit } = init({ SENTRY_DSN: 'https://k@evil.example/1' });
    expect(sentryInit).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'disabled' });
    expect(logger.warn).toHaveBeenCalledWith({ reason: 'egress_not_allowed' }, 'sentry:disabled');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('evil.example');
  });

  it('a throwing sentryInit logs one stable warning and never throws', () => {
    const sentryInit = vi.fn<InitFn>(() => {
      throw new Error(`Invalid DSN ${DSN}`);
    });
    const env = {
      SENTRY_DSN: DSN,
      DEPLOYMENT_ENVIRONMENT: 'staging',
      POS_PULSE_RELEASE: '0123456789ab',
    };
    const { result, logger } = init(env, sentryInit);
    expect(result).toEqual({ kind: 'failed' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ reason: 'init-threw' }, 'sentry:init-failed');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('abc123');
  });
});

describe('initSentryMain — enabled', () => {
  const ENV = {
    SENTRY_DSN: DSN,
    DEPLOYMENT_ENVIRONMENT: 'staging',
    POS_PULSE_RELEASE: '0123456789abcdef',
  };

  it('returns the stamp and logs nothing when fully configured', () => {
    const { result, logger } = init(ENV);
    expect(result).toEqual({
      kind: 'initialized',
      stamp: { environment: 'staging', release: '0123456789ab' },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns once (no values) when env/release default to unknown', () => {
    const { logger } = init({ SENTRY_DSN: DSN, POS_PULSE_RELEASE: 'nope' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { warnings: ['environment_missing', 'release_invalid'] },
      'sentry:stamp-defaulted',
    );
  });

  it('passes the locked-down option set', () => {
    const { sentryInit } = init(ENV);
    const opts = optionsOf(sentryInit);
    expect(opts.dsn).toBe(DSN);
    expect(opts.environment).toBe('staging');
    expect(opts.release).toBe('0123456789ab');
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- still the honoured setting in 7.20
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.maxBreadcrumbs).toBe(0);
    expect(opts.sendClientReports).toBe(false);
    expect(opts.tracesSampleRate).toBeUndefined();
  });

  it('turns the SDK defaults OFF and adds only the reviewed integrations', () => {
    // `integrations: []` alone does NOT disable the defaults: the SDK merges
    // `[...defaults, ...integrations]` (minidumps, sessions, breadcrumbs,
    // local variables, screenshots...). `defaultIntegrations: false` does.
    const opts = optionsOf(init(ENV).sentryInit);
    expect(opts.defaultIntegrations).toBe(false);
    expect(opts.integrations).toEqual(FAKE_INTEGRATIONS);
  });

  it('uses Classic IPC only (Protocol mode throws after app ready)', () => {
    // IPCMode.Classic === 1. The enum is not importable here: the SDK's
    // runtime entry loads `electron`, which the test runner does not provide.
    expect(optionsOf(init(ENV).sentryInit).ipcMode).toBe(1);
  });

  it('bounds the offline buffer (contract §5)', () => {
    expect(optionsOf(init(ENV).sentryInit).transportOptions).toEqual({
      maxQueueSize: 30,
      maxAgeDays: 7,
    });
  });

  it('beforeSend rebuilds the event and stamps service/env/version', () => {
    const opts = optionsOf(init(ENV).sentryInit);
    const out = opts.beforeSend?.(
      {
        exception: { values: [{ type: 'Error', value: 'x' }] },
        user: { email: 'a@b.c' },
        tags: { tenant_id: 't' },
      } as unknown as ErrorEvent,
      {},
    ) as ErrorEvent | null;
    expect(out?.user).toBeUndefined();
    expect(out?.tags).toEqual({ service: 'pos', env: 'staging', version: '0123456789ab' });
  });
});

describe('mainIntegrations — the reviewed allowlist', () => {
  it('is exactly uncaught exception, unhandled rejection, linked errors and dedupe', () => {
    const make = (name: string) => vi.fn((): Integration => ({ name }));
    const factories = {
      onUncaughtExceptionIntegration: make('OnUncaughtException'),
      onUnhandledRejectionIntegration: make('OnUnhandledRejection'),
      linkedErrorsIntegration: make('LinkedErrors'),
      dedupeIntegration: make('Dedupe'),
    };
    expect(mainIntegrations(factories).map((i: Integration) => i.name)).toEqual([
      'OnUncaughtException',
      'OnUnhandledRejection',
      'LinkedErrors',
      'Dedupe',
    ]);
    expect(factories.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: 'warn' });
  });
});

describe('scrubEvent — unstamped allowlist scrubber', () => {
  it('drops message-only events and everything outside the allowlist', () => {
    expect(scrubEvent({ message: 'm' } as unknown as ErrorEvent)).toBeNull();
    const out = scrubEvent({
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      extra: { token: 'leak' },
    } as unknown as ErrorEvent);
    expect(out).toEqual({ exception: { values: [{ type: 'Error', value: 'boom' }] } });
  });
});
