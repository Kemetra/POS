import { describe, expect, it } from 'vitest';

import { sanitizeMessage, scrubSentryEvent, type SentryEventLike } from '../scrub.js';

/**
 * RT-634 (OBS-5) — the OBS-1 privacy baseline (contract §3), ported from the
 * Backend-Core reference scrubber (RT-609). The event is REBUILT from an
 * allowlist; secrets are masked anywhere inside a message.
 */

const STAMP = { environment: 'staging', release: '0123456789ab' } as const;

function exceptionEvent(value: string, extra: Partial<SentryEventLike> = {}): SentryEventLike {
  return {
    event_id: 'e1',
    exception: { values: [{ type: 'Error', value }] },
    ...extra,
  };
}

describe('sanitizeMessage — contract §3.2 patterns', () => {
  it('masks a JWT anywhere in the text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    expect(sanitizeMessage(`token=${jwt} rejected`)).toBe('token=[jwt] rejected');
    expect(sanitizeMessage(jwt)).toBe('[jwt]');
  });

  it('keeps an eyJ prefix that is not a three-segment JWT', () => {
    expect(sanitizeMessage('eyJustAWord here')).toBe('eyJustAWord here');
  });

  it('drops URL userinfo, query and fragment; keeps scheme + host + path', () => {
    expect(
      sanitizeMessage('GET https://user:pw@api.example.com/v1/sales?api_key=s3cret#frag failed'),
    ).toBe('GET https://api.example.com/v1/sales failed');
  });

  it('keeps trailing punctuation outside the URL', () => {
    expect(sanitizeMessage('("https://h.example/p?q=1").')).toBe('("https://h.example/p").');
  });

  it('turns an unparsable URL into [url]', () => {
    expect(sanitizeMessage('see http://[bad')).toBe('see [url]');
  });

  it('masks an email address', () => {
    expect(sanitizeMessage('user ahmed@example.com not found')).toBe('user [email] not found');
  });

  it('masks Postgres row detail from "Key (" to the end', () => {
    expect(
      sanitizeMessage(
        'duplicate key value violates unique constraint "u" Key (email)=(a@b.c) already exists.',
      ),
    ).toBe('duplicate key value violates unique constraint "u" Key (...)=(...)');
  });

  it('masks Postgres "Failing row contains (" to the end', () => {
    expect(sanitizeMessage('null value in column Failing row contains (1, x, (y)).')).toBe(
      'null value in column Failing row contains (...)',
    );
  });

  it('truncates output to 300 chars', () => {
    const out = sanitizeMessage('a'.repeat(1000));
    expect(out).toHaveLength(300);
    expect(out.endsWith('...')).toBe(true);
  });

  it('caps the scanned input at 2,000 chars (a secret past the cap never leaks)', () => {
    const out = sanitizeMessage(`${'x '.repeat(1500)}ahmed@example.com`);
    expect(out).not.toContain('ahmed@example.com');
  });

  it('stays linear on hostile input (no backtracking)', () => {
    const hostile = `${'eyJ.'.repeat(25_000)}${'a@'.repeat(25_000)}${'http://'.repeat(10_000)}`;
    const started = performance.now();
    sanitizeMessage(hostile);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('scrubSentryEvent — allowlist rebuild (contract §3.1)', () => {
  it('drops an event with no exception (messages, sessions-like payloads)', () => {
    expect(scrubSentryEvent({ message: 'hello' }, STAMP)).toBeNull();
    expect(scrubSentryEvent({ exception: { values: [] } }, STAMP)).toBeNull();
  });

  it('drops request, user, extra, contexts, breadcrumbs, transaction and server_name', () => {
    const out = scrubSentryEvent(
      exceptionEvent('boom', {
        request: { url: 'https://x', headers: { Authorization: 'Bearer t' }, data: '{"total":5}' },
        user: { id: 'u1', email: 'a@b.c', ip_address: '1.2.3.4' },
        extra: { sale: { lines: [{ price: 100 }] } },
        contexts: { device: { name: 'Ahmed-PC' } },
        breadcrumbs: [{ message: 'card 4111' }],
        transaction: '/sale/123',
        server_name: 'AHMED-PC',
        fingerprint: ['x'],
      }),
      STAMP,
    );
    expect(out).not.toBeNull();
    const keys = Object.keys(out ?? {}).sort();
    expect(keys).toEqual(['environment', 'event_id', 'exception', 'release', 'tags']);
  });

  it('keeps only the allowed top-level fields', () => {
    const out = scrubSentryEvent(
      exceptionEvent('boom', { timestamp: 1, platform: 'node', level: 'fatal' }),
      STAMP,
    );
    expect(out).toMatchObject({ event_id: 'e1', timestamp: 1, platform: 'node', level: 'fatal' });
  });

  it('stamps environment, release and exactly the service/env/version tags', () => {
    const out = scrubSentryEvent(
      exceptionEvent('boom', {
        environment: 'production',
        release: 'pos@0.1.0',
        tags: { tenant_id: 't1', store_id: 's1', service: 'evil' },
      }),
      STAMP,
    );
    expect(out?.environment).toBe('staging');
    expect(out?.release).toBe('0123456789ab');
    expect(out?.tags).toEqual({ service: 'pos', env: 'staging', version: '0123456789ab' });
  });

  it('without a stamp, keeps the event environment/release and sends no tags', () => {
    const out = scrubSentryEvent(
      exceptionEvent('boom', { environment: 'e', release: 'r', tags: { tenant_id: 't' } }),
    );
    expect(out?.environment).toBe('e');
    expect(out?.release).toBe('r');
    expect(out?.tags).toBeUndefined();
  });

  it('sanitizes exception values and keeps type + mechanism type/handled only', () => {
    const out = scrubSentryEvent(
      {
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'fetch https://h.example/p?token=x for a@b.c',
              mechanism: { type: 'onerror', handled: false, data: { secret: 1 } },
              module: 'm',
            },
          ],
        },
      },
      STAMP,
    );
    expect(out?.exception?.values?.[0]).toEqual({
      type: 'TypeError',
      value: 'fetch https://h.example/p for [email]',
      mechanism: { type: 'onerror', handled: false },
    });
  });

  it('keeps location-only frame fields; drops vars and source context', () => {
    const out = scrubSentryEvent(
      {
        exception: {
          values: [
            {
              type: 'Error',
              value: 'x',
              stacktrace: {
                frames: [
                  {
                    filename: 'app:///dist/main/index.js',
                    function: 'f',
                    lineno: 1,
                    colno: 2,
                    module: 'index',
                    in_app: true,
                    vars: { password: 'p' },
                    context_line: 'const pin = "1234"',
                    pre_context: ['a'],
                    post_context: ['b'],
                    abs_path: 'C:\\Users\\Ahmed\\app\\index.js',
                  },
                ],
              },
            },
          ],
        },
      },
      STAMP,
    );
    expect(out?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: 'app:///dist/main/index.js',
      function: 'f',
      lineno: 1,
      colno: 2,
      module: 'index',
      in_app: true,
    });
  });

  it('strips the user-specific path prefix from frame filenames', () => {
    const frames = [
      'C:\\Users\\Ahmed\\AppData\\Local\\Programs\\POS Pulse\\resources\\app.asar\\dist\\main\\index.js',
      'file:///C:/Users/Ahmed/Documents/GitHub/POS/dist/renderer/assets/index-abc.js',
      '/home/ahmed/pos/dist/main/sale.js',
      'C:\\Users\\Ahmed\\secret\\loose.js',
      'node:internal/process/task_queues',
    ].map((filename) => ({ filename }));
    const out = scrubSentryEvent(
      { exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames } }] } },
      STAMP,
    );
    expect(out?.exception?.values?.[0]?.stacktrace?.frames?.map((f) => f.filename)).toEqual([
      'app:///dist/main/index.js',
      'app:///dist/renderer/assets/index-abc.js',
      'app:///dist/main/sale.js',
      'loose.js',
      'node:internal/process/task_queues',
    ]);
  });

  it('does not mutate its input', () => {
    const input = exceptionEvent('mail a@b.c', { user: { id: 'u' } });
    const snapshot = JSON.stringify(input);
    scrubSentryEvent(input, STAMP);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
