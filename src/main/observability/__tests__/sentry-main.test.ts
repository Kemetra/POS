import { describe, it, expect, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import { initSentryMain, scrubEvent } from '../sentry-main.js';

/**
 * `ErrorEvent` requires a `type` field that's irrelevant to the
 * scrubber (which only looks at request/user/extra/contexts). Tests
 * build minimal inputs and cast via `unknown` to bypass the structural
 * complaint without creating runtime drift.
 */
function asEvent(partial: Partial<ErrorEvent>): ErrorEvent {
  return partial as unknown as ErrorEvent;
}

/**
 * Phase 9 / US7 — main-process Sentry init tests.
 *
 * The real `Sentry.init` is NEVER called from these tests. We inject a
 * `vi.fn()` as the `sentryInit` shipper so we can assert (a) WHEN it is
 * called and (b) WITH WHAT options. The R9 DI seam mirrors Phase 4
 * (`DatabaseFactory`), Phase 5 (`SafeStorageLike`), and Phase 8
 * (`pinoRollFactory`).
 */

interface CapturedLogger {
  warn: ReturnType<typeof makeWarnSpy>;
  info: ReturnType<typeof makeWarnSpy>;
}

function makeWarnSpy(): ReturnType<
  typeof vi.fn<(fields: Record<string, unknown>, msg: string) => void>
> {
  return vi.fn<(fields: Record<string, unknown>, msg: string) => void>();
}

function makeLogger(): CapturedLogger {
  return {
    warn: makeWarnSpy(),
    info: makeWarnSpy(),
  };
}

describe('initSentryMain — DSN unset (T064)', () => {
  it('does not call sentryInit when env DSN is undefined', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>();
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: {},
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('does not call sentryInit when env DSN is empty string', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>();
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: { SENTRY_DSN: '' },
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('does not call sentryInit when env DSN is whitespace only', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>();
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: { SENTRY_DSN: '   ' },
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('returns void without throwing when DSN is unset', () => {
    expect(() => {
      initSentryMain({
        sentryInit: vi.fn(),
        logger: makeLogger(),
        env: {},
        appVersion: '0.1.0-test',
      });
    }).not.toThrow();
  });
});

describe('initSentryMain — DSN invalid (T065)', () => {
  it('does not throw when sentryInit throws', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>(() => {
      throw new Error('Invalid DSN');
    });
    const logger = makeLogger();
    expect(() => {
      initSentryMain({
        sentryInit,
        logger,
        env: { SENTRY_DSN: 'not-a-real-dsn' },
        appVersion: '0.1.0-test',
      });
    }).not.toThrow();
  });

  it('logs a single warning when sentryInit throws', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>(() => {
      throw new Error('Invalid DSN');
    });
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: { SENTRY_DSN: 'not-a-real-dsn' },
      appVersion: '0.1.0-test',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warning message contains a stable identifier and does not echo the DSN', () => {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>(() => {
      throw new Error('Invalid DSN: malformed-secret-token');
    });
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: { SENTRY_DSN: 'malformed-secret-token' },
      appVersion: '0.1.0-test',
    });
    // The fields object is the first arg, the message is the second arg
    // (pino convention). We don't assert on shape beyond "DSN is not in
    // either" — the goal is to make sure a forged DSN can't end up in
    // the on-disk log file.
    const calls = logger.warn.mock.calls;
    expect(calls).toHaveLength(1);
    const [fields, message] = calls[0] as [unknown, string];
    expect(message).toBe('sentry:init-failed');
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain('malformed-secret-token');
  });
});

