import { describe, expect, it, vi } from 'vitest';

import { createRendererErrorReporter } from '../renderer-error-report.js';

/**
 * RT-634 (OBS-5) — renderer errors reach Sentry through ONE typed, guarded
 * bridge channel (`app:report-error`). Main validates, caps and rate-limits
 * the report, then captures it in main so the same allowlist scrubber and the
 * offline transport apply.
 */

function harness(enabled = true) {
  const captureException = vi.fn();
  const logger = { warn: vi.fn() };
  let now = 0;
  const report = createRendererErrorReporter({
    captureException,
    isEnabled: () => enabled,
    logger,
    now: () => now,
  });
  return {
    report,
    captureException,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createRendererErrorReporter', () => {
  it('captures a valid report as an unhandled renderer Error', () => {
    const h = harness();
    h.report({
      name: 'TypeError',
      message: 'x is undefined',
      stack: 'TypeError: x\n    at f (file:///a.js:1:2)',
    });
    expect(h.captureException).toHaveBeenCalledTimes(1);
    const [error, hint] = h.captureException.mock.calls[0] as [Error, unknown];
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe('x is undefined');
    expect(error.stack).toContain('file:///a.js:1:2');
    expect(hint).toEqual({ mechanism: { type: 'renderer', handled: false } });
  });

  it('logs the error class locally (never the message)', () => {
    const h = harness();
    h.report({ name: 'TypeError', message: 'customer a@b.c' });
    expect(h.logger.warn).toHaveBeenCalledWith({ name: 'TypeError' }, 'renderer:uncaught-error');
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('a@b.c');
  });

  it('sends nothing when Sentry is not initialized, but still logs locally', () => {
    const h = harness(false);
    h.report({ name: 'Error', message: 'boom' });
    expect(h.captureException).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 'boom', 42, [], { name: 1, message: {} }])(
    'ignores a malformed payload %j',
    (payload) => {
      const h = harness();
      h.report(payload);
      expect(h.captureException).not.toHaveBeenCalled();
    },
  );

  it('caps oversized fields and normalizes an odd name', () => {
    const h = harness();
    h.report({
      name: 'Bad Name <script>',
      message: 'm'.repeat(10_000),
      stack: 's'.repeat(50_000),
      extra: 'x',
    });
    const [error] = h.captureException.mock.calls[0] as [Error];
    expect(error.name).toBe('Error');
    expect(error.message).toHaveLength(2000);
    expect(error.stack?.length).toBe(8000);
  });

  it('rate-limits to 10 reports per minute (Sentry AND local log) with one throttle warning', () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.report({ name: 'Error', message: `e${String(i)}` });
    expect(h.captureException).toHaveBeenCalledTimes(10);
    const throttles = h.logger.warn.mock.calls.filter(
      (c) => c[1] === 'sentry:renderer-report-throttled',
    );
    expect(throttles).toHaveLength(1);
    const logged = h.logger.warn.mock.calls.filter((c) => c[1] === 'renderer:uncaught-error');
    expect(logged).toHaveLength(10);
    h.advance(60_001);
    h.report({ name: 'Error', message: 'later' });
    expect(h.captureException).toHaveBeenCalledTimes(11);
  });

  it('a throwing captureException never escapes', () => {
    const h = harness();
    h.captureException.mockImplementation(() => {
      throw new Error('sdk broke');
    });
    expect(() => {
      h.report({ name: 'Error', message: 'boom' });
    }).not.toThrow();
  });
});
