import { describe, expect, it, vi, type Mock } from 'vitest';

import type { PairingService } from '../../pairing/service.js';
import type { PairingSubmitResult } from '../../../shared/pairing-types.js';
import {
  createPairedWorkers,
  withPairedNotification,
  type PairedWorkersLogger,
} from '../paired-workers.js';

/**
 * RT-202 — paired-only worker lifecycle.
 *
 * The catalogue read-down driver, the AD-2 finalize listener and the 011
 * sale-sync engine need the paired terminal's scope. They used to be built only
 * in a "paired at boot" branch, so a terminal that paired in-process (the
 * renderer never relaunches the app) stayed without workers until a restart.
 *
 * `createPairedWorkers` is the once-latch behind both entry points:
 *   • boot, already paired  → `notifyPaired` first, so each later `register`
 *     starts immediately (same order and error behaviour as before);
 *   • boot, unpaired        → starters are held until `notifyPaired`;
 *   • in-process pairing    → `notifyPaired` after the pairing is persisted.
 */

const TERMINAL = { tenant_id: 'tenant-A', branch_id: 'branch-B', terminal_id: 'terminal-C' };

type LogFn = (payload: Record<string, unknown>, message: string) => void;

function makeLogger(): PairedWorkersLogger & { info: Mock<LogFn>; error: Mock<LogFn> } {
  return { info: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

describe('RT-202 paired workers — deferred start', () => {
  it('holds registered starters while the terminal is unpaired', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize', start);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts every held starter, in registration order, with the paired scope', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const order: string[] = [];
    const seen: unknown[] = [];
    workers.register('read-down', (t) => {
      order.push('read-down');
      seen.push(t);
    });
    workers.register('finalize+sync', (t) => {
      order.push('finalize+sync');
      seen.push(t);
    });

    workers.notifyPaired(TERMINAL);

    expect(order).toEqual(['read-down', 'finalize+sync']);
    expect(seen).toEqual([TERMINAL, TERMINAL]);
  });

  it('starts each starter exactly once even when notifyPaired is called repeatedly', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize+sync', start);

    workers.notifyPaired(TERMINAL);
    workers.notifyPaired(TERMINAL);
    workers.notifyPaired({ ...TERMINAL, terminal_id: 'terminal-other' });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(TERMINAL);
  });

  it('starts a starter registered AFTER pairing immediately, and only once (paired boot)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);

    const start = vi.fn();
    workers.register('read-down', start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(TERMINAL);
    workers.notifyPaired(TERMINAL);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets an immediate start failure propagate (paired-boot behaviour is unchanged)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);
    expect(() => {
      workers.register('finalize+sync', () => {
        throw new Error('boot wiring failed');
      });
    }).toThrow('boot wiring failed');
  });

  it('isolates a deferred start failure: logs it and still starts the others', () => {
    const logger = makeLogger();
    const workers = createPairedWorkers({ logger });
    const second = vi.fn();
    workers.register('read-down', () => {
      throw new Error('boom');
    });
    workers.register('finalize+sync', second);

    expect(() => {
      workers.notifyPaired(TERMINAL);
    }).not.toThrow();

    expect(second).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('paired_workers:start_failed');
    expect(payload).toMatchObject({ worker: 'read-down', error: 'boom' });
  });

  it('does not retry a starter that failed (no duplicate half-built workers)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const flaky = vi.fn(() => {
      throw new Error('boom');
    });
    workers.register('finalize+sync', flaky);

    workers.notifyPaired(TERMINAL);
    workers.notifyPaired(TERMINAL);

    expect(flaky).toHaveBeenCalledTimes(1);
  });

  it('never starts anything when pairing never happens (failed/incomplete pairing)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('read-down', start);
    workers.register('finalize+sync', start);
    // No notifyPaired — the pairing failed or was never completed.
    expect(start).not.toHaveBeenCalled();
  });
});

describe('RT-202 paired workers — shutdown latch', () => {
  it('after close(), a late pairing starts nothing (no worker against a closed DB)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    const start = vi.fn();
    workers.register('finalize+sync', start);

    workers.close();
    workers.notifyPaired(TERMINAL);

    expect(start).not.toHaveBeenCalled();
  });

  it('after close(), a late register does not start even if already paired', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    workers.notifyPaired(TERMINAL);
    workers.close();

    const start = vi.fn();
    workers.register('read-down', start);

    expect(start).not.toHaveBeenCalled();
  });

  it('close() is idempotent (window-all-closed then quit both call it)', () => {
    const workers = createPairedWorkers({ logger: makeLogger() });
    expect(() => {
      workers.close();
      workers.close();
    }).not.toThrow();
  });
});

