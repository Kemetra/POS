import { describe, it, expect, vi } from 'vitest';
import type { BrowserOptions, ErrorEvent, EventHint } from '@sentry/electron/renderer';

import { initSentryRenderer, scrubRendererEvent } from '../sentry-renderer.js';

/**
 * `ErrorEvent` requires a `type` field that's irrelevant to the
 * scrubber (which only looks at request/user/extra/contexts). Tests
 * build minimal inputs and cast via `unknown` to bypass the structural
 * complaint without creating runtime drift.
 */
function asEvent(partial: Partial<ErrorEvent>): ErrorEvent {
  return partial as unknown as ErrorEvent;
}

const NO_HINT: EventHint = {};

/**
 * Phase 9 / US7 — renderer-process Sentry init tests.
 *
 * Renderer Sentry mirrors main: same R9 DI seam (inject `sentryInit`),
 * same scrubber posture (request/user dropped, denylist keys stripped
 * from extra/contexts). The DSN reaches the renderer over the preload
 * bridge (D3) — `appConfig()` is called and its `sentryDsn` is the
 * source of truth. Renderers MUST NOT use `import.meta.env.VITE_*` for
 * DSN since Vite inlines those into the bundle at build time.
 *
 * SECURITY: a renderer that fails to fetch its config (bridge
 * unavailable) MUST NOT crash. Init becomes a no-op + console.warn.
 */

interface CapturedConsole {
  warn: ReturnType<typeof makeWarnSpy>;
}

function makeWarnSpy(): ReturnType<typeof vi.fn<(...args: unknown[]) => void>> {
  return vi.fn<(...args: unknown[]) => void>();
}

function makeConsole(): CapturedConsole {
  return { warn: makeWarnSpy() };
}

describe('initSentryRenderer — DSN unset (T064 mirror)', () => {
  it('does not call sentryInit when appConfig resolves with no sentryDsn', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({}),
      console: makeConsole(),
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('does not call sentryInit when appConfig returns empty sentryDsn', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({ sentryDsn: '' }),
      console: makeConsole(),
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('does not call sentryInit when appConfig returns whitespace sentryDsn', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({ sentryDsn: '   ' }),
      console: makeConsole(),
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).not.toHaveBeenCalled();
  });
});

