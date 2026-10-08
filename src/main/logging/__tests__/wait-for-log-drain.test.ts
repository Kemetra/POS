import { EventEmitter } from 'node:events';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForLogDrain } from '../logger.js';

/**
 * RT-164 — a refused packaged launch logs one line and then exits. The
 * production stream (pino-roll → SonicBoom, minLength 0) writes asynchronously
 * and `logger.flush(cb)` calls back immediately in that mode, so the packaged
 * exe exited before the refusal line reached disk. `waitForLogDrain` resolves
 * on the stream's `'drain'` (all pending writes done), bounded by a timeout.
 */

class FakeAsyncStream extends EventEmitter {
  readonly lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForLogDrain', () => {
  it('resolves when the logger stream emits drain, not before', async () => {
    const stream = new FakeAsyncStream();
    const logger = pino({}, stream);
    logger.error('app:debug_switch_refused');

    let settled = false;
    const done = waitForLogDrain(logger, 60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.emit('drain');
    await done;
    expect(settled).toBe(true);
    expect(stream.lines.join('')).toContain('app:debug_switch_refused');
  });

  it('resolves after the timeout when the stream never drains', async () => {
    vi.useFakeTimers();
    const logger = pino({}, new FakeAsyncStream());

    let settled = false;
    const done = waitForLogDrain(logger, 2000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });

  it('does not leave its drain listener behind after the timeout', async () => {
    vi.useFakeTimers();
    const stream = new FakeAsyncStream();
    const done = waitForLogDrain(pino({}, stream), 10);
    expect(stream.listenerCount('drain')).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(stream.listenerCount('drain')).toBe(0);
  });
});
