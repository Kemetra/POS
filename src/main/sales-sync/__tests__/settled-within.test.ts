/**
 * RT-17 follow-up (comments 10941 / 10949) — `settledWithin`: the one bounded
 * wait shared by the sale-sync engine, the shift sync engine and the returns
 * resolver drains. It settles when `work` settles (either way) or after
 * `timeoutMs`, whichever is first; it never rejects, never cancels `work`, and
 * leaves no timer behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settledWithin } from '../settled-within.js';

const TIMEOUT_MS = 1_000;

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  let reject: Deferred['reject'] = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether `wait` has settled, without awaiting it (microtasks flushed first). */
async function isSettled(wait: Promise<void>): Promise<boolean> {
  let settled = false;
  void wait.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settledWithin', () => {
  it('settles with undefined when the work resolves first, without waiting for the bound', async () => {
    const work = deferred();
    const wait = settledWithin(work.promise, TIMEOUT_MS);
    expect(await isSettled(wait)).toBe(false);
    work.resolve('a value that is not passed on');
    expect(await isSettled(wait)).toBe(true);
    await expect(wait).resolves.toBeUndefined();
  });

  it('settles (never rejects) when the work rejects first', async () => {
    const work = deferred();
    const wait = settledWithin(work.promise, TIMEOUT_MS);
    work.reject(new Error('the work failed'));
    expect(await isSettled(wait)).toBe(true);
    await expect(wait).resolves.toBeUndefined();
  });

  it('settles with the work already settled', async () => {
    await expect(settledWithin(Promise.resolve(1), TIMEOUT_MS)).resolves.toBeUndefined();
    await expect(
      settledWithin(Promise.reject(new Error('x')), TIMEOUT_MS),
    ).resolves.toBeUndefined();
  });

  it('settles exactly at the bound when the work never settles', async () => {
    const work = deferred();
    const wait = settledWithin(work.promise, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(await isSettled(wait)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await isSettled(wait)).toBe(true);
  });

  it('leaves no timer behind once the work settled first', async () => {
    const work = deferred();
    const wait = settledWithin(work.promise, TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);
    work.resolve(undefined);
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind once the bound passed', async () => {
    const wait = settledWithin(deferred().promise, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not cancel the work: it may still settle after the bound, unobserved', async () => {
    const work = deferred();
    const onSettled = vi.fn();
    void work.promise.then(onSettled);
    const wait = settledWithin(work.promise, TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await wait;
    expect(onSettled).not.toHaveBeenCalled();
    work.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('handles a rejection that arrives after the bound (no unhandled rejection)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const work = deferred();
      const wait = settledWithin(work.promise, TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await wait;
      work.reject(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((done) => {
        setImmediate(done);
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
