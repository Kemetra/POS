import { describe, expect, it, vi } from 'vitest';

import { installErrorReporter } from '../error-reporter';
import type { RendererErrorReport } from '../../../shared/renderer-error-report';

/**
 * RT-634 (OBS-5) — the renderer no longer runs a Sentry SDK. It forwards
 * uncaught errors and unhandled rejections over the typed bridge
 * (`window.api.reportError`); main validates, scrubs and sends. Reporting is
 * fire-and-forget and can never throw into the page.
 */

function harness(send = vi.fn<(r: RendererErrorReport) => Promise<void>>(() => Promise.resolve())) {
  const target = new EventTarget();
  const uninstall = installErrorReporter(target, send);
  return { target, send, uninstall };
}

function errorEvent(init: { error?: unknown; message?: string }): Event {
  const event = new Event('error');
  Object.assign(event, init);
  return event;
}

function rejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection');
  Object.assign(event, { reason });
  return event;
}

describe('installErrorReporter', () => {
  it('forwards an uncaught Error as {name, message, stack}', () => {
    const h = harness();
    const error = new TypeError('x is undefined');
    h.target.dispatchEvent(errorEvent({ error, message: 'Uncaught TypeError' }));
    expect(h.send).toHaveBeenCalledWith({
      name: 'TypeError',
      message: 'x is undefined',
      stack: error.stack,
    });
  });

  it('forwards an error event without an Error object by its message', () => {
    const h = harness();
    h.target.dispatchEvent(errorEvent({ message: 'Script error.' }));
    expect(h.send).toHaveBeenCalledWith({ name: 'Error', message: 'Script error.' });
  });

  it('falls back to a fixed message when the error event has no message', () => {
    const h = harness();
    h.target.dispatchEvent(errorEvent({}));
    expect(h.send).toHaveBeenCalledWith({ name: 'Error', message: 'uncaught error' });
  });

  it('omits the stack when the Error has none', () => {
    const h = harness();
    const error = new Error('no stack');
    Object.defineProperty(error, 'stack', { value: undefined });
    h.target.dispatchEvent(errorEvent({ error }));
    expect(h.send).toHaveBeenCalledWith({ name: 'Error', message: 'no stack' });
  });

  it('forwards an unhandled rejection with an Error reason', () => {
    const h = harness();
    const reason = new RangeError('bad');
    h.target.dispatchEvent(rejectionEvent(reason));
    expect(h.send).toHaveBeenCalledWith({
      name: 'RangeError',
      message: 'bad',
      stack: reason.stack,
    });
  });

  it('never serializes a non-Error rejection object', () => {
    const h = harness();
    h.target.dispatchEvent(rejectionEvent({ sale: { total: 500 } }));
    expect(h.send).toHaveBeenCalledWith({
      name: 'UnhandledRejection',
      message: 'non-error rejection',
    });
  });

  it('swallows a rejected or throwing send', async () => {
    const rejecting = harness(vi.fn(() => Promise.reject(new Error('ipc down'))));
    expect(() =>
      rejecting.target.dispatchEvent(errorEvent({ error: new Error('a') })),
    ).not.toThrow();
    const throwing = harness(
      vi.fn(() => {
        throw new Error('no bridge');
      }),
    );
    expect(() =>
      throwing.target.dispatchEvent(errorEvent({ error: new Error('b') })),
    ).not.toThrow();
    await Promise.resolve();
  });

  it('uninstall removes both listeners', () => {
    const h = harness();
    h.uninstall();
    h.target.dispatchEvent(errorEvent({ error: new Error('a') }));
    h.target.dispatchEvent(rejectionEvent(new Error('b')));
    expect(h.send).not.toHaveBeenCalled();
  });
});
