import { describe, expect, it } from 'vitest';

import { createPrintActivity, trackPrintPipeline } from '../print-activity.js';

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

describe('trackPrintPipeline', () => {
  // The pipeline is the one place every print goes through: the receipt dispatcher, the cash
  // return slip and the sale-history reprint all end in `render` or `printRendered`.
  function fakePipeline(op: Promise<unknown>) {
    return { render: () => op, printRendered: () => op };
  }

  it.each(['render', 'printRendered'] as const)(
    'marks the terminal busy for the duration of %s',
    async (method) => {
      const activity = createPrintActivity();
      const op = deferred<{ ok: true }>();
      const tracked = trackPrintPipeline(fakePipeline(op.promise) as never, activity);

      const pending = (tracked[method] as (...a: unknown[]) => Promise<unknown>)({});
      expect(activity.isActive()).toBe(true);
      op.resolve({ ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
      expect(activity.isActive()).toBe(false);
    },
  );

  it('settles the count when a print fails', async () => {
    const activity = createPrintActivity();
    const tracked = trackPrintPipeline(
      {
        render: () => Promise.reject(new Error('printer jammed')),
        printRendered: () => Promise.resolve('r'),
      } as never,
      activity,
    );
    await expect(tracked.render({} as never)).rejects.toThrow('printer jammed');
    expect(activity.isActive()).toBe(false);
  });

  it('forwards its arguments untouched', async () => {
    const activity = createPrintActivity();
    const seen: unknown[] = [];
    const tracked = trackPrintPipeline(
      {
        render: (payload: unknown) => {
          seen.push(payload);
          return Promise.resolve('r');
        },
        printRendered: (rendered: unknown) => {
          seen.push(rendered);
          return Promise.resolve('r');
        },
      } as never,
      activity,
    );
    await tracked.render('payload' as never);
    await tracked.printRendered('slip' as never);
    expect(seen).toEqual(['payload', 'slip']);
  });
});