describe('RT-202 withPairedNotification — pairing-service wrapper', () => {
  const SUCCESS: PairingSubmitResult = {
    outcome: 'success',
    tenant_id: 'tenant-A',
    branch_id: 'branch-B',
    terminal_id: 'terminal-C',
    terminal_label: 'Counter 1',
  };

  function innerReturning(result: PairingSubmitResult): PairingService & {
    submit: Mock<PairingService['submit']>;
  } {
    return { submit: vi.fn<PairingService['submit']>(() => Promise.resolve(result)) };
  }

  it('returns the inner result unchanged and notifies exactly once on success, after submit resolved', async () => {
    const inner = innerReturning(SUCCESS);
    const onPaired = vi.fn();
    const wrapped = withPairedNotification(inner, onPaired);

    const result = await wrapped.submit('CODE');

    expect(result).toBe(SUCCESS);
    expect(inner.submit).toHaveBeenCalledWith('CODE');
    expect(onPaired).toHaveBeenCalledTimes(1);
    const submittedAt = inner.submit.mock.invocationCallOrder[0] ?? Infinity;
    const notifiedAt = onPaired.mock.invocationCallOrder[0] ?? -Infinity;
    expect(submittedAt).toBeLessThan(notifiedAt);
  });

  it.each([
    ['invalid_code', { outcome: 'invalid_code' }],
    ['expired_code', { outcome: 'expired_code' }],
    ['already_paired', { outcome: 'already_paired' }],
    ['branch_mismatch', { outcome: 'branch_mismatch' }],
    ['rate_limited', { outcome: 'rate_limited', retry_after_s: 30 }],
    ['network_error', { outcome: 'network_error' }],
    ['unknown_error', { outcome: 'unknown_error' }],
  ] as const)('never notifies for a %s outcome', async (_name, result) => {
    const inner = innerReturning(result);
    const onPaired = vi.fn();

    const returned = await withPairedNotification(inner, onPaired).submit('CODE');

    expect(returned).toBe(result);
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('propagates an inner rejection unchanged and never notifies (programmer-error path)', async () => {
    const failure = new TypeError('pairing_code must be a string');
    const inner: PairingService = { submit: () => Promise.reject(failure) };
    const onPaired = vi.fn();

    await expect(withPairedNotification(inner, onPaired).submit('CODE')).rejects.toBe(failure);
    expect(onPaired).not.toHaveBeenCalled();
  });

  it('still returns success when the hook throws synchronously', async () => {
    const inner = innerReturning(SUCCESS);
    const wrapped = withPairedNotification(inner, () => {
      throw new Error('starter exploded');
    });
    await expect(wrapped.submit('CODE')).resolves.toBe(SUCCESS);
  });

  it('still returns success when the hook rejects (and leaves no unhandled rejection)', async () => {
    const inner = innerReturning(SUCCESS);
    const wrapped = withPairedNotification(inner, () => Promise.reject(new Error('rejected')));
    await expect(wrapped.submit('CODE')).resolves.toBe(SUCCESS);
    // Let the swallowed rejection settle; vitest fails the run on an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('RT-215 review F2 — hasStarted (did the paired-only workers run in this process?)', () => {
  const TERMINAL = { tenant_id: 't', branch_id: 'b', terminal_id: 'term' };

  it('is false until the first notifyPaired, then true for the rest of the process', () => {
    const latch = createPairedWorkers({ logger: makeLogger() });
    expect(latch.hasStarted()).toBe(false);
    latch.notifyPaired(TERMINAL);
    expect(latch.hasStarted()).toBe(true);
    latch.notifyPaired({ ...TERMINAL, terminal_id: 'term-2' }); // a re-pair: no restart
    expect(latch.hasStarted()).toBe(true);
  });

  it('a notifyPaired after close() starts nothing and reports false', () => {
    const latch = createPairedWorkers({ logger: makeLogger() });
    latch.close();
    latch.notifyPaired(TERMINAL);
    expect(latch.hasStarted()).toBe(false);
  });
});