describe('initSentryRenderer — DSN invalid / fetcher errors (T065 mirror)', () => {
  it('does not throw when sentryInit throws', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>(() => {
      throw new Error('Invalid DSN');
    });
    await expect(
      initSentryRenderer({
        sentryInit,
        fetchConfig: () => Promise.resolve({ sentryDsn: 'not-a-real-dsn' }),
        console: makeConsole(),
        appVersion: '0.1.0-test',
      }),
    ).resolves.toBeUndefined();
  });

  it('logs a single console.warn when sentryInit throws', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>(() => {
      throw new Error('Invalid DSN');
    });
    const console = makeConsole();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({ sentryDsn: 'not-a-real-dsn' }),
      console,
      appVersion: '0.1.0-test',
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('console.warn does not echo the DSN', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>(() => {
      throw new Error('Invalid DSN: leak-token-xyz');
    });
    const console = makeConsole();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({ sentryDsn: 'leak-token-xyz' }),
      console,
      appVersion: '0.1.0-test',
    });
    const calls = console.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(calls.some((s) => s.includes('leak-token-xyz'))).toBe(false);
  });

  it('does not throw and does not call sentryInit when fetchConfig rejects', async () => {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>();
    const console = makeConsole();
    await expect(
      initSentryRenderer({
        sentryInit,
        fetchConfig: () => Promise.reject(new Error('bridge unavailable')),
        console,
        appVersion: '0.1.0-test',
      }),
    ).resolves.toBeUndefined();
    expect(sentryInit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('initSentryRenderer — safe init options (D1 mirror)', () => {
  async function callInitWithDsn(): Promise<BrowserOptions> {
    const sentryInit = vi.fn<(opts: BrowserOptions) => void>();
    await initSentryRenderer({
      sentryInit,
      fetchConfig: () => Promise.resolve({ sentryDsn: 'https://example@o0.ingest.sentry.io/0' }),
      console: makeConsole(),
      appVersion: '0.1.0-test',
    });
    expect(sentryInit).toHaveBeenCalledTimes(1);
    return sentryInit.mock.calls[0]?.[0] as BrowserOptions;
  }

  it('passes the DSN through verbatim', async () => {
    expect((await callInitWithDsn()).dsn).toBe('https://example@o0.ingest.sentry.io/0');
  });

  it('sets sendDefaultPii to false', async () => {
    // Deprecated in @sentry/electron 7.20 in favour of dataCollection, but still the shipped, honoured
    // setting: the test must pin what init() actually receives until that migration is decided.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect((await callInitWithDsn()).sendDefaultPii).toBe(false);
  });

  it('sets integrations to []', async () => {
    expect((await callInitWithDsn()).integrations).toEqual([]);
  });

  it('sets tracesSampleRate to 0', async () => {
    expect((await callInitWithDsn()).tracesSampleRate).toBe(0);
  });

  it('passes the appVersion as release', async () => {
    expect((await callInitWithDsn()).release).toBe('0.1.0-test');
  });

  it('installs a beforeSend hook', async () => {
    expect(typeof (await callInitWithDsn()).beforeSend).toBe('function');
  });

  it('beforeSend strips event.user and denylist keys', async () => {
    const opts = await callInitWithDsn();
    const fakeEvent = {
      message: 'kept',
      user: { email: 'leak@example.com' },
      extra: { token: 'leak', kept: 'ok' },
    };
    const result = opts.beforeSend?.(
      fakeEvent as unknown as Parameters<NonNullable<BrowserOptions['beforeSend']>>[0],
      {},
    );
    // beforeSend may return Promise<Event|null> — narrow synchronously.
    expect(result).not.toBeNull();
    const cleaned = result as { user?: unknown; extra?: Record<string, unknown> };
    expect(cleaned.user).toBeUndefined();
    expect(cleaned.extra?.['token']).toBeUndefined();
    expect(cleaned.extra?.['kept']).toBe('ok');
  });
});

describe('scrubRendererEvent — D1 redaction', () => {
  it('drops event.request entirely', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        message: 'kept',
        request: { url: 'https://api.example.com/?token=abc' },
      }),
      NO_HINT,
    );
    expect(cleaned).not.toBeNull();
    expect((cleaned as { request?: unknown }).request).toBeUndefined();
  });

  it('drops event.user entirely', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        message: 'kept',
        user: { id: '42', email: 'cashier@example.com' },
      }),
      NO_HINT,
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
    const cleaned = scrubRendererEvent(asEvent({ message: 'kept', extra }), NO_HINT) as {
      extra?: Record<string, unknown>;
    };
    expect(cleaned.extra?.[key]).toBeUndefined();
    expect(cleaned.extra?.['kept']).toBe('ok');
  });

  it('strips denylist keys regardless of case', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        message: 'kept',
        extra: { ApiToken: 'x', SECRET_VALUE: 'y', kept: 'ok' },
      }),
      NO_HINT,
    ) as { extra?: Record<string, unknown> };
    expect(cleaned.extra?.['ApiToken']).toBeUndefined();
    expect(cleaned.extra?.['SECRET_VALUE']).toBeUndefined();
    expect(cleaned.extra?.['kept']).toBe('ok');
  });

  it('strips denylist keys from event.contexts', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        message: 'kept',
        contexts: {
          device: { name: 'POS-1', cardReaderId: 'abc' },
          runtime: { token: 'sek' },
        },
      }),
      NO_HINT,
    ) as { contexts?: Record<string, Record<string, unknown> | undefined> };
    expect(cleaned.contexts?.['device']?.['cardReaderId']).toBeUndefined();
    expect(cleaned.contexts?.['device']?.['name']).toBe('POS-1');
    expect(cleaned.contexts?.['runtime']?.['token']).toBeUndefined();
  });

  it('returns null for events with no message and no exception after scrubbing', () => {
    expect(scrubRendererEvent(asEvent({}), NO_HINT)).toBeNull();
  });

  it('keeps an event that still has useful payload after scrubbing', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        message: 'something happened',
        extra: { secret: 'hidden', kept: 'ok' },
      }),
      NO_HINT,
    );
    expect(cleaned).not.toBeNull();
    expect((cleaned as { message?: string }).message).toBe('something happened');
  });

  it('preserves exception payload while scrubbing surrounding fields', () => {
    const cleaned = scrubRendererEvent(
      asEvent({
        exception: { values: [{ type: 'Error', value: 'boom' }] },
        user: { email: 'leak@example.com' },
        extra: { token: 'leak' },
      }),
      NO_HINT,
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
