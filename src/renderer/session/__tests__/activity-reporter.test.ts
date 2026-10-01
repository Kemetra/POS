import { describe, expect, it, vi } from 'vitest';

import { installActivityReporter, GENUINE_INPUT_EVENTS } from '../activity-reporter.js';

/**
 * RT-117 (RT-115 D4 / RT-116 §2.3) — the renderer half of 004 T028b that was
 * never built (RT-112 RC-1). Genuine operator input — keyboard (scanner
 * wedges type as keyboard), mouse, wheel, touch — is reported to main over the
 * existing notify-only `operator._reportActivity`, throttled to ≤ 1 per 5 s.
 *
 * Script-dispatched (untrusted) events, focus changes and timers never count.
 */

function setup(opts: { now?: () => number; trusted?: boolean } = {}) {
  const report = vi.fn();
  let t = 0;
  const now = opts.now ?? (() => t);
  const uninstall = installActivityReporter(window, report, {
    now,
    // jsdom marks dispatched events untrusted; the real default checks isTrusted.
    isGenuine: () => opts.trusted ?? true,
  });
  return {
    report,
    uninstall,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RT-117 installActivityReporter', () => {
  it('listens for keyboard, pointer, wheel and touch input only', () => {
    expect([...GENUINE_INPUT_EVENTS].sort()).toEqual(
      ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'].sort(),
    );
  });

  it.each(['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'])(
    'reports a genuine %s',
    (type) => {
      const { report } = setup();
      window.dispatchEvent(new Event(type));
      expect(report).toHaveBeenCalledTimes(1);
    },
  );

  it('throttles to at most one report per 5 seconds', () => {
    const { report, advance } = setup();
    window.dispatchEvent(new Event('keydown'));
    advance(1000);
    window.dispatchEvent(new Event('keydown'));
    advance(3999);
    window.dispatchEvent(new Event('pointermove'));
    expect(report).toHaveBeenCalledTimes(1);

    advance(1);
    window.dispatchEvent(new Event('keydown'));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it.each(['focus', 'blur', 'visibilitychange', 'scroll'])('ignores %s', (type) => {
    const { report } = setup();
    window.dispatchEvent(new Event(type));
    expect(report).not.toHaveBeenCalled();
  });

  it('ignores input that is not genuine (script-dispatched)', () => {
    const { report } = setup({ trusted: false });
    window.dispatchEvent(new Event('keydown'));
    expect(report).not.toHaveBeenCalled();
  });

  it('the default genuineness check rejects untrusted synthetic events', () => {
    const report = vi.fn();
    const uninstall = installActivityReporter(window, report);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); // isTrusted === false
    expect(report).not.toHaveBeenCalled();
    uninstall();
  });

  it('uninstall removes every listener', () => {
    const { report, uninstall } = setup();
    uninstall();
    window.dispatchEvent(new Event('keydown'));
    window.dispatchEvent(new Event('pointerdown'));
    expect(report).not.toHaveBeenCalled();
  });

  it('a throwing report never breaks input handling', () => {
    const report = vi.fn(() => {
      throw new Error('bridge gone');
    });
    const uninstall = installActivityReporter(window, report, { isGenuine: () => true });
    expect(() => window.dispatchEvent(new Event('keydown'))).not.toThrow();
    uninstall();
  });
});
