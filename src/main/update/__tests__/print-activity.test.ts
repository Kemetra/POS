import { describe, expect, it } from 'vitest';

import { createPrintActivity, trackPrintDispatcher } from '../print-activity.js';

/**
 * RT-772 slice 2 — "a print is in progress" has no durable state, so main counts
 * the in-flight dispatches in memory. The gate reads `isActive()`.
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPrintActivity', () => {
  it('is idle until a tracked operation starts, and idle again when it settles', async () => {
    const activity = createPrintActivity();
    const op = deferred<string>();
    expect(activity.isActive()).toBe(false);

    const tracked = activity.track(() => op.promise);
    expect(activity.isActive()).toBe(true);

    op.resolve('done');
    await expect(tracked).resolves.toBe('done');
    expect(activity.isActive()).toBe(false);
  });

  it('stays active until the last of several overlapping operations settles', async () => {
    const activity = createPrintActivity();
    const a = deferred<null>();
    const b = deferred<null>();
    const ta = activity.track(() => a.promise);
    const tb = activity.track(() => b.promise);

    a.resolve(null);
    await ta;
    expect(activity.isActive()).toBe(true);
    b.resolve(null);
    await tb;
    expect(activity.isActive()).toBe(false);
  });

  it('settles on rejection too, and passes the error through', async () => {
    const activity = createPrintActivity();
    const boom = new Error('printer jam');
    await expect(activity.track(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(activity.isActive()).toBe(false);
  });

  it('turns a synchronous throw into a rejection, and settles', async () => {
    const activity = createPrintActivity();
    await expect(
      activity.track(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(activity.isActive()).toBe(false);
  });

  it('counts the operation from the moment it is called, before it first yields', () => {
    const activity = createPrintActivity();
    let activeInsideOp = false;
    const tracked = activity.track(() => {
      activeInsideOp = activity.isActive();
      return Promise.resolve('x');
    });
    expect(activeInsideOp).toBe(true);
    expect(activity.isActive()).toBe(true);
    return tracked;
  });
});

describe('trackPrintDispatcher', () => {
  function fakeDispatcher(op: Promise<unknown>) {
    return {
      dispatchFirstPrint: () => op,
      dispatchRetryPrint: () => op,
      dispatchReprint: () => op,
    };
  }

  it.each(['dispatchFirstPrint', 'dispatchRetryPrint', 'dispatchReprint'] as const)(
    'marks the terminal busy for the duration of %s',
    async (method) => {
      const activity = createPrintActivity();
      const op = deferred<{ ok: true }>();
      const tracked = trackPrintDispatcher(fakeDispatcher(op.promise) as never, activity);

      const pending = (tracked[method] as (...a: unknown[]) => Promise<unknown>)({}, {}, [], {});
      expect(activity.isActive()).toBe(true);
      op.resolve({ ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
      expect(activity.isActive()).toBe(false);
    },
  );

  it('forwards its arguments untouched', async () => {
    const activity = createPrintActivity();
    const seen: unknown[][] = [];
    const tracked = trackPrintDispatcher(
      {
        dispatchFirstPrint: (...args: unknown[]) => {
          seen.push(args);
          return Promise.resolve('r');
        },
        dispatchRetryPrint: () => Promise.resolve('r'),
        dispatchReprint: () => Promise.resolve('r'),
      } as never,
      activity,
    );
    await tracked.dispatchFirstPrint('payload' as never, 'ctx' as never);
    expect(seen).toEqual([['payload', 'ctx']]);
  });
});
