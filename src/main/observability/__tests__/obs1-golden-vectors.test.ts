import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';

import { createRendererErrorReporter } from '../renderer-error-report.js';
import { scrubSentryEvent } from '../scrub.js';
import { initSentryMain } from '../sentry-main.js';

/**
 * RT-693 — OBS-1 §3.5 golden vectors (Confluence 42926084, amended by
 * RT-682 and RT-694). `obs1-golden-vectors.json` is Backend-Core's file
 * (`packages/shared/__tests__/observability/`, Kemetra/Backend-Core#837),
 * copied unchanged: every repository asserts the same expected outputs.
 *
 * If a vector fails, fix the SOURCE — never the fixture.
 */

interface GoldenVectors {
  vectors: { id: string; input: string; expected: string }[];
  linearTime: {
    maxTotalMs: number;
    maxOutputLength: number;
    inputs: { pattern: string; repeat: number }[];
  };
}

const golden = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'obs1-golden-vectors.json'),
    'utf8',
  ),
) as GoldenVectors;

function scrubValue(value: string): string | undefined {
  return scrubSentryEvent({ exception: { values: [{ type: 'Error', value }] } })?.exception
    ?.values?.[0]?.value;
}

describe('OBS-1 §3.5 golden vectors (Bearer/Authorization and phones)', () => {
  it('carries all 46 contract vectors', () => {
    expect(golden.vectors).toHaveLength(46);
  });

  it.each(golden.vectors.map((v) => [v.id, v.input, v.expected] as const))(
    '%s: masks exactly as the contract vector says',
    (_id, input, expected) => {
      expect(scrubValue(input)).toBe(expected);
    },
  );

  it.each([
    ['a national mobile behind a stray +', 'call +01012345678 now', 'call +[phone] now'],
    ['a mobile glued to a letter before the +', 'x+201000000638 kept', 'x+[phone] kept'],
    [
      'a trailing Authorization with nothing after it',
      'missing Authorization:',
      'missing Authorization:',
    ],
    [
      'a phone before authorization= in one word',
      '{"phone":"01012345678","authorization":"x"}',
      '{"phone":"[phone]","authorization":[redacted]',
    ],
    [
      'an email before authorization= in one word',
      'jane@example.invalid,authorization=x',
      '[email]',
    ],
    [
      'a JWT before authorization= in one word',
      'id_token=eyJa.b.c;authorization=x',
      'id_token=[jwt]',
    ],
    [
      'a phone before an empty Authorization value',
      '+201000000638;Authorization: Bearer x',
      '[phone];Authorization: [redacted] [redacted]',
    ],
    ['a Bearer credential split across a newline', 'Bearer\nsecret-x', '[redacted]\n[redacted]'],
    [
      'a separator word across newlines (RT-694)',
      'Authorization\n:\nBearer x y',
      'Authorization\n:\n[redacted] [redacted] y',
    ],
    [
      'a quoted key before a separator word',
      "headers={'Authorization' : 'Bearer x'} y",
      "headers={'Authorization' : [redacted] [redacted] y",
    ],
    [
      'a bare Authorization key with no separator word',
      'missing Authorization',
      'missing Authorization',
    ],
    [
      'a key not directly before the separator word (known gap)',
      'Authorization ok : x',
      'Authorization ok : x',
    ],
    [
      'a value that is only a separator (known gap)',
      'Authorization : : x y',
      'Authorization : [redacted] x y',
    ],
  ])('follows the §3.2 phone/Authorization text on %s', (_label, input, expected) => {
    expect(scrubValue(input)).toBe(expected);
  });

  // A word masked because of the word before it (`[Bearer] <word>`) or read as a
  // separator value (`Authorization :<word>`) still passes on its own Bearer /
  // Authorization signal, so RT-694 never masks less than the RT-682 baseline.
  it.each([
    [
      'a separator value that ends in its own empty Authorization',
      'Authorization :a,Authorization: S1',
      'Authorization :[redacted] [redacted]',
    ],
    [
      'a separator value that ends in its own scheme value',
      'Authorization =x,Proxy-Authorization:Bearer S1',
      'Authorization =[redacted] [redacted]',
    ],
    [
      'a wrapped Bearer before an empty Authorization',
      '[Bearer] Authorization: S1',
      '[redacted] [redacted] [redacted]',
    ],
    [
      'a wrapped Bearer before an empty authorization=',
      '(Bearer) ?authorization= S1',
      '[redacted] [redacted] [redacted]',
    ],
    [
      'a wrapped scheme value before an empty Authorization',
      'Authorization: (Bearer) Authorization: S1',
      'Authorization: [redacted] [redacted] [redacted]',
    ],
  ])('keeps the next-word signal of a masked word on %s', (_label, input, expected) => {
    expect(scrubValue(input)).toBe(expected);
  });

  it("stays linear on the contract's adversarial inputs", () => {
    const { inputs, maxOutputLength, maxTotalMs } = golden.linearTime;
    const started = performance.now();
    for (const { pattern, repeat } of inputs) {
      expect(scrubValue(pattern.repeat(repeat))?.length).toBeLessThanOrEqual(maxOutputLength);
    }
    expect(performance.now() - started).toBeLessThan(maxTotalMs);
  });

  it('stays linear when the inputs exceed the scan cap many times over', () => {
    const adversarial = [
      'Bearer '.repeat(50_000),
      '1'.repeat(100_000),
      '+1'.repeat(50_000),
      '0020'.repeat(50_000),
      'a:Authorization: '.repeat(10_000),
      `${'authorization'.repeat(10_000)}:x`,
      'Authorization : '.repeat(50_000),
    ];
    const started = performance.now();
    for (const value of adversarial) expect(scrubValue(value)?.length).toBeLessThanOrEqual(300);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('OBS-1 §3.2 on the renderer path (renderer → IPC → main beforeSend)', () => {
  type InitFn = (options: ElectronMainOptions) => void;

  /** The stamped `beforeSend` that production installs in main. */
  function productionBeforeSend(): NonNullable<ElectronMainOptions['beforeSend']> {
    const sentryInit = vi.fn<InitFn>();
    initSentryMain({
      sentryInit,
      integrations: () => [],
      logger: { warn: vi.fn() },
      env: {
        SENTRY_DSN: 'https://abc123@o1.ingest.de.sentry.io/4500000000000001',
        DEPLOYMENT_ENVIRONMENT: 'staging',
        POS_PULSE_RELEASE: '0123456789ab',
      },
    });
    const beforeSend = sentryInit.mock.calls[0]?.[0].beforeSend;
    if (beforeSend === undefined) throw new Error('beforeSend not installed');
    return beforeSend;
  }

  /** The Error main captures for one renderer `app:report-error` payload. */
  function capturedRendererError(message: string): Error {
    const captureException = vi.fn<(error: Error, hint: unknown) => void>();
    const report = createRendererErrorReporter({
      captureException,
      isEnabled: () => true,
      logger: { warn: vi.fn() },
    });
    report({ name: 'TypeError', message });
    const error = captureException.mock.calls[0]?.[0];
    if (error === undefined) throw new Error('renderer report was not captured');
    return error;
  }

  it('masks a Bearer credential, an email and a phone a renderer error carries', () => {
    const vector = golden.vectors.find((v) => v.id === 'X1');
    if (vector === undefined) throw new Error('X1 missing from the fixture');
    const error = capturedRendererError(vector.input);

    const out = productionBeforeSend()(
      { exception: { values: [{ type: error.name, value: error.message }] } } as ErrorEvent,
      {},
    ) as ErrorEvent | null;
    expect(out?.exception?.values?.[0]?.value).toBe(vector.expected);
  });
});
