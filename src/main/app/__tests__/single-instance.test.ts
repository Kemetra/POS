import { describe, it, expect, vi } from 'vitest';

import { acquireSingleInstance, restoreAndFocus } from '../single-instance.js';

/**
 * RT-203 — one POS process per terminal.
 *
 * Process-local coordination (sale-sync / read-down / returns-resolver
 * single-flight, the drawer double-kick guard, printer access) assumes ONE
 * process per terminal database. The lock is what makes that true: a second
 * launch must quit before it touches anything, and must hand the cashier back
 * to the window that is already running.
 */

type Listener = () => void;

function fakeApp(gotLock: boolean) {
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const listeners = new Map<string, Listener>();
  const app = {
    requestSingleInstanceLock: vi.fn(() => gotLock),
    quit: vi.fn(),
    whenReady: vi.fn(() => ready),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return app;
    }),
  };
  return { app, markReady, listenerFor: (event: string) => listeners.get(event) };
}

/** Let every queued promise reaction run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('acquireSingleInstance — the second launch (lock not acquired)', () => {
  it('quits and never runs the boot callback, even once the app is ready', async () => {
    const { app, markReady } = fakeApp(false);
    const boot = vi.fn();

    void acquireSingleInstance(app, vi.fn())?.then(boot);
    markReady();
    await settle();

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(boot).not.toHaveBeenCalled();
  });

  it('does not listen for later launches', () => {
    const { app, listenerFor } = fakeApp(false);

    void acquireSingleInstance(app, vi.fn());

    expect(listenerFor('second-instance')).toBeUndefined();
  });
});

describe('acquireSingleInstance — the first launch (lock acquired)', () => {
  it('boots once the app is ready, and does not quit', async () => {
    const { app, markReady } = fakeApp(true);
    const boot = vi.fn();

    void acquireSingleInstance(app, vi.fn())?.then(boot);
    await settle();
    expect(boot).not.toHaveBeenCalled();

    markReady();
    await settle();

    expect(boot).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  it('runs the focus handler when another launch is attempted', () => {
    const { app, listenerFor } = fakeApp(true);
    const onSecondInstance = vi.fn();

    void acquireSingleInstance(app, onSecondInstance);
    expect(onSecondInstance).not.toHaveBeenCalled();
    listenerFor('second-instance')?.();

    expect(onSecondInstance).toHaveBeenCalledTimes(1);
  });
});

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const win = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: vi.fn(() => calls.push('restore')),
    focus: vi.fn(() => calls.push('focus')),
  };
  return { win, calls };
}

describe('restoreAndFocus — bringing the running till back', () => {
  it('restores a minimized window before focusing it', () => {
    const { win, calls } = fakeWindow({ minimized: true });

    restoreAndFocus(win);

    expect(calls).toEqual(['restore', 'focus']);
  });

  it('focuses a window that is not minimized without restoring it', () => {
    const { win, calls } = fakeWindow();

    restoreAndFocus(win);

    expect(calls).toEqual(['focus']);
  });

  it('does nothing to a destroyed window', () => {
    const { win, calls } = fakeWindow({ minimized: true, destroyed: true });

    restoreAndFocus(win);

    expect(calls).toEqual([]);
  });

  it('does nothing before the window exists (a launch during boot)', () => {
    expect(() => {
      restoreAndFocus(undefined);
    }).not.toThrow();
  });
});