describe('initSentryMain — safe init options (D1)', () => {
  function callInitWithDsn(): ElectronMainOptions {
    const sentryInit = vi.fn<(opts: ElectronMainOptions) => void>();
    const logger = makeLogger();
    initSentryMain({
      sentryInit,
      logger,
      env: { SENTRY_DSN: 'https://example@o0.ingest.sentry.io/0' },
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).toHaveBeenCalledTimes(1);
    return sentryInit.mock.calls[0]?.[0] as ElectronMainOptions;
  }

  it('passes the DSN through verbatim', () => {
    const opts = callInitWithDsn();
    expect(opts.dsn).toBe('https://example@o0.ingest.sentry.io/0');
  });

  it('sets sendDefaultPii to false', () => {
    // Deprecated in @sentry/electron 7.20 in favour of dataCollection, but still the shipped, honoured
    // setting: the test must pin what init() actually receives until that migration is decided.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(callInitWithDsn().sendDefaultPii).toBe(false);
  });

  it('sets integrations to []', () => {
    expect(callInitWithDsn().integrations).toEqual([]);
  });

  it('sets tracesSampleRate to 0', () => {
    expect(callInitWithDsn().tracesSampleRate).toBe(0);
  });

  it('passes the appVersion as release', () => {
    expect(callInitWithDsn().release).toBe('0.1.0-test');
  });

  it('installs a beforeSend hook', () => {
    expect(typeof callInitWithDsn().beforeSend).toBe('function');
  });
});

describe('scrubEvent — D1 redaction', () => {
  it('drops event.request entirely', () => {
    const cleaned = scrubEvent(
      asEvent({
        message: 'kept',
        request: { url: 'https://api.example.com/?token=abc', headers: { cookie: 'sid=1' } },
      }),
    );
    expect(cleaned).not.toBeNull();
    expect((cleaned as { request?: unknown }).request).toBeUndefined();
  });

  it('drops event.user entirely', () => {
    const cleaned = scrubEvent(
      asEvent({
        message: 'kept',
        user: { id: '42', email: 'cashier@example.com', ip_address: '127.0.0.1' },
      }),
    );
    expect(cleaned).not.toBeNull();
    expect((cleaned as { user?: unknown }).user).toBeUndefined();
  });

  it.each([
    'secret',
    'token',
    'password',
    'credential',
    'card',
    'pii',
    'cvv',
    'pan',
    'email',
    'phone',
  ])('strips top-level extra key matching /%s/i', (key) => {
    const extra = { [key]: 'should-be-stripped', kept: 'ok' };
    const cleaned = scrubEvent(asEvent({ message: 'kept', extra })) as {
      extra?: Record<string, unknown>;
    };
    expect(cleaned.extra).toBeDefined();
    expect(cleaned.extra?.[key]).toBeUndefined();
    expect(cleaned.extra?.['kept']).toBe('ok');
  });

  it('strips denylist keys regardless of case', () => {
    const cleaned = scrubEvent(
      asEvent({
        message: 'kept',
        extra: { ApiToken: 'x', SECRET_VALUE: 'y', userPassword: 'z', kept: 'ok' },
      }),
    ) as { extra?: Record<string, unknown> };
    expect(cleaned.extra?.['ApiToken']).toBeUndefined();
    expect(cleaned.extra?.['SECRET_VALUE']).toBeUndefined();
    expect(cleaned.extra?.['userPassword']).toBeUndefined();
    expect(cleaned.extra?.['kept']).toBe('ok');
  });

  it('strips denylist keys from event.contexts', () => {
    const cleaned = scrubEvent(
      asEvent({
        message: 'kept',
        contexts: {
          device: { name: 'POS-1', cardReaderId: 'abc' },
          runtime: { token: 'sek' },
        },
      }),
    ) as { contexts?: Record<string, Record<string, unknown> | undefined> };
    expect(cleaned.contexts?.['device']?.['cardReaderId']).toBeUndefined();
    expect(cleaned.contexts?.['device']?.['name']).toBe('POS-1');
    expect(cleaned.contexts?.['runtime']?.['token']).toBeUndefined();
  });

  it('returns null for events that have no message and no exception', () => {
    // A completely empty event after scrubbing gets dropped — Sentry
    // treats `null` from beforeSend as "do not send".
    expect(scrubEvent(asEvent({}))).toBeNull();
  });

  it('keeps an event that still has useful payload after scrubbing', () => {
    const cleaned = scrubEvent(
      asEvent({
        message: 'something happened',
        extra: { secret: 'hidden', kept: 'ok' },
      }),
    );
    expect(cleaned).not.toBeNull();
    expect((cleaned as { message?: string }).message).toBe('something happened');
  });

  it('preserves exception payload while scrubbing surrounding fields', () => {
    const cleaned = scrubEvent(
      asEvent({
        exception: { values: [{ type: 'Error', value: 'boom' }] },
        user: { email: 'leak@example.com' },
        extra: { token: 'leak' },
      }),
    ) as {
      exception?: { values?: Array<{ type?: string }> };
      user?: unknown;
      extra?: Record<string, unknown>;
    };
    expect(cleaned.exception?.values?.[0]?.type).toBe('Error');
    expect(cleaned.user).toBeUndefined();
    expect(cleaned.extra?.['token']).toBeUndefined();
  });
});
